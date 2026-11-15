//! NOVA's speech runs in processes of its own: `nova.exe --speech-helper`.
//!
//! ONNX Runtime and DirectML keep hundreds of megabytes once they have run a
//! model, also after the model is unloaded. Inside NOVA that memory stayed
//! for as long as NOVA ran; a process that ends gives all of it back to
//! Windows. So the voices (Piper, Kokoro, with the phonemizer they start) and
//! the recognizer (Parakeet, Silero VAD) each live in a helper process that
//! starts with the first call and ends when its idle time is over.
//!
//! `wire` is what goes over the pipe, `server` the helper process, `client`
//! NOVA's side of it.

pub mod client;
pub mod server;
pub mod wire;

pub use client::{CallError, Helper, RuntimeSeen, Session, FLAG};
pub use wire::{RecognizerSpec, VoiceSpec};
