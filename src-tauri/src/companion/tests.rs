//! End to end over real sockets: a phone pairs, connects encrypted, approves with its
//! key, replays a frame, gets revoked. Uses the mock runtime and test credential names.

use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{AppHandle, Manager};
use tungstenite::{Message, WebSocket};

use super::crypto::{self, KeyPair, SecureChannel};
use super::protocol::PcMessage;
use super::*;

type Socket = WebSocket<TcpStream>;

fn app() -> tauri::App<MockRuntime> {
    mock_builder()
        .manage(Database::in_memory_for_tests())
        .manage(CompanionState::default())
        .manage(crate::agent::AgentState::default())
        .manage(crate::assistant::AssistantState::default())
        .build(mock_context(noop_assets()))
        .unwrap()
}

fn connect(port: u16) -> Socket {
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    tungstenite::client(format!("ws://127.0.0.1:{port}/"), stream).unwrap().0
}

fn read_json(ws: &mut Socket) -> Value {
    match ws.read().unwrap() {
        Message::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
        other => panic!("expected text, got {other:?}"),
    }
}

/// Reads until an encrypted message of `kind` arrives (status and others may come first).
fn read_until(ws: &mut Socket, channel: &mut SecureChannel, kind: &str) -> Value {
    loop {
        let Message::Binary(frame) = ws.read().unwrap() else { continue };
        let value: Value = serde_json::from_slice(&channel.unframe(&frame).unwrap()).unwrap();
        serde_json::from_value::<PcMessage>(value.clone()).unwrap_or_else(|e| panic!("PC sent an invalid message {value}: {e}"));
        if value["type"] == kind {
            return value;
        }
    }
}

fn send(ws: &mut Socket, channel: &mut SecureChannel, value: Value) -> Vec<u8> {
    let frame = channel.frame(value.to_string().as_bytes());
    ws.send(Message::binary(frame.clone())).unwrap();
    frame
}

fn closed(ws: &mut Socket) -> bool {
    loop {
        match ws.read() {
            Ok(Message::Close(_)) | Err(_) => return true,
            Ok(Message::Binary(_)) => continue,
            Ok(_) => return false,
        }
    }
}

struct Phone {
    device: KeyPair,
    approval: [u8; 32],
    id: String,
}

fn pair(handle: &AppHandle<MockRuntime>, port: u16, pc_pub: [u8; 32], secret: [u8; 32], accept: bool) -> Result<Phone, Value> {
    let device = KeyPair::generate();
    let eph = KeyPair::generate();
    let approval = crypto::random::<32>();
    let key = crypto::pairing_key(&eph, &pc_pub, &secret).unwrap();
    let details = json!({ "deviceName": "Test phone", "platform": "android", "devicePub": crypto::b64(&device.public), "approvalKey": crypto::b64(&approval) });
    let mut ws = connect(port);
    let sealed = crypto::b64(&crypto::seal(&key, 0, details.to_string().as_bytes()));
    ws.send(Message::text(json!({ "type": "pair.request", "v": 1, "ephPub": crypto::b64(&eph.public), "box": sealed }).to_string())).unwrap();

    // The user clicks on the PC.
    let clicker = handle.clone();
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop = done.clone();
    std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until && !stop.load(std::sync::atomic::Ordering::SeqCst) {
            if let Some(ask) = lock(&state(&clicker).pair_ask).take() {
                let _ = ask.answer.send(accept);
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let reply = read_json(&mut ws);
    done.store(true, std::sync::atomic::Ordering::SeqCst);
    if reply["type"] != "pair.accepted" {
        return Err(reply);
    }
    let opened = crypto::open(&key, 1, &crypto::unb64(reply["box"].as_str().unwrap()).unwrap()).unwrap();
    let id = serde_json::from_slice::<Value>(&opened).unwrap()["deviceId"].as_str().unwrap().to_string();
    Ok(Phone { device, approval, id })
}

fn session(port: u16, pc_pub: [u8; 32], phone: &Phone) -> (Socket, SecureChannel) {
    let mut ws = connect(port);
    let eph = KeyPair::generate();
    let nonce = crypto::random::<16>();
    ws.send(Message::text(json!({ "type": "hello", "v": 1, "deviceId": phone.id, "ephPub": crypto::b64(&eph.public), "nonce": crypto::b64(&nonce) }).to_string())).unwrap();
    let welcome = read_json(&mut ws);
    assert_eq!(welcome["type"], "welcome");
    let pc_eph = crypto::unb64_32(welcome["ephPub"].as_str().unwrap()).unwrap();
    let pc_nonce = crypto::unb64(welcome["nonce"].as_str().unwrap()).unwrap();
    let keys = crypto::phone_session_keys(&phone.device, &eph, &pc_pub, &pc_eph, &nonce, &pc_nonce, &phone.id).unwrap();
    (ws, SecureChannel::phone(keys))
}

fn set_pairing(handle: &AppHandle<MockRuntime>, secret: [u8; 32], valid_for: Duration, used: bool) {
    *lock(&state(handle).pairing) = Some(Pairing { secret, expires: Instant::now() + valid_for, used });
}

#[test]
fn pair_connect_approve_replay_and_revoke() {
    let app = app();
    let handle = app.handle().clone();
    // Without NOVA's plugin the phone connection stays off.
    save_config(&handle, &Config { enabled: true, ..config(&handle) }).unwrap();
    apply(&handle);
    assert!(lock(&state(&handle).server).is_none(), "ran without the plugin");
    let manifest = json!({ "id": "dev.nova.companion", "name": "NOVA Companion", "version": "1.0.0", "description": "Phone", "apiVersion": 1, "minNovaVersion": "1.0.0", "permissions": [{ "type": "companion" }] });
    handle
        .state::<Database>()
        .with(|c| {
            c.execute(
                "INSERT INTO plugins (id, version, manifest, signer, enabled, granted, installed_at, updated_at) VALUES ('dev.nova.companion', '1.0.0', ?1, 'nova', 1, '[\"companion\"]', 0, 0)",
                [manifest.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    apply(&handle);
    let port = lock(&state(&handle).server).as_ref().expect("server running").port;
    let pc_pub = pc_key().unwrap().public;

    // An expired or used QR code doesn't pair.
    let secret = crypto::random::<32>();
    set_pairing(&handle, secret, Duration::ZERO, false);
    assert_eq!(pair(&handle, port, pc_pub, secret, true).err().unwrap()["reason"], "expired");
    set_pairing(&handle, secret, Duration::from_secs(60), true);
    assert_eq!(pair(&handle, port, pc_pub, secret, true).err().unwrap()["reason"], "used");
    // A wrong secret (someone guessing) doesn't either, and doesn't use up the code.
    set_pairing(&handle, secret, Duration::from_secs(60), false);
    assert_eq!(pair(&handle, port, pc_pub, crypto::random::<32>(), true).err().unwrap()["reason"], "invalid");
    // Declined on the PC.
    assert_eq!(pair(&handle, port, pc_pub, secret, false).err().unwrap()["reason"], "declined");
    assert!(devices(&handle).is_empty());

    set_pairing(&handle, secret, Duration::from_secs(60), false);
    let phone = pair(&handle, port, pc_pub, secret, true).expect("paired");
    assert_eq!(devices(&handle).len(), 1);

    // Encrypted session: status comes back.
    let (mut ws, mut channel) = session(port, pc_pub, &phone);
    send(&mut ws, &mut channel, json!({ "type": "status.get", "id": "s1", "ts": 1 }));
    let status = read_until(&mut ws, &mut channel, "status");
    assert_eq!(status["pendingApprovals"], 0);

    // An approval with a wrong proof is refused; the right one goes through.
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let expires_at = protocol::now() + 60_000;
    tasks::test_push_approval("r1", &phone.id, expires_at, sender);
    send(&mut ws, &mut channel, json!({ "type": "approval.answer", "id": "a1", "ts": 1, "requestId": "r1", "approved": true, "proof": crypto::b64(&[0u8; 32]) }));
    assert_eq!(read_until(&mut ws, &mut channel, "error")["code"], "badProof");
    let proof = {
        use hmac::Mac;
        let mut mac = <hmac::Hmac<sha2::Sha256> as Mac>::new_from_slice(&phone.approval).unwrap();
        mac.update(format!("r1|approve|{expires_at}").as_bytes());
        crypto::b64(&mac.finalize().into_bytes())
    };
    send(&mut ws, &mut channel, json!({ "type": "approval.answer", "id": "a2", "ts": 1, "requestId": "r1", "approved": true, "proof": proof }));
    assert_eq!(tauri::async_runtime::block_on(receiver), Ok(true));

    // Too late is too late, even with the right key.
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    tasks::test_push_approval("r2", &phone.id, protocol::now() - 1, sender);
    send(&mut ws, &mut channel, json!({ "type": "approval.answer", "id": "a3", "ts": 1, "requestId": "r2", "approved": true, "proof": crypto::b64(&[0u8; 32]) }));
    assert_eq!(read_until(&mut ws, &mut channel, "error")["code"], "expired");
    // Another device can't answer this phone's request.
    send(&mut ws, &mut channel, json!({ "type": "approval.answer", "id": "a4", "ts": 1, "requestId": "not-mine", "approved": false }));
    assert_eq!(read_until(&mut ws, &mut channel, "error")["code"], "unknownRequest");

    // A replayed frame ends the connection.
    let frame = send(&mut ws, &mut channel, json!({ "type": "status.get", "id": "s2", "ts": 1 }));
    read_until(&mut ws, &mut channel, "status");
    ws.send(Message::binary(frame)).unwrap();
    assert!(closed(&mut ws), "replay accepted");

    // Revoked: the open connection is told and closed, and the device can't come back.
    let (mut ws, mut channel) = session(port, pc_pub, &phone);
    send(&mut ws, &mut channel, json!({ "type": "status.get", "id": "s3", "ts": 1 }));
    read_until(&mut ws, &mut channel, "status");
    tauri::async_runtime::block_on(companion_revoke(handle.clone(), phone.id.clone())).unwrap();
    read_until(&mut ws, &mut channel, "device.revoked");
    assert!(devices(&handle).is_empty());
    assert!(device_approval_key(&phone.id).is_none(), "approval key left behind");
    let mut ws = connect(port);
    let eph = KeyPair::generate();
    ws.send(Message::text(json!({ "type": "hello", "v": 1, "deviceId": phone.id, "ephPub": crypto::b64(&eph.public), "nonce": crypto::b64(&crypto::random::<16>()) }).to_string())).unwrap();
    assert!(closed(&mut ws), "revoked device got a welcome");

    *lock(&state(&handle).server) = None;
    let _ = crate::credentials::delete(KEY_TARGET);
}
