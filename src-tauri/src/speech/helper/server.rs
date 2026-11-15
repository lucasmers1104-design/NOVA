//! The speech process itself: `nova.exe --speech-helper <role>`. It reads
//! calls from stdin, runs them on the models it holds and writes the answers
//! to stdout. It never opens a window, a database or the network.
//!
//! Three lanes work side by side, because NOVA does: the microphone's VAD
//! frames must not wait for a phrase that is being transcribed, and neither
//! for a sentence that is being spoken.

use std::io::Write;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use super::wire::{self, Answer, Call, RecognizerSpec, Reply, Request, VoiceSpec};
use crate::speech::catalog::Engine;
use crate::speech::runtime::{self, Runtime};
use crate::speech::stt::parakeet::Parakeet;
use crate::speech::stt::vad::Vad;
use crate::speech::{kokoro, phonemize, piper, TtsEngine};

/// Why a call couldn't be done.
struct Failure {
    message: String,
    /// The speech runtime itself didn't load (Settings says so).
    runtime: bool,
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self { message, runtime: false }
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Self { message: message.into(), runtime: false }
    }
}

#[derive(Default)]
struct Engines {
    voice: Mutex<Option<(VoiceSpec, Box<dyn TtsEngine>)>>,
    asr: Mutex<Option<(RecognizerSpec, Parakeet)>>,
    vad: Mutex<Option<Vad>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn load_runtime(dir: &std::path::Path) -> Result<&'static Runtime, Failure> {
    runtime::get(dir).map_err(|message| Failure { message, runtime: true })
}

fn open_voice(spec: &VoiceSpec) -> Result<Box<dyn TtsEngine>, Failure> {
    let runtime = load_runtime(&spec.runtime)?;
    Ok(match spec.engine {
        Engine::Piper => Box::new(piper::Piper::open(runtime, &spec.model, &spec.config, &spec.device, spec.speaker.as_deref(), &spec.espeak)?),
        Engine::Kokoro => Box::new(kokoro::Kokoro::open(runtime, &spec.model, &spec.config, &spec.device, &spec.espeak)?),
        Engine::Parakeet | Engine::Onnx => return Err("Not a voice".into()),
    })
}

/// The voice for `spec`, loaded unless it is the one in memory.
fn voice<'a>(slot: &'a mut Option<(VoiceSpec, Box<dyn TtsEngine>)>, spec: &VoiceSpec) -> Result<&'a mut (dyn TtsEngine + 'static), Failure> {
    if slot.as_ref().is_none_or(|(loaded, _)| loaded != spec) {
        // The old voice goes first: two of them needn't be in memory at once.
        *slot = None;
        *slot = Some((spec.clone(), open_voice(spec)?));
    }
    Ok(slot.as_mut().ok_or("No voice")?.1.as_mut())
}

/// Loads the recognizer for `spec`, unless it is the one in memory (a turn
/// that couldn't wait for "Hey NOVA" to let go asks for the same one again).
fn open_recognizer(engines: &Engines, spec: &RecognizerSpec) -> Result<(), Failure> {
    let runtime = load_runtime(&spec.runtime)?;
    let mut asr = lock(&engines.asr);
    let mut vad = lock(&engines.vad);
    if vad.is_some() && asr.as_ref().is_some_and(|(loaded, _)| loaded == spec) {
        return Ok(());
    }
    (*asr, *vad) = (None, None);
    *asr = Some((spec.clone(), Parakeet::open(runtime, &spec.dir, &spec.device)?));
    *vad = Some(Vad::open(runtime, &spec.dir.join("silero_vad.onnx"))?);
    Ok(())
}

fn opened() -> Reply {
    Reply::Opened { directml: runtime::loaded().and_then(|r| r.directml.clone()) }
}

const NOT_LOADED: &str = "The offline recognizer isn't loaded";

fn serve(engines: &Engines, request: Request, blob: &[u8]) -> Result<(Reply, Vec<u8>), Failure> {
    let plain = |reply| Ok((reply, Vec::new()));
    match request {
        Request::Ping { wait_ms } => {
            std::thread::sleep(Duration::from_millis(wait_ms));
            plain(Reply::Done)
        }
        Request::OpenVoice { voice: spec } => {
            voice(&mut lock(&engines.voice), &spec)?;
            plain(opened())
        }
        Request::Speak { voice: spec, text, rate } => {
            let mut slot = lock(&engines.voice);
            let spoken = voice(&mut slot, &spec)?.synthesize(&text, rate);
            let pcm = spoken.inspect_err(|_| *slot = None)?;
            Ok((Reply::Audio { rate: pcm.rate }, wire::samples_to_bytes(&pcm.samples)))
        }
        Request::OpenRecognizer { recognizer } => {
            open_recognizer(engines, &recognizer)?;
            plain(opened())
        }
        Request::Transcribe => {
            let audio = wire::bytes_to_samples(blob)?;
            let text = lock(&engines.asr).as_mut().ok_or(NOT_LOADED)?.1.transcribe(&audio)?;
            plain(Reply::Text { text })
        }
        Request::Vad => {
            let frame = wire::bytes_to_samples(blob)?;
            let value = lock(&engines.vad).as_mut().ok_or(NOT_LOADED)?.probability(&frame)?;
            plain(Reply::Probability { value })
        }
        Request::VadReset => {
            if let Some(vad) = lock(&engines.vad).as_mut() {
                vad.reset();
            }
            plain(Reply::Done)
        }
        // Handled where the calls are read: they end the process.
        Request::Abort | Request::Shutdown => plain(Reply::Done),
    }
}

#[derive(Clone, Copy)]
enum Lane {
    Voice,
    Recognizer,
    Vad,
}

fn lane(request: &Request) -> Lane {
    match request {
        Request::Transcribe | Request::OpenRecognizer { .. } => Lane::Recognizer,
        Request::Vad | Request::VadReset => Lane::Vad,
        _ => Lane::Voice,
    }
}

type Output = Arc<Mutex<std::io::Stdout>>;

fn answer(out: &Output, id: u64, reply: Reply, blob: &[u8]) {
    // A failed write means NOVA is gone; reading stdin notices that and ends the process.
    let mut out = lock(out);
    let _ = wire::send(&mut *out, &Answer { id, reply }, blob).and_then(|()| out.flush());
}

fn work(engines: Arc<Engines>, out: Output, calls: Receiver<(Call, Vec<u8>)>) {
    for (call, blob) in calls {
        // In debug builds a panic in a model's code becomes an answer; release builds abort
        // on panic, which NOVA sees as the process ending. Neither takes NOVA down.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| serve(&engines, call.request, &blob)));
        match outcome {
            Ok(Ok((reply, blob))) => answer(&out, call.id, reply, &blob),
            Ok(Err(failure)) => answer(&out, call.id, Reply::Failed { message: failure.message, runtime: failure.runtime }, &[]),
            Err(_) => answer(&out, call.id, Reply::Failed { message: "NOVA's speech process ran into a problem".into(), runtime: false }, &[]),
        }
    }
}

/// Runs until NOVA says so or goes away. Returns the exit code.
pub fn run() -> i32 {
    #[cfg(windows)]
    {
        use windows::Win32::System::Diagnostics::Debug::{SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX};
        // SAFETY: changes how this process reports errors, nothing else. A crash must not
        // leave a dialog on the user's screen: NOVA reports it and starts a new process.
        unsafe { SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX) };
    }
    let engines = Arc::new(Engines::default());
    let out: Output = Arc::new(Mutex::new(std::io::stdout()));
    let start = |name: &str| -> Sender<(Call, Vec<u8>)> {
        let (sender, calls) = channel();
        let (engines, out) = (engines.clone(), out.clone());
        let _ = std::thread::Builder::new().name(name.into()).spawn(move || work(engines, out, calls));
        sender
    };
    let (voice, recognizer, vad) = (start("voice"), start("recognizer"), start("vad"));
    let mut input = std::io::stdin().lock();
    let code = loop {
        match wire::receive::<Call>(&mut input) {
            Ok(Some((call, blob))) => match call.request {
                // No answer and no goodbye to anyone, as when a driver takes the process down.
                Request::Abort => std::process::exit(70),
                Request::Shutdown => {
                    answer(&out, call.id, Reply::Done, &[]);
                    break 0;
                }
                _ => {
                    let sender = match lane(&call.request) {
                        Lane::Voice => &voice,
                        Lane::Recognizer => &recognizer,
                        Lane::Vad => &vad,
                    };
                    if sender.send((call, blob)).is_err() {
                        break 1;
                    }
                }
            },
            // NOVA closed the pipe (it quit, or crashed): nothing is left to speak for.
            Ok(None) => break 0,
            Err(_) => break 2,
        }
    };
    // Its own helper (eSpeak NG) would otherwise wait for a parent that is gone.
    phonemize::stop();
    code
}
