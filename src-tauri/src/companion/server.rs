//! The phone connects here: a WebSocket server on the local network, one thread per
//! connection. Decided 2026-11-08: the PC listens on the LAN for now; with the relay
//! later it connects out instead, and only `Server::start` changes.
//!
//! SECURITY: before the handshake only plain JSON for `hello` and `pair.request` is
//! read, capped at 64 KB. After it, every frame is encrypted (crypto.rs); a frame that
//! doesn't decrypt in order closes the connection. Only private network addresses connect.

use std::io::ErrorKind;
use std::net::{IpAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

use super::crypto::{self, KeyPair, SecureChannel};
use super::protocol::{self, ErrorCode, Handshake, PairDetails, PcMessage, PhoneMessage, RejectReason};
use super::Config;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How often an idle connection looks for messages to send.
const POLL: Duration = Duration::from_millis(50);
/// The phone sends `status.get` every 30 s while it is open; silence longer than this ends it.
const IDLE: Duration = Duration::from_secs(75);
const MOST_CONNECTIONS: usize = 16;

pub struct Server {
    pub port: u16,
    stop: Arc<AtomicBool>,
    _announced: Option<super::mdns::Registration>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// SECURITY: only phones on the same local network (and this PC, for tests).
fn local_peer(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback() || first & 0xffc0 == 0xfe80 || first & 0xfe00 == 0xfc00 || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_private())
        }
    }
}

impl Server {
    pub fn start<R: Runtime>(app: AppHandle<R>, key: KeyPair, config: &Config) -> Result<Server, String> {
        let listener = TcpListener::bind(("0.0.0.0", config.port))
            .or_else(|_| TcpListener::bind(("0.0.0.0", 0)))
            .map_err(|e| format!("The phone connection couldn't open a network port: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let key = Arc::new(key);
        let open = Arc::new(AtomicUsize::new(0));
        {
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("nova-companion".into())
                .spawn(move || {
                    while !stop.load(Ordering::SeqCst) {
                        match listener.accept() {
                            Ok((stream, peer)) if local_peer(peer.ip()) && open.load(Ordering::SeqCst) < MOST_CONNECTIONS => {
                                let (app, key, stop, open) = (app.clone(), key.clone(), stop.clone(), open.clone());
                                open.fetch_add(1, Ordering::SeqCst);
                                std::thread::spawn(move || {
                                    let _ = connection(&app, &key, stream, &stop);
                                    open.fetch_sub(1, Ordering::SeqCst);
                                });
                            }
                            Ok(_) => {}
                            Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
                            Err(_) => std::thread::sleep(Duration::from_millis(500)),
                        }
                    }
                })
                .map_err(|e| e.to_string())?;
        }
        let announced = super::mdns::register(&config.pc_id, port, super::mdns_address());
        Ok(Server { port, stop, _announced: announced })
    }
}

type Socket = WebSocket<TcpStream>;

fn waiting(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut))
}

fn send_json(ws: &mut Socket, value: &impl serde::Serialize) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
    ws.send(Message::text(text)).map_err(|e| e.to_string())
}

fn connection<R: Runtime>(app: &AppHandle<R>, key: &KeyPair, stream: TcpStream, stop: &AtomicBool) -> Result<(), String> {
    stream.set_nonblocking(false).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(30))).map_err(|e| e.to_string())?;
    let _ = stream.set_nodelay(true);
    let config = WebSocketConfig::default().max_message_size(Some(protocol::MAX_SMALL_FRAME_BYTES)).max_frame_size(Some(protocol::MAX_SMALL_FRAME_BYTES));
    let mut ws = tungstenite::accept_with_config(stream, Some(config)).map_err(|e| e.to_string())?;
    let Message::Text(text) = ws.read().map_err(|e| e.to_string())? else { return Err("expected a handshake".into()) };
    let value: Value = serde_json::from_str(text.as_str()).map_err(|e| e.to_string())?;
    let result = match Handshake::parse(value)? {
        Handshake::Hello { device_id, eph_pub, nonce, .. } => session(app, key, &mut ws, stop, &device_id, &eph_pub, &nonce),
        Handshake::PairRequest { eph_pub, sealed, .. } => pair(app, key, &mut ws, &eph_pub, &sealed),
        _ => Err("unexpected handshake".into()),
    };
    let _ = ws.close(None);
    let _ = ws.flush();
    result
}

/// SECURITY: the box opens only with the one-time secret from the QR code on this PC's
/// screen, and the device is stored only after the user clicked "Pair" here.
fn pair<R: Runtime>(app: &AppHandle<R>, key: &KeyPair, ws: &mut Socket, eph_pub: &str, sealed: &str) -> Result<(), String> {
    let reject = |ws: &mut Socket, reason: RejectReason| send_json(ws, &Handshake::PairRejected { reason });
    let (Some(eph), Some(sealed)) = (crypto::unb64_32(eph_pub), crypto::unb64(sealed)) else { return reject(ws, RejectReason::Invalid) };
    let mut opened: Option<([u8; 32], Vec<u8>)> = None;
    let taken = super::take_pairing(app, |secret| {
        let Some(box_key) = crypto::pairing_key(key, &eph, secret) else { return false };
        match crypto::open(&box_key, 0, &sealed) {
            Some(plain) => {
                opened = Some((box_key, plain));
                true
            }
            None => false,
        }
    });
    if let Err(reason) = taken {
        return reject(ws, reason);
    }
    let Some((box_key, plain)) = opened else { return reject(ws, RejectReason::Invalid) };
    let Ok(details) = PairDetails::parse(&plain) else { return reject(ws, RejectReason::Invalid) };
    // The phone waits while the user decides on the PC.
    ws.get_mut().set_read_timeout(None).map_err(|e| e.to_string())?;
    if !super::ask_user(app, &details) {
        return reject(ws, RejectReason::Declined);
    }
    let device_id = match super::finish_pairing(app, &details) {
        Ok(id) => id,
        Err(_) => return reject(ws, RejectReason::Busy),
    };
    let reply = json!({ "deviceId": device_id, "pcName": super::pc_name() }).to_string();
    send_json(ws, &Handshake::PairAccepted { sealed: crypto::b64(&crypto::seal(&box_key, 1, reply.as_bytes())) })
}

fn session<R: Runtime>(app: &AppHandle<R>, key: &KeyPair, ws: &mut Socket, stop: &AtomicBool, device_id: &str, eph_pub: &str, nonce: &str) -> Result<(), String> {
    // SECURITY: unknown or revoked devices get no answer at all.
    let (device_pub, _name) = super::device_for_session(app, device_id).ok_or("unknown device")?;
    let device_eph = crypto::unb64_32(eph_pub).ok_or("bad key")?;
    let phone_nonce = crypto::unb64(nonce).ok_or("bad nonce")?;
    let pc_eph = KeyPair::generate();
    let pc_nonce = crypto::random::<16>();
    let keys = crypto::pc_session_keys(key, &pc_eph, &device_pub, &device_eph, &phone_nonce, &pc_nonce, device_id).ok_or("bad key")?;
    send_json(ws, &Handshake::Welcome { v: protocol::VERSION, pc_id: super::config(app).pc_id, eph_pub: crypto::b64(&pc_eph.public), nonce: crypto::b64(&pc_nonce) })?;
    let mut channel = SecureChannel::pc(keys);

    // SECURITY: the first frame has to decrypt, which proves the phone holds its paired key.
    let first = match ws.read().map_err(|e| e.to_string())? {
        Message::Binary(frame) => receive(&mut channel, &frame)?,
        _ => return Err("expected an encrypted frame".into()),
    };
    let first = first.map_err(|why| format!("first message: {why}"))?;
    let (conn_id, outgoing, revoked) = super::conn_handles(app, device_id);
    let result = serve(app, ws, &mut channel, stop, device_id, first, &outgoing, &revoked);
    super::drop_conn(app, conn_id);
    result
}

/// Decrypts a frame. `Err` closes the connection; `Ok(Err)` is a readable but invalid message.
fn receive(channel: &mut SecureChannel, frame: &[u8]) -> Result<Result<PhoneMessage, String>, String> {
    if frame.len() > protocol::MAX_SMALL_FRAME_BYTES {
        return Err("frame too large".into());
    }
    let plain = channel.unframe(frame)?;
    Ok(serde_json::from_slice::<Value>(&plain).map_err(|e| e.to_string()).and_then(PhoneMessage::parse))
}

#[allow(clippy::too_many_arguments)]
fn serve<R: Runtime>(
    app: &AppHandle<R>,
    ws: &mut Socket,
    channel: &mut SecureChannel,
    stop: &AtomicBool,
    device_id: &str,
    first: PhoneMessage,
    outgoing: &std::sync::mpsc::Receiver<PcMessage>,
    revoked: &AtomicBool,
) -> Result<(), String> {
    super::tasks::on_connect(app, device_id);
    super::tasks::handle(app, device_id, first);
    ws.get_mut().set_read_timeout(Some(POLL)).map_err(|e| e.to_string())?;
    let mut heard = Instant::now();
    loop {
        if revoked.load(Ordering::SeqCst) {
            let message = PcMessage::DeviceRevoked { id: protocol::new_id(), ts: protocol::now() };
            let _ = ws.send(Message::binary(channel.frame(&serde_json::to_vec(&message).unwrap_or_default())));
            return Ok(());
        }
        if stop.load(Ordering::SeqCst) || heard.elapsed() > IDLE {
            return Ok(());
        }
        match ws.read() {
            Ok(Message::Binary(frame)) => {
                heard = Instant::now();
                match receive(channel, &frame)? {
                    Ok(message) => super::tasks::handle(app, device_id, message),
                    Err(why) => {
                        let error = PcMessage::Error { id: protocol::new_id(), ts: protocol::now(), code: ErrorCode::Invalid, message: why.chars().take(200).collect(), reply_to: None };
                        ws.send(Message::binary(channel.frame(&serde_json::to_vec(&error).unwrap_or_default()))).map_err(|e| e.to_string())?;
                    }
                }
            }
            Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => heard = Instant::now(),
            Ok(Message::Text(_) | Message::Close(_)) => return Ok(()),
            Err(error) if waiting(&error) => {}
            Err(error) => return Err(error.to_string()),
        }
        for message in outgoing.try_iter() {
            let plain = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
            ws.send(Message::binary(channel.frame(&plain))).map_err(|e| e.to_string())?;
        }
    }
}
