// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // A measurement of NOVA's speech models runs in its own process (see speech::probe).
    let args: Vec<String> = std::env::args().collect();
    if let Some(at) = args.iter().position(|a| a == "--speech-probe") {
        std::process::exit(nova_lib::speech_probe(args.get(at + 1).map(String::as_str).unwrap_or("{}")));
    }
    nova_lib::run();
}
