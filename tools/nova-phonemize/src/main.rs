//! nova-phonemize — turns text into IPA phonemes with eSpeak NG, the way
//! Piper does (piper-phonemize), for NOVA's own voices.
//!
//! Copyright (C) 2026 Luca Warmers. This program is free software: you can
//! redistribute it and/or modify it under the terms of the GNU General Public
//! License as published by the Free Software Foundation, either version 3 of
//! the License, or (at your option) any later version. It is distributed in
//! the hope that it will be useful, but WITHOUT ANY WARRANTY; see the LICENSE
//! file next to this program's sources.
//!
//! Usage: `nova-phonemize <folder>` where the folder holds `espeak-ng.dll`
//! and `espeak-ng-data` (the rhasspy build that comes with Piper). Then, per
//! line on stdin, `{"voice":"de","text":"…"}`; per line on stdout,
//! `{"sentences":["…","…"]}` (each sentence's phonemes, one character per
//! phoneme, with punctuation) or `{"error":"…"}`.

use std::io::{BufRead, Write};

/// Clause ends eSpeak reports (`translate.h` of eSpeak NG).
const CLAUSE_TYPE_SENTENCE: i32 = 0x0008_0000;
const CLAUSE_PERIOD: i32 = 40 | CLAUSE_TYPE_SENTENCE;
const CLAUSE_QUESTION: i32 = 40 | 0x0000_2000 | CLAUSE_TYPE_SENTENCE;
const CLAUSE_EXCLAMATION: i32 = 45 | 0x0000_3000 | CLAUSE_TYPE_SENTENCE;
const CLAUSE_COMMA: i32 = 20 | 0x0000_1000 | 0x0004_0000;
const CLAUSE_COLON: i32 = 30 | 0x0004_0000;
const CLAUSE_SEMICOLON: i32 = 30 | 0x0000_1000 | 0x0004_0000;

/// What eSpeak said about where a clause ended, as Piper adds it back.
fn punctuation(terminator: i32) -> &'static str {
    match terminator & 0x000F_FFFF {
        CLAUSE_PERIOD => ".",
        CLAUSE_QUESTION => "?",
        CLAUSE_EXCLAMATION => "!",
        CLAUSE_COMMA => ", ",
        CLAUSE_COLON => ": ",
        CLAUSE_SEMICOLON => "; ",
        _ => "",
    }
}

/// Drops eSpeak's language switches, e.g. "(en)" around an English word.
fn without_language_flags(phonemes: &str) -> String {
    let mut out = String::with_capacity(phonemes.len());
    let mut inside = false;
    for c in phonemes.chars() {
        match c {
            '(' => inside = true,
            ')' if inside => inside = false,
            _ if !inside => out.push(c),
            _ => {}
        }
    }
    out
}

/// Splits clauses into sentences the way piper-phonemize does.
fn sentences(clauses: impl IntoIterator<Item = (String, i32)>) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for (phonemes, terminator) in clauses {
        let sentence = current.get_or_insert_with(String::new);
        sentence.push_str(&without_language_flags(&phonemes));
        sentence.push_str(punctuation(terminator));
        if terminator & CLAUSE_TYPE_SENTENCE == CLAUSE_TYPE_SENTENCE {
            out.extend(current.take());
        }
    }
    out.extend(current.filter(|s| !s.is_empty()));
    out
}

#[cfg(windows)]
mod espeak {
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Globalization::{NormalizeString, NormalizationD};
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};

    type Initialize = unsafe extern "C" fn(i32, i32, *const c_char, i32) -> i32;
    type SetVoiceByName = unsafe extern "C" fn(*const c_char) -> i32;
    type TextToPhonemes = unsafe extern "C" fn(*mut *const c_void, i32, i32, *mut i32) -> *const c_char;

    const AUDIO_OUTPUT_SYNCHRONOUS: i32 = 2;
    const CHARS_AUTO: i32 = 0;
    const PHONEMES_IPA: i32 = 0x02;

    pub struct Espeak {
        set_voice: SetVoiceByName,
        to_phonemes: TextToPhonemes,
        voice: Option<String>,
    }

    fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Decomposes characters ("ç" → "c" + "̧"), as Piper's phoneme maps expect.
    pub fn nfd(text: &str) -> String {
        let source: Vec<u16> = text.encode_utf16().collect();
        if source.is_empty() {
            return String::new();
        }
        // SAFETY: valid buffers with the lengths passed.
        unsafe {
            let size = NormalizeString(NormalizationD, source.as_ptr(), source.len() as i32, std::ptr::null_mut(), 0);
            if size <= 0 {
                return text.to_string();
            }
            let mut out = vec![0u16; size as usize];
            let written = NormalizeString(NormalizationD, source.as_ptr(), source.len() as i32, out.as_mut_ptr(), size);
            if written <= 0 {
                return text.to_string();
            }
            String::from_utf16_lossy(&out[..written as usize])
        }
    }

    impl Espeak {
        pub fn load(folder: &Path) -> Result<Self, String> {
            let dll = wide(folder.join("espeak-ng.dll").as_os_str());
            // SAFETY: a NUL-terminated absolute path; the library stays loaded for the process.
            let module = unsafe { LoadLibraryExW(dll.as_ptr(), std::ptr::null_mut(), LOAD_WITH_ALTERED_SEARCH_PATH) };
            if module.is_null() {
                return Err(format!("couldn't load {}", folder.join("espeak-ng.dll").display()));
            }
            let symbol = |name: &CStr| unsafe { GetProcAddress(module, name.as_ptr().cast()) }.ok_or_else(|| format!("espeak-ng.dll has no {}", name.to_string_lossy()));
            // SAFETY: the symbols have these C signatures in eSpeak NG (rhasspy's build).
            let (initialize, set_voice, to_phonemes) = unsafe {
                (
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, Initialize>(symbol(c"espeak_Initialize")?),
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, SetVoiceByName>(symbol(c"espeak_SetVoiceByName")?),
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, TextToPhonemes>(symbol(c"espeak_TextToPhonemesWithTerminator")?),
                )
            };
            let data = CString::new(folder.join("espeak-ng-data").to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
            // SAFETY: a NUL-terminated path, synchronous mode (no audio output).
            let rate = unsafe { initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, data.as_ptr(), 0) };
            if rate < 0 {
                return Err("eSpeak NG couldn't start (espeak-ng-data missing?)".into());
            }
            Ok(Self { set_voice, to_phonemes, voice: None })
        }

        /// The clauses of `text` with how each ended.
        /// `decompose`: split accented phonemes (Piper's tables want that; Kokoro's don't).
        pub fn clauses(&mut self, voice: &str, text: &str, decompose: bool) -> Result<Vec<(String, i32)>, String> {
            if self.voice.as_deref() != Some(voice) {
                let name = CString::new(voice).map_err(|e| e.to_string())?;
                // SAFETY: a NUL-terminated voice name.
                if unsafe { (self.set_voice)(name.as_ptr()) } != 0 {
                    return Err(format!("eSpeak NG has no voice “{voice}”"));
                }
                self.voice = Some(voice.to_string());
            }
            let input = CString::new(text.replace('\0', " ")).map_err(|e| e.to_string())?;
            let mut pointer = input.as_ptr().cast::<c_void>();
            let mut clauses = Vec::new();
            while !pointer.is_null() {
                let mut terminator = 0;
                // SAFETY: eSpeak advances `pointer` through `input` (alive here) and returns a static buffer, copied at once.
                let phonemes = unsafe {
                    let result = (self.to_phonemes)(&mut pointer, CHARS_AUTO, PHONEMES_IPA, &mut terminator);
                    if result.is_null() {
                        String::new()
                    } else {
                        CStr::from_ptr(result).to_string_lossy().into_owned()
                    }
                };
                clauses.push((if decompose { nfd(&phonemes) } else { phonemes }, terminator));
            }
            Ok(clauses)
        }
    }
}

fn main() {
    let Some(folder) = std::env::args_os().nth(1).map(std::path::PathBuf::from) else {
        eprintln!("usage: nova-phonemize <folder with espeak-ng.dll and espeak-ng-data>");
        std::process::exit(2);
    };
    #[cfg(windows)]
    let mut espeak = match espeak::Espeak::load(&folder) {
        Ok(espeak) => espeak,
        Err(error) => {
            println!("{}", serde_json::json!({ "error": error }));
            std::process::exit(1);
        }
    };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let request: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
        let voice = request["voice"].as_str().unwrap_or("de");
        let text = request["text"].as_str().unwrap_or("");
        let decompose = request["decompose"].as_bool().unwrap_or(true);
        #[cfg(windows)]
        let answer = match espeak.clauses(voice, text, decompose) {
            Ok(clauses) => serde_json::json!({ "sentences": sentences(clauses) }),
            Err(error) => serde_json::json!({ "error": error }),
        };
        #[cfg(not(windows))]
        let answer = {
            let _ = (&folder, voice, text, decompose, sentences(Vec::new()));
            serde_json::json!({ "error": "nova-phonemize needs Windows" })
        };
        if writeln!(stdout, "{answer}").and_then(|()| stdout.flush()).is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_punctuation_and_splits_sentences_like_piper() {
        let clauses = vec![
            ("haloː".to_string(), CLAUSE_COMMA),
            ("viː ɡeːt (en)ɪts(de) diːɐ".to_string(), CLAUSE_QUESTION),
            ("ɡuːt".to_string(), CLAUSE_PERIOD | 0x0040_0000),
            ("ʊnt".to_string(), 0),
        ];
        assert_eq!(sentences(clauses), vec!["haloː, viː ɡeːt ɪts diːɐ?", "ɡuːt.", "ʊnt"]);
        assert_eq!(punctuation(CLAUSE_EXCLAMATION), "!");
        assert_eq!(punctuation(CLAUSE_COLON), ": ");
        assert_eq!(punctuation(CLAUSE_SEMICOLON), "; ");
    }
}
