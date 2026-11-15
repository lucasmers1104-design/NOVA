//! What NOVA and its speech process say to each other over the process's
//! stdin and stdout: one frame per message,
//!
//! ```text
//! head length (u32 LE) | blob length (u32 LE) | head (JSON) | blob (raw bytes)
//! ```
//!
//! The head names the call and carries its small values; audio travels in the
//! blob as raw 32-bit floats, so a phrase is never turned into text and back.

use std::io::{self, Read, Write};
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::speech::catalog::Engine;
use crate::speech::runtime::Device;

/// A head is a call's name and a sentence at most; more means the stream is out of step.
pub const MAX_HEAD: usize = 1 << 20;
/// Minutes of audio. Lengths beyond it are refused before anything is allocated.
pub const MAX_BLOB: usize = 64 << 20;

/// A voice and where it runs: all the speech process needs to load it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSpec {
    pub item: String,
    pub engine: Engine,
    /// The folder with onnxruntime.dll and DirectML.dll.
    pub runtime: PathBuf,
    pub model: PathBuf,
    pub config: PathBuf,
    pub espeak: PathBuf,
    pub speaker: Option<String>,
    pub device: Device,
}

/// The offline recognizer (Parakeet and Silero VAD in `dir`) and where it runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizerSpec {
    pub runtime: PathBuf,
    pub dir: PathBuf,
    pub device: Device,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    /// Answers after `wait_ms`, as a busy model would.
    Ping { wait_ms: u64 },
    /// Ends the process at once, as a crashing graphics driver would. Never answered.
    Abort,
    /// Loads the voice (unless it is the one in memory).
    OpenVoice { voice: VoiceSpec },
    /// Speaks `text`; loads the voice first if another one, or none, is in memory.
    Speak { voice: VoiceSpec, text: String, rate: f32 },
    OpenRecognizer { recognizer: RecognizerSpec },
    /// The blob is the phrase, 16 kHz mono.
    Transcribe,
    /// The blob is one VAD frame, 16 kHz mono.
    Vad,
    VadReset,
    /// Answers, then exits.
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Reply {
    Done,
    /// The model is in memory; `directml` is where DirectML.dll was loaded from.
    Opened { directml: Option<String> },
    /// The blob is the speech, mono at `rate`.
    Audio { rate: u32 },
    Text { text: String },
    Probability { value: f32 },
    /// It couldn't be done; `runtime` when the speech runtime itself didn't load.
    Failed { message: String, runtime: bool },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub id: u64,
    pub request: Request,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Answer {
    pub id: u64,
    pub reply: Reply,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

/// Writes one frame and flushes it: the other side is waiting for exactly this.
pub fn write_frame(out: &mut impl Write, head: &[u8], blob: &[u8]) -> io::Result<()> {
    if head.len() > MAX_HEAD || blob.len() > MAX_BLOB {
        return Err(invalid("frame too large"));
    }
    let mut lengths = [0u8; 8];
    lengths[..4].copy_from_slice(&(head.len() as u32).to_le_bytes());
    lengths[4..].copy_from_slice(&(blob.len() as u32).to_le_bytes());
    out.write_all(&lengths)?;
    out.write_all(head)?;
    out.write_all(blob)?;
    out.flush()
}

/// Reads one frame. `None` when the stream ended between frames (the other
/// side closed it); an end in the middle of a frame is an error.
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let mut lengths = [0u8; 8];
    let mut filled = 0;
    while filled < lengths.len() {
        match input.read(&mut lengths[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let head_len = u32::from_le_bytes([lengths[0], lengths[1], lengths[2], lengths[3]]) as usize;
    let blob_len = u32::from_le_bytes([lengths[4], lengths[5], lengths[6], lengths[7]]) as usize;
    if head_len > MAX_HEAD || blob_len > MAX_BLOB {
        return Err(invalid("frame too large"));
    }
    let mut head = vec![0u8; head_len];
    input.read_exact(&mut head)?;
    let mut blob = vec![0u8; blob_len];
    input.read_exact(&mut blob)?;
    Ok(Some((head, blob)))
}

pub fn send<T: Serialize>(out: &mut impl Write, message: &T, blob: &[u8]) -> io::Result<()> {
    let head = serde_json::to_vec(message).map_err(|e| invalid(e.to_string()))?;
    write_frame(out, &head, blob)
}

pub fn receive<T: DeserializeOwned>(input: &mut impl Read) -> io::Result<Option<(T, Vec<u8>)>> {
    let Some((head, blob)) = read_frame(input)? else { return Ok(None) };
    let message = serde_json::from_slice(&head).map_err(|e| invalid(e.to_string()))?;
    Ok(Some((message, blob)))
}

pub fn samples_to_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

pub fn bytes_to_samples(bytes: &[u8]) -> Result<Vec<f32>, String> {
    let (samples, rest) = bytes.as_chunks::<4>();
    if !rest.is_empty() {
        return Err("Audio isn't whole 32-bit samples".into());
    }
    Ok(samples.iter().map(|sample| f32::from_le_bytes(*sample)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(head: &[u8], blob: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        write_frame(&mut out, head, blob).unwrap();
        out
    }

    /// Hands out one byte per read, as a pipe may.
    struct Trickle<'a>(&'a [u8]);

    impl Read for Trickle<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let Some((first, rest)) = self.0.split_first() else { return Ok(0) };
            buffer[0] = *first;
            self.0 = rest;
            Ok(1)
        }
    }

    #[test]
    fn frames_carry_a_head_and_a_blob() {
        let bytes = frame(b"{\"a\":1}", &[1, 2, 3]);
        assert_eq!(&bytes[..8], &[7, 0, 0, 0, 3, 0, 0, 0]);
        let mut input = bytes.as_slice();
        assert_eq!(read_frame(&mut input).unwrap(), Some((b"{\"a\":1}".to_vec(), vec![1, 2, 3])));
        assert_eq!(read_frame(&mut input).unwrap(), None, "the stream ended between frames");
    }

    #[test]
    fn frames_follow_each_other_however_the_pipe_cuts_them() {
        let mut bytes = frame(b"one", b"");
        bytes.extend(frame(b"", &[9; 5000]));
        bytes.extend(frame(b"three", b"3"));
        let mut input = Trickle(&bytes);
        assert_eq!(read_frame(&mut input).unwrap(), Some((b"one".to_vec(), Vec::new())));
        assert_eq!(read_frame(&mut input).unwrap(), Some((Vec::new(), vec![9; 5000])));
        assert_eq!(read_frame(&mut input).unwrap(), Some((b"three".to_vec(), b"3".to_vec())));
        assert_eq!(read_frame(&mut input).unwrap(), None);
    }

    #[test]
    fn a_frame_cut_short_is_an_error_not_an_end() {
        let bytes = frame(b"head", &[1, 2, 3, 4]);
        for cut in 1..bytes.len() {
            let error = read_frame(&mut &bytes[..cut]).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof, "cut at {cut}");
        }
    }

    #[test]
    fn oversized_lengths_are_refused_before_allocating() {
        let mut lengths = Vec::new();
        lengths.extend_from_slice(&(MAX_HEAD as u32 + 1).to_le_bytes());
        lengths.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(read_frame(&mut lengths.as_slice()).unwrap_err().kind(), io::ErrorKind::InvalidData);
        let mut lengths = Vec::new();
        lengths.extend_from_slice(&2u32.to_le_bytes());
        lengths.extend_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(read_frame(&mut lengths.as_slice()).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert!(write_frame(&mut Vec::new(), &vec![0; MAX_HEAD + 1], b"").is_err());
    }

    #[test]
    fn calls_and_answers_survive_the_trip() {
        let voice = VoiceSpec {
            item: "thorsten".into(),
            engine: Engine::Piper,
            runtime: PathBuf::from(r"C:\speech\runtime"),
            model: PathBuf::from(r"C:\voice\thorsten.onnx"),
            config: PathBuf::from(r"C:\voice\thorsten.onnx.json"),
            espeak: PathBuf::from(r"C:\voice\piper"),
            speaker: None,
            device: Device::DirectMl { adapter: 1, name: "GPU".into() },
        };
        let call = Call { id: 7, request: Request::Speak { voice, text: "Grüß dich — „Hallo“".into(), rate: 1.25 } };
        let audio = samples_to_bytes(&[0.0, -1.0, 0.5, f32::MIN_POSITIVE]);
        let mut pipe = Vec::new();
        send(&mut pipe, &call, &audio).unwrap();
        send(&mut pipe, &Answer { id: 7, reply: Reply::Failed { message: "no".into(), runtime: true } }, b"").unwrap();
        let mut input = pipe.as_slice();
        let (back, blob) = receive::<Call>(&mut input).unwrap().unwrap();
        assert_eq!(back, call);
        assert_eq!(bytes_to_samples(&blob).unwrap(), vec![0.0, -1.0, 0.5, f32::MIN_POSITIVE]);
        let (answer, blob) = receive::<Answer>(&mut input).unwrap().unwrap();
        assert_eq!(answer.reply, Reply::Failed { message: "no".into(), runtime: true });
        assert!(blob.is_empty());
        // The head is plain JSON with the call's name in it.
        let head = serde_json::to_value(Call { id: 1, request: Request::Ping { wait_ms: 5 } }).unwrap();
        assert_eq!(head, serde_json::json!({ "id": 1, "request": { "op": "ping", "waitMs": 5 } }));
    }

    #[test]
    fn a_head_that_is_not_a_message_is_an_error() {
        let bytes = frame(b"{\"id\":1,\"request\":{\"op\":\"dance\"}}", b"");
        assert_eq!(receive::<Call>(&mut bytes.as_slice()).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert!(bytes_to_samples(&[0, 0, 0]).is_err());
        assert_eq!(bytes_to_samples(&[]).unwrap(), Vec::<f32>::new());
    }
}
