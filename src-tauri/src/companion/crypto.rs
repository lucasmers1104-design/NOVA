//! End-to-end encryption between PC and phone; the same construction as
//! `packages/companion-protocol/src/crypto.ts`, both checked against `fixtures/crypto.json`.
//!
//! SECURITY: X25519 keys, HKDF-SHA256, AES-256-GCM with a counter nonce per direction.
//! The session key mixes static and ephemeral keys (the Noise KK pattern), so a stolen
//! long-term key doesn't open recorded traffic. Change nothing here without the TS side.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::Aes256Gcm;
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(text: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(text).ok()
}

pub fn unb64_32(text: &str) -> Option<[u8; 32]> {
    unb64(text)?.try_into().ok()
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the system's random number generator failed");
    bytes
}

pub struct KeyPair {
    secret: StaticSecret,
    pub public: [u8; 32],
}

impl KeyPair {
    pub fn from_secret(secret: [u8; 32]) -> Self {
        let secret = StaticSecret::from(secret);
        let public = PublicKey::from(&secret).to_bytes();
        Self { secret, public }
    }

    pub fn generate() -> Self {
        Self::from_secret(random())
    }

    pub fn secret_bytes(&self) -> [u8; 32] {
        self.secret.to_bytes()
    }

    /// X25519; `None` for an all-zero result (a low-order key sent by an attacker).
    pub fn dh(&self, public: &[u8; 32]) -> Option<[u8; 32]> {
        let shared = self.secret.diffie_hellman(&PublicKey::from(*public));
        shared.was_contributory().then(|| shared.to_bytes())
    }
}

fn hkdf<const N: usize>(ikm: &[u8], salt: &[u8], info: &[u8]) -> [u8; N] {
    let mut out = [0u8; N];
    Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, &mut out).expect("HKDF output length is valid");
    out
}

fn nonce(counter: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

pub fn seal(key: &[u8; 32], counter: u64, plaintext: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new(key.into());
    cipher.encrypt(&nonce(counter).into(), plaintext).expect("AES-GCM encryption can't fail for these sizes")
}

pub fn open(key: &[u8; 32], counter: u64, ciphertext: &[u8]) -> Option<Vec<u8>> {
    let cipher = Aes256Gcm::new(key.into());
    cipher.decrypt(&nonce(counter).into(), ciphertext).ok()
}

/// The key for the one-time pairing box: only who scanned the QR code knows `secret`.
pub fn pairing_key(pc: &KeyPair, phone_eph_pub: &[u8; 32], secret: &[u8; 32]) -> Option<[u8; 32]> {
    Some(hkdf(&pc.dh(phone_eph_pub)?, secret, b"nova-companion v1 pair"))
}

pub struct SessionKeys {
    /// Phone → PC.
    pub up: [u8; 32],
    /// PC → phone.
    pub down: [u8; 32],
}

/// The PC's side of the session handshake (see `phoneSessionKeys` in TS for the order).
pub fn pc_session_keys(pc: &KeyPair, pc_eph: &KeyPair, device_pub: &[u8; 32], device_eph_pub: &[u8; 32], phone_nonce: &[u8], pc_nonce: &[u8], device_id: &str) -> Option<SessionKeys> {
    let mut ikm = Vec::with_capacity(128);
    ikm.extend(pc.dh(device_pub)?);
    ikm.extend(pc_eph.dh(device_eph_pub)?);
    ikm.extend(pc_eph.dh(device_pub)?);
    ikm.extend(pc.dh(device_eph_pub)?);
    let salt = [phone_nonce, pc_nonce].concat();
    let okm: [u8; 64] = hkdf(&ikm, &salt, format!("nova-companion v1 session {device_id}").as_bytes());
    Some(SessionKeys { up: okm[..32].try_into().unwrap(), down: okm[32..].try_into().unwrap() })
}

/// The phone's side (mirrors `phoneSessionKeys` in TS), for the end-to-end test.
#[cfg(all(test, feature = "companion-e2e"))]
pub fn phone_session_keys(device: &KeyPair, device_eph: &KeyPair, pc_pub: &[u8; 32], pc_eph_pub: &[u8; 32], phone_nonce: &[u8], pc_nonce: &[u8], device_id: &str) -> Option<SessionKeys> {
    let mut ikm = Vec::with_capacity(128);
    ikm.extend(device.dh(pc_pub)?);
    ikm.extend(device_eph.dh(pc_eph_pub)?);
    ikm.extend(device.dh(pc_eph_pub)?);
    ikm.extend(device_eph.dh(pc_pub)?);
    let salt = [phone_nonce, pc_nonce].concat();
    let okm: [u8; 64] = hkdf(&ikm, &salt, format!("nova-companion v1 session {device_id}").as_bytes());
    Some(SessionKeys { up: okm[..32].try_into().unwrap(), down: okm[32..].try_into().unwrap() })
}

/// SECURITY: checks that the biometric-locked approval key on the phone approved
/// exactly this request until exactly this time. Constant-time comparison.
pub fn verify_approval(approval_key: &[u8; 32], request_id: &str, expires_at: u64, proof: &str) -> bool {
    let Some(proof) = unb64(proof) else { return false };
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(approval_key).expect("HMAC takes any key length");
    mac.update(format!("{request_id}|approve|{expires_at}").as_bytes());
    mac.verify_slice(&proof).is_ok()
}

/// One encrypted connection. Frames are an 8-byte big-endian counter followed by the
/// AES-GCM ciphertext; each side's counter starts at 0 and must arrive in order.
pub struct SecureChannel {
    send_key: [u8; 32],
    receive_key: [u8; 32],
    sent: u64,
    received: u64,
}

impl SecureChannel {
    pub fn pc(keys: SessionKeys) -> Self {
        Self { send_key: keys.down, receive_key: keys.up, sent: 0, received: 0 }
    }

    #[cfg(test)]
    pub fn phone(keys: SessionKeys) -> Self {
        Self { send_key: keys.up, receive_key: keys.down, sent: 0, received: 0 }
    }

    pub fn frame(&mut self, plaintext: &[u8]) -> Vec<u8> {
        let counter = self.sent;
        self.sent += 1;
        let mut frame = counter.to_be_bytes().to_vec();
        frame.extend(seal(&self.send_key, counter, plaintext));
        frame
    }

    /// SECURITY: a replayed, reordered or forged frame is refused; the caller closes the connection.
    pub fn unframe(&mut self, frame: &[u8]) -> Result<Vec<u8>, &'static str> {
        if frame.len() < 8 + 16 {
            return Err("frame too short");
        }
        let counter = u64::from_be_bytes(frame[..8].try_into().unwrap());
        if counter != self.received {
            return Err("frame out of order");
        }
        let plaintext = open(&self.receive_key, counter, &frame[8..]).ok_or("frame doesn't decrypt")?;
        self.received += 1;
        Ok(plaintext)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn fixture() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/companion-protocol/fixtures/crypto.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn key(f: &Value, name: &str) -> [u8; 32] {
        unb64_32(f["inputs"][name].as_str().unwrap()).unwrap()
    }

    fn bytes(f: &Value, name: &str) -> Vec<u8> {
        unb64(f["inputs"][name].as_str().unwrap()).unwrap()
    }

    fn expected(f: &Value, name: &str) -> String {
        f["expected"][name].as_str().unwrap().to_string()
    }

    #[test]
    fn rfc7748_vector() {
        let scalar: [u8; 32] = hex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4");
        let u: [u8; 32] = hex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c");
        assert_eq!(KeyPair::from_secret(scalar).dh(&u).unwrap(), hex::<32>("c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"));
    }

    fn hex<const N: usize>(text: &str) -> [u8; N] {
        let mut out = [0u8; N];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn derives_the_same_keys_as_the_phone() {
        let f = fixture();
        let pc = KeyPair::from_secret(key(&f, "pcStatic"));
        let pc_eph = KeyPair::from_secret(key(&f, "pcEph"));
        let device = KeyPair::from_secret(key(&f, "deviceStatic"));
        let device_eph = KeyPair::from_secret(key(&f, "deviceEph"));
        assert_eq!(b64(&device.public), expected(&f, "devicePub"));
        assert_eq!(b64(&pc.public), expected(&f, "pcPub"));
        assert_eq!(b64(&pairing_key(&pc, &device_eph.public, &key(&f, "pairingSecret")).unwrap()), expected(&f, "pairingKey"));
        let keys = pc_session_keys(&pc, &pc_eph, &device.public, &device_eph.public, &bytes(&f, "phoneNonce"), &bytes(&f, "pcNonce"), f["deviceId"].as_str().unwrap()).unwrap();
        assert_eq!(b64(&keys.up), expected(&f, "up"));
        assert_eq!(b64(&keys.down), expected(&f, "down"));
    }

    #[test]
    fn frames_like_the_phone_and_refuses_replays_and_forgeries() {
        let f = fixture();
        let up = unb64_32(&expected(&f, "up")).unwrap();
        let down = unb64_32(&expected(&f, "down")).unwrap();
        let plaintext = f["plaintext"].as_str().unwrap().as_bytes();
        let mut pc = SecureChannel::pc(SessionKeys { up, down });
        let mut phone = SecureChannel::phone(SessionKeys { up, down });
        let frame = unb64(&expected(&f, "upFrame0")).unwrap();
        assert_eq!(phone.frame(plaintext), frame);
        assert_eq!(pc.unframe(&frame).unwrap(), plaintext);
        assert!(pc.unframe(&frame).is_err(), "replay accepted");

        pc.frame(b"first");
        assert_eq!(b64(&pc.frame(plaintext)), expected(&f, "downFrame1"));

        let mut forged = phone.frame(b"second");
        *forged.last_mut().unwrap() ^= 1;
        assert!(pc.unframe(&forged).is_err(), "forgery accepted");
    }

    #[test]
    fn checks_the_pairing_box_and_the_approval_proof() {
        let f = fixture();
        let key = unb64_32(&expected(&f, "pairingKey")).unwrap();
        let sealed = unb64(&expected(&f, "pairingBox")).unwrap();
        assert_eq!(open(&key, 0, &sealed).unwrap(), f["plaintext"].as_str().unwrap().as_bytes());
        assert!(open(&key, 1, &sealed).is_none());

        let approval = super::tests::key(&f, "approvalKey");
        let expires = f["expiresAt"].as_u64().unwrap();
        let proof = expected(&f, "approvalProof");
        assert!(verify_approval(&approval, "r-1", expires, &proof));
        assert!(!verify_approval(&approval, "r-2", expires, &proof));
        assert!(!verify_approval(&approval, "r-1", expires + 1, &proof));
        assert!(!verify_approval(&[0u8; 32], "r-1", expires, &proof));
        assert!(!verify_approval(&approval, "r-1", expires, "not base64!"));
    }

    #[test]
    fn refuses_an_all_zero_public_key() {
        assert!(KeyPair::generate().dh(&[0u8; 32]).is_none());
    }
}
