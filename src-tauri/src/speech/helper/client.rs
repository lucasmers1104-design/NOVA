//! NOVA's side of a speech process: starts it when the first call needs it,
//! pairs answers with calls (several threads call at once), and notices when
//! it is gone. A process that crashed or hung never takes NOVA with it: the
//! call in flight gets an error, and the next call starts a new process.

use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::wire::{self, Answer, Call, RecognizerSpec, Reply, Request, VoiceSpec};
use crate::speech::wav::Pcm;

/// The flag that makes nova.exe a speech process instead of the app.
pub const FLAG: &str = "--speech-helper";

/// Loading a model: reading hundreds of megabytes from a slow disk, and on a
/// graphics card compiling it, takes a while on a small PC.
const OPEN_LIMIT: Duration = Duration::from_secs(180);
const TRANSCRIBE_LIMIT: Duration = Duration::from_secs(120);
/// A frame takes a fraction of a millisecond; this long means it hangs.
const VAD_LIMIT: Duration = Duration::from_secs(10);
/// How long a process asked to exit gets before it is ended.
const EXIT_GRACE: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// The process answered that it couldn't do it.
    Failed { message: String, runtime: bool },
    /// The process is gone: it crashed, hung and was stopped, or couldn't start.
    Gone(String),
}

impl CallError {
    pub fn gone(&self) -> bool {
        matches!(self, CallError::Gone(_))
    }

    pub fn message(&self) -> &str {
        match self {
            CallError::Failed { message, .. } | CallError::Gone(message) => message,
        }
    }
}

impl From<CallError> for String {
    fn from(error: CallError) -> Self {
        match error {
            CallError::Failed { message, .. } | CallError::Gone(message) => message,
        }
    }
}

type Outcome = Result<(Reply, Vec<u8>), CallError>;

/// The calls waiting for their answers.
struct Waiting {
    /// `None` once the process's output ended: nothing can be answered any more.
    calls: Mutex<Option<HashMap<u64, Sender<Outcome>>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

const ENDED: &str = "NOVA's speech process ended unexpectedly";

impl Waiting {
    fn open() -> Self {
        Self { calls: Mutex::new(Some(HashMap::new())) }
    }

    fn add(&self, id: u64, sender: Sender<Outcome>) -> bool {
        lock(&self.calls).as_mut().map(|calls| calls.insert(id, sender)).is_some()
    }

    fn take(&self, id: u64) -> Option<Sender<Outcome>> {
        lock(&self.calls).as_mut().and_then(|calls| calls.remove(&id))
    }

    fn closed(&self) -> bool {
        lock(&self.calls).is_none()
    }

    /// The process is gone: every waiting call learns it now, none can be added.
    fn close(&self) {
        for (_, sender) in lock(&self.calls).take().into_iter().flatten() {
            let _ = sender.send(Err(CallError::Gone(ENDED.into())));
        }
    }
}

struct Process {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    waiting: Arc<Waiting>,
    generation: u64,
}

impl Process {
    fn alive(&mut self) -> bool {
        !self.waiting.closed() && matches!(self.child.try_wait(), Ok(None))
    }

    /// Ends it now. Its own helper (eSpeak NG) ends with it: that one's pipe closes.
    fn end(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.waiting.close();
    }
}

/// What the process told about the speech runtime it loaded.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RuntimeSeen {
    /// Where DirectML.dll was loaded from.
    pub directml: Option<String>,
}

/// One speech process (NOVA keeps one for its voice and one for recognition,
/// so each can end when its own idle time is over).
pub struct Helper {
    role: &'static str,
    /// The program to start; NOVA's own exe unless a test says otherwise.
    program: Option<PathBuf>,
    process: Mutex<Option<Process>>,
    next_id: AtomicU64,
    generations: AtomicU64,
    in_flight: AtomicUsize,
    /// Recognizer sessions handed out and not dropped yet.
    leases: AtomicUsize,
    runtime: Mutex<Option<RuntimeSeen>>,
    runtime_error: Mutex<Option<String>>,
    /// The generation of the last process that went away without being asked to.
    crashed: AtomicU64,
}

/// Counts a call as in flight for as long as it lives.
struct Flight<'a>(&'a AtomicUsize);

impl<'a> Flight<'a> {
    fn begin(counter: &'a AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Helper {
    pub fn new(role: &'static str) -> Self {
        Self::starting(role, None)
    }

    /// Like `new`, but starts `program` (tests start the nova.exe they built).
    pub fn with_program(role: &'static str, program: PathBuf) -> Self {
        Self::starting(role, Some(program))
    }

    fn starting(role: &'static str, program: Option<PathBuf>) -> Self {
        Self {
            role,
            program,
            process: Mutex::new(None),
            next_id: AtomicU64::new(1),
            generations: AtomicU64::new(0),
            in_flight: AtomicUsize::new(0),
            leases: AtomicUsize::new(0),
            runtime: Mutex::new(None),
            runtime_error: Mutex::new(None),
            crashed: AtomicU64::new(0),
        }
    }

    fn start(&self) -> Result<Process, CallError> {
        let gone = |what: String| CallError::Gone(format!("NOVA's speech process couldn't start: {what}"));
        let program = match &self.program {
            Some(program) => program.clone(),
            None => std::env::current_exe().map_err(|e| gone(e.to_string()))?,
        };
        let mut command = Command::new(program);
        command.arg(FLAG).arg(self.role).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|e| gone(e.to_string()))?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(gone("it has no pipes".into()));
        };
        let waiting = Arc::new(Waiting::open());
        let answers = waiting.clone();
        std::thread::spawn(move || {
            let mut output = BufReader::new(stdout);
            while let Ok(Some((answer, blob))) = wire::receive::<Answer>(&mut output) {
                if let Some(sender) = answers.take(answer.id) {
                    let _ = sender.send(Ok((answer.reply, blob)));
                }
            }
            answers.close();
        });
        Ok(Process { child, stdin: Arc::new(Mutex::new(stdin)), waiting, generation: self.generations.fetch_add(1, Ordering::SeqCst) + 1 })
    }

    /// Forgets a process that is no longer there.
    fn reap(&self, slot: &mut Option<Process>) {
        if slot.as_mut().is_some_and(|process| !process.alive()) {
            self.bury(slot.take());
        }
    }

    /// Ends a process that failed (it crashed, hung, or its pipe broke) and remembers that it did.
    fn bury(&self, process: Option<Process>) {
        let Some(process) = process else { return };
        self.crashed.store(process.generation, Ordering::SeqCst);
        process.end();
        *lock(&self.runtime) = None;
    }

    /// Ends the process of `generation` (it hung, or its pipe broke), unless a newer one took its place.
    fn discard(&self, generation: u64) {
        let mut slot = lock(&self.process);
        if slot.as_ref().is_some_and(|process| process.generation == generation) {
            self.bury(slot.take());
        }
    }

    /// One call and its answer. `within`: only in the process of that
    /// generation (a recognizer lives in one process; a new process doesn't
    /// have it), otherwise a process is started if none runs.
    fn call(&self, request: Request, blob: &[u8], limit: Duration, within: Option<u64>) -> Outcome {
        let _flight = Flight::begin(&self.in_flight);
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, answer) = channel();
        let (stdin, waiting, generation) = {
            let mut slot = lock(&self.process);
            self.reap(&mut slot);
            if let Some(generation) = within {
                if slot.as_ref().is_none_or(|process| process.generation != generation) {
                    return Err(CallError::Gone("The offline recognizer was unloaded".into()));
                }
            } else if slot.is_none() {
                *slot = Some(self.start()?);
            }
            let Some(process) = slot.as_ref() else { return Err(CallError::Gone(ENDED.into())) };
            if !process.waiting.add(id, sender) {
                return Err(CallError::Gone(ENDED.into()));
            }
            (process.stdin.clone(), process.waiting.clone(), process.generation)
        };
        let written = {
            let mut stdin = lock(&stdin);
            wire::send(&mut *stdin, &Call { id, request }, blob).and_then(|()| stdin.flush())
        };
        if written.is_err() {
            waiting.take(id);
            self.discard(generation);
            return Err(CallError::Gone(ENDED.into()));
        }
        match answer.recv_timeout(limit) {
            Ok(Ok((Reply::Failed { message, runtime }, _))) => {
                if runtime {
                    *lock(&self.runtime_error) = Some(message.clone());
                }
                Err(CallError::Failed { message, runtime })
            }
            Ok(outcome) => outcome,
            Err(RecvTimeoutError::Timeout) => {
                waiting.take(id);
                self.discard(generation);
                Err(CallError::Gone("NOVA's speech process didn't answer and was stopped".into()))
            }
            Err(RecvTimeoutError::Disconnected) => Err(CallError::Gone(ENDED.into())),
        }
    }

    fn unexpected(reply: Reply) -> CallError {
        CallError::Failed { message: format!("NOVA's speech process gave an answer that doesn't fit ({reply:?})"), runtime: false }
    }

    fn note_opened(&self, reply: Reply) -> Result<(), CallError> {
        match reply {
            Reply::Opened { directml } => {
                *lock(&self.runtime) = Some(RuntimeSeen { directml });
                *lock(&self.runtime_error) = None;
                Ok(())
            }
            other => Err(Self::unexpected(other)),
        }
    }

    /// Answers after `wait` (starting the process if none runs), or fails after `limit`.
    pub fn ping(&self, wait: Duration, limit: Duration) -> Result<(), CallError> {
        self.call(Request::Ping { wait_ms: wait.as_millis() as u64 }, &[], limit, None).map(|_| ())
    }

    /// Makes the process end at once without an answer, as a crashing graphics driver would.
    pub fn crash(&self) {
        let _ = self.call(Request::Abort, &[], Duration::from_secs(10), None);
    }

    pub fn open_voice(&self, voice: &VoiceSpec) -> Result<(), CallError> {
        let (reply, _) = self.call(Request::OpenVoice { voice: voice.clone() }, &[], OPEN_LIMIT, None)?;
        self.note_opened(reply)
    }

    pub fn speak(&self, voice: &VoiceSpec, text: &str, rate: f32) -> Result<Pcm, CallError> {
        // Loading included (a new process has no voice yet), and long texts on a slow processor.
        let limit = OPEN_LIMIT + Duration::from_millis(250) * text.chars().count() as u32;
        match self.call(Request::Speak { voice: voice.clone(), text: text.into(), rate }, &[], limit, None)? {
            (Reply::Audio { rate }, blob) => {
                let samples = wire::bytes_to_samples(&blob).map_err(|message| CallError::Failed { message, runtime: false })?;
                Ok(Pcm { rate, samples })
            }
            (other, _) => Err(Self::unexpected(other)),
        }
    }

    /// Loads the recognizer; the session is the handle to it for as long as this process lives.
    pub fn open_recognizer(self: &Arc<Self>, recognizer: &RecognizerSpec) -> Result<Session, CallError> {
        // Counted before the call ends, so an idle check in between doesn't see an unused process.
        let _flight = Flight::begin(&self.in_flight);
        let (reply, _) = self.call(Request::OpenRecognizer { recognizer: recognizer.clone() }, &[], OPEN_LIMIT, None)?;
        self.note_opened(reply)?;
        let generation = lock(&self.process).as_ref().map(|process| process.generation).ok_or_else(|| CallError::Gone(ENDED.into()))?;
        self.leases.fetch_add(1, Ordering::SeqCst);
        Ok(Session { helper: self.clone(), generation })
    }

    /// Whether a process runs right now.
    pub fn running(&self) -> bool {
        lock(&self.process).as_mut().is_some_and(Process::alive)
    }

    pub fn pid(&self) -> Option<u32> {
        let mut slot = lock(&self.process);
        let process = slot.as_mut()?;
        process.alive().then(|| process.child.id())
    }

    /// A process runs that nothing uses: no call in flight, no recognizer handed out.
    pub fn unused(&self) -> bool {
        self.in_flight.load(Ordering::SeqCst) == 0 && self.leases.load(Ordering::SeqCst) == 0 && self.running()
    }

    /// The runtime the running process loaded, if it has.
    pub fn runtime(&self) -> Option<RuntimeSeen> {
        if !self.running() {
            return None;
        }
        lock(&self.runtime).clone()
    }

    /// Why the speech runtime last failed to load, if it did.
    pub fn runtime_error(&self) -> Option<String> {
        lock(&self.runtime_error).clone()
    }

    /// Ends the process: asked first (it stops its own helper), ended if it doesn't go.
    /// Its memory goes back to Windows; the next call starts a new one.
    pub fn stop(&self) {
        let Some(mut process) = lock(&self.process).take() else { return };
        *lock(&self.runtime) = None;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let asked = {
            let mut stdin = lock(&process.stdin);
            wire::send(&mut *stdin, &Call { id, request: Request::Shutdown }, &[]).and_then(|()| stdin.flush()).is_ok()
        };
        let deadline = Instant::now() + EXIT_GRACE;
        while asked && Instant::now() < deadline && matches!(process.child.try_wait(), Ok(None)) {
            std::thread::sleep(Duration::from_millis(15));
        }
        process.end();
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        if let Some(process) = lock(&self.process).take() {
            process.end();
        }
    }
}

/// The recognizer in one speech process. Calls fail cleanly once that process is gone.
pub struct Session {
    helper: Arc<Helper>,
    generation: u64,
}

impl Session {
    /// The process that holds this recognizer still runs.
    pub fn alive(&self) -> bool {
        lock(&self.helper.process).as_mut().is_some_and(|process| process.generation == self.generation && process.alive())
    }

    /// Its process went away by itself (it wasn't stopped for new settings or for being idle).
    pub fn crashed(&self) -> bool {
        let mut slot = lock(&self.helper.process);
        self.helper.reap(&mut slot);
        self.helper.crashed.load(Ordering::SeqCst) == self.generation
    }

    pub fn transcribe(&self, audio: &[f32]) -> Result<String, CallError> {
        match self.helper.call(Request::Transcribe, &wire::samples_to_bytes(audio), TRANSCRIBE_LIMIT, Some(self.generation))? {
            (Reply::Text { text }, _) => Ok(text),
            (other, _) => Err(Helper::unexpected(other)),
        }
    }

    pub fn probability(&self, frame: &[f32]) -> Result<f32, CallError> {
        match self.helper.call(Request::Vad, &wire::samples_to_bytes(frame), VAD_LIMIT, Some(self.generation))? {
            (Reply::Probability { value }, _) => Ok(value),
            (other, _) => Err(Helper::unexpected(other)),
        }
    }

    pub fn reset(&self) -> Result<(), CallError> {
        self.helper.call(Request::VadReset, &[], VAD_LIMIT, Some(self.generation)).map(|_| ())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.helper.leases.fetch_sub(1, Ordering::SeqCst);
    }
}
