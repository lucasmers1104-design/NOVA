//! NOVA's speech process, started for real: the nova.exe cargo just built,
//! with `--speech-helper`. No model is needed for any of this — what is
//! checked is that the process starts on demand, ends when it should, and
//! that NOVA survives whatever happens to it.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use nova_lib::speech::helper::{CallError, Helper, RecognizerSpec, FLAG};
use nova_lib::speech::runtime::Device;

/// Generous: a virus scanner may look at the exe before its first start.
const SOON: Duration = Duration::from_secs(30);

fn nova() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_nova"))
}

fn helper() -> Arc<Helper> {
    Arc::new(Helper::with_program("test", nova()))
}

fn at_once() -> Duration {
    Duration::ZERO
}

/// A recognizer that can't load: its runtime folder doesn't exist.
fn nowhere() -> RecognizerSpec {
    let missing = std::env::temp_dir().join("nova-no-such-speech-runtime");
    RecognizerSpec { runtime: missing.clone(), dir: missing, device: Device::Cpu { threads: 1 } }
}

#[test]
fn it_starts_with_the_first_call_and_ends_when_told() {
    let helper = helper();
    assert!(!helper.running(), "nothing runs before the first call");
    assert_eq!(helper.pid(), None);
    helper.ping(at_once(), SOON).unwrap();
    let first = helper.pid().expect("a process after the first call");
    helper.ping(at_once(), SOON).unwrap();
    assert_eq!(helper.pid(), Some(first), "the same process answers the next call");
    assert!(helper.unused());

    helper.stop();
    assert!(!helper.running());
    assert_eq!(helper.pid(), None);
    assert!(!helper.unused(), "nothing is left that could be ended");

    helper.ping(at_once(), SOON).unwrap();
    assert_ne!(helper.pid(), Some(first), "a new process after the old one ended");
}

#[test]
fn a_crash_is_a_clean_error_and_the_next_call_starts_a_new_process() {
    let helper = helper();
    helper.ping(at_once(), SOON).unwrap();
    let first = helper.pid().unwrap();

    // A call is under way when the process goes down.
    let busy = {
        let helper = helper.clone();
        std::thread::spawn(move || helper.ping(Duration::from_secs(20), SOON))
    };
    std::thread::sleep(Duration::from_millis(200));
    let asked = Instant::now();
    helper.crash();
    let error = busy.join().unwrap().unwrap_err();
    assert!(error.gone(), "{error:?}");
    assert!(error.message().contains("ended unexpectedly"), "{error:?}");
    assert!(asked.elapsed() < Duration::from_secs(10), "the waiting call learns it at once, not after its time limit");
    assert!(!helper.running());

    helper.ping(at_once(), SOON).unwrap();
    let second = helper.pid().unwrap();
    assert_ne!(first, second);
}

#[test]
fn a_process_that_hangs_is_stopped() {
    let helper = helper();
    helper.ping(at_once(), SOON).unwrap();
    let error = helper.ping(Duration::from_secs(30), Duration::from_millis(300)).unwrap_err();
    assert!(error.gone(), "{error:?}");
    assert!(!helper.running(), "it was ended, not left hanging");
    helper.ping(at_once(), SOON).unwrap();
}

#[test]
fn a_call_in_flight_counts_as_use() {
    let helper = helper();
    helper.ping(at_once(), SOON).unwrap();
    let busy = {
        let helper = helper.clone();
        std::thread::spawn(move || helper.ping(Duration::from_millis(800), SOON))
    };
    std::thread::sleep(Duration::from_millis(200));
    assert!(helper.running() && !helper.unused(), "the idle check must leave it alone");
    busy.join().unwrap().unwrap();
    assert!(helper.unused());
}

#[test]
fn a_model_that_cannot_load_is_an_answer_not_a_crash() {
    let helper = helper();
    let Err(error) = helper.open_recognizer(&nowhere()) else { panic!("there is no runtime to load") };
    assert_eq!(error, CallError::Failed { message: "The speech runtime isn't downloaded".into(), runtime: true });
    assert_eq!(helper.runtime_error().as_deref(), Some("The speech runtime isn't downloaded"));
    assert!(helper.running(), "the process is fine");
    assert!(helper.unused(), "no recognizer was handed out");
    assert_eq!(helper.runtime(), None);
}

#[test]
fn the_recognizer_does_not_wait_for_the_voice() {
    let helper = helper();
    helper.ping(at_once(), SOON).unwrap();
    let speaking = {
        let helper = helper.clone();
        std::thread::spawn(move || {
            helper.ping(Duration::from_millis(1500), SOON).unwrap();
            Instant::now()
        })
    };
    std::thread::sleep(Duration::from_millis(200));
    // Answered on its own lane while the voice lane is busy, and each call gets its own answer.
    assert!(matches!(helper.open_recognizer(&nowhere()), Err(CallError::Failed { runtime: true, .. })));
    let answered = Instant::now();
    assert!(answered < speaking.join().unwrap());
}

#[test]
fn it_ends_when_nova_goes_away() {
    let mut child = Command::new(nova()).arg(FLAG).arg("test").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(child.try_wait().unwrap().is_none(), "it waits for calls");
    // NOVA's end of the pipe closes when NOVA exits or crashes.
    drop(child.stdin.take());
    let deadline = Instant::now() + SOON;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "the speech process outlived NOVA");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success());
}

#[test]
fn a_stream_that_is_not_the_protocol_ends_the_process() {
    use std::io::Write;
    let mut child = Command::new(nova()).arg(FLAG).arg("test").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    // Lengths far beyond any frame: refused before a byte is allocated.
    stdin.write_all(&[0xff; 64]).unwrap();
    stdin.flush().unwrap();
    let deadline = Instant::now() + SOON;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "garbage must not leave it running");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(status.code(), Some(2));
}
