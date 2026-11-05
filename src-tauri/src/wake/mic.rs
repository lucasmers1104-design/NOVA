//! What the wake listener needs from Windows: microphone samples (WASAPI,
//! shared mode), how loud the speakers are, when the keyboard or mouse was
//! last used, and whether the PC is locked.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use windows::core::{Interface, BOOL};
use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, AudioCategory_Other, AudioClientProperties, IAudioCaptureClient, IAudioClient, IAudioClient2, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMOPTIONS_RAW, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};

const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
/// How often captured audio is collected.
const POLL: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MicError {
    /// Windows privacy settings block microphone access.
    Denied,
    /// No microphone is connected or enabled.
    Missing,
    /// The microphone went away (unplugged, disabled, default changed).
    Lost,
    Other(String),
}

impl From<windows::core::Error> for MicError {
    fn from(error: windows::core::Error) -> Self {
        match error.code().0 as u32 {
            0x8007_0005 => MicError::Denied,
            0x8007_0490 | 0x8889_0010 => MicError::Missing,
            0x8889_0004 => MicError::Lost,
            code => MicError::Other(format!("0x{code:08X}")),
        }
    }
}

/// The sample layout of the capture stream.
#[derive(Debug, Clone, Copy)]
struct Layout {
    float: bool,
    bits: u16,
    channels: usize,
    rate: u32,
}

/// Reads the mix format, including the extensible variant (whose sub-format
/// GUID starts with the plain format tag).
///
/// SAFETY: `format` must point to a valid WAVEFORMATEX (or WAVEFORMATEXTENSIBLE
/// when its tag says so), as returned by `IAudioClient::GetMixFormat`.
unsafe fn layout(format: *const WAVEFORMATEX) -> Result<Layout, MicError> {
    let base = std::ptr::read_unaligned(format);
    let tag = if base.wFormatTag == WAVE_FORMAT_EXTENSIBLE {
        let extensible = std::ptr::read_unaligned(format as *const WAVEFORMATEXTENSIBLE);
        extensible.SubFormat.data1 as u16
    } else {
        base.wFormatTag
    };
    let layout = Layout { float: tag == WAVE_FORMAT_IEEE_FLOAT, bits: base.wBitsPerSample, channels: base.nChannels.max(1) as usize, rate: base.nSamplesPerSec };
    match (tag, layout.bits) {
        (WAVE_FORMAT_IEEE_FLOAT, 32) | (WAVE_FORMAT_PCM, 16 | 24 | 32) => Ok(layout),
        _ => Err(MicError::Other(format!("unsupported microphone format ({tag}/{} bit)", layout.bits))),
    }
}

/// Averages the channels of interleaved frames into `out`.
fn to_mono(bytes: &[u8], layout: Layout, out: &mut Vec<f32>) {
    let width = (layout.bits / 8) as usize;
    let frame = width * layout.channels;
    for f in bytes.chunks_exact(frame) {
        let sum: f32 = f
            .chunks_exact(width)
            .map(|c| match (layout.float, layout.bits) {
                (true, _) => f32::from_le_bytes([c[0], c[1], c[2], c[3]]),
                (false, 16) => i16::from_le_bytes([c[0], c[1]]) as f32 / 32_768.0,
                (false, 24) => (i32::from_le_bytes([0, c[0], c[1], c[2]]) >> 8) as f32 / 8_388_608.0,
                _ => i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / 2_147_483_648.0,
            })
            .sum();
        out.push(sum / layout.channels as f32);
    }
}

/// Captures the default microphone until `stop` is set, handing mono samples
/// and the sample rate to `sink` every ~20 ms (also with no samples, so the
/// caller can do its periodic work). Needs COM on the calling thread.
pub fn capture(stop: &AtomicBool, sink: impl FnMut(&[f32], u32)) -> Result<(), MicError> {
    capture_with(stop, true, sink)
}

/// The same; `raw`: without Windows' noise suppression and gain control
/// (right for claps; speech recognition wants them on).
pub fn capture_with(stop: &AtomicBool, raw: bool, mut sink: impl FnMut(&[f32], u32)) -> Result<(), MicError> {
    // SAFETY: standard WASAPI calls on objects this function owns; the mix
    // format is freed once and buffers are released after each read.
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        // Raw audio: noise suppression and automatic gain smear claps.
        if let Some(client2) = raw.then(|| client.cast::<IAudioClient2>().ok()).flatten() {
            let properties = AudioClientProperties {
                cbSize: size_of::<AudioClientProperties>() as u32,
                bIsOffload: BOOL(0),
                eCategory: AudioCategory_Other,
                Options: AUDCLNT_STREAMOPTIONS_RAW,
            };
            let _ = client2.SetClientProperties(&properties);
        }
        let format = client.GetMixFormat()?;
        let layout = layout(format);
        let initialized = layout.is_ok().then(|| client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 2_000_000, 0, format, None));
        CoTaskMemFree(Some(format as *const _));
        let layout = layout?;
        initialized.transpose()?;
        let reader: IAudioCaptureClient = client.GetService()?;
        client.Start()?;

        let mut mono = Vec::with_capacity(layout.rate as usize / 10);
        let result = (|| -> Result<(), MicError> {
            while !stop.load(Ordering::Relaxed) {
                std::thread::sleep(POLL);
                mono.clear();
                while reader.GetNextPacketSize()? > 0 {
                    let mut data = std::ptr::null_mut();
                    let (mut frames, mut flags) = (0u32, 0u32);
                    reader.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                    if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                        mono.resize(mono.len() + frames as usize, 0.0);
                    } else {
                        let bytes = std::slice::from_raw_parts(data, frames as usize * layout.channels * (layout.bits / 8) as usize);
                        to_mono(bytes, layout, &mut mono);
                    }
                    reader.ReleaseBuffer(frames)?;
                }
                sink(&mono, layout.rate);
            }
            Ok(())
        })();
        let _ = client.Stop();
        result
    }
}

/// How loud the speakers are right now: the output peak scaled by the
/// master volume (0 when muted).
pub struct Speakers {
    meter: IAudioMeterInformation,
    volume: IAudioEndpointVolume,
}

impl Speakers {
    pub fn open() -> Option<Self> {
        // SAFETY: standard COM activation on a thread with COM initialized.
        unsafe {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            Some(Self { meter: device.Activate(CLSCTX_ALL, None).ok()?, volume: device.Activate(CLSCTX_ALL, None).ok()? })
        }
    }

    /// 0–1, or None once the device is gone.
    pub fn loudness(&self) -> Option<f32> {
        // SAFETY: plain COM getters.
        unsafe {
            let peak = self.meter.GetPeakValue().ok()?;
            let muted = self.volume.GetMute().ok()?.as_bool();
            let level = self.volume.GetMasterVolumeLevelScalar().ok()?;
            Some(if muted { 0.0 } else { (peak * level).clamp(0.0, 1.0) })
        }
    }
}

/// Milliseconds since the last keyboard, mouse or touch input anywhere.
pub fn input_idle_ms() -> u32 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: `info` is a properly sized LASTINPUTINFO.
    if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        unsafe { GetTickCount() }.wrapping_sub(info.dwTime)
    } else {
        u32::MAX
    }
}

/// The lock screen (or a secure desktop such as a UAC prompt) is showing.
pub fn session_locked() -> bool {
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_SWITCHDESKTOP};
    // SAFETY: the handle is closed right away; failure means another desktop has the input.
    match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_SWITCHDESKTOP) } {
        Ok(desktop) => {
            let _ = unsafe { CloseDesktop(desktop) };
            false
        }
        Err(_) => true,
    }
}

/// Whether "Online speech recognition" is on, which dictation needs.
pub fn dictation_allowed() -> bool {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut value = 0u32;
    let mut size = size_of::<u32>() as u32;
    // SAFETY: the output buffer is a u32 and its size is passed.
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Speech_OneCore\\Settings\\OnlineSpeechPrivacy"),
            w!("HasAccepted"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    result.is_ok() && value == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixes_channels_down() {
        let stereo_float = Layout { float: true, bits: 32, channels: 2, rate: 48_000 };
        let bytes: Vec<u8> = [0.5f32, -0.5, 1.0, 0.0].iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut out = Vec::new();
        to_mono(&bytes, stereo_float, &mut out);
        assert_eq!(out, vec![0.0, 0.5]);

        let mono16 = Layout { float: false, bits: 16, channels: 1, rate: 16_000 };
        out.clear();
        to_mono(&[0x00, 0x40, 0x00, 0xC0], mono16, &mut out);
        assert_eq!(out, vec![0.5, -0.5]);

        let mono24 = Layout { float: false, bits: 24, channels: 1, rate: 44_100 };
        out.clear();
        to_mono(&[0x00, 0x00, 0x40], mono24, &mut out);
        assert_eq!(out, vec![0.5]);
    }
}
