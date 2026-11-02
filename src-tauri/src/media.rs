//! Media controls through the Windows global media session (what the
//! volume flyout shows) and the default output device's master volume.
//!
//! Capabilities are reported per player: a control is only offered when the
//! current player says it supports it.

use serde::Serialize;

type CommandResult<T> = Result<T, String>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    source_app_id: String,
    title: String,
    artist: String,
    album: String,
    /// playing | paused | stopped | changing | opened | closed
    status: &'static str,
    can_play_pause: bool,
    can_next: bool,
    can_previous: bool,
    /// Position at `sampled_at_ms`, extrapolated while playing. `None` when the player does not report a timeline.
    position_ms: Option<u64>,
    duration_ms: Option<u64>,
    sampled_at_ms: u64,
    /// Changes whenever the artwork changes; `None` when there is no artwork.
    artwork_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeState {
    level: f32,
    muted: bool,
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Converts a Windows FILETIME-style timestamp (100 ns ticks since 1601) to Unix milliseconds.
pub fn filetime_to_unix_ms(ticks: i64) -> Option<u64> {
    const EPOCH_DIFF_MS: i64 = 11_644_473_600_000;
    let ms = ticks / 10_000 - EPOCH_DIFF_MS;
    (ms > 0).then_some(ms as u64)
}

/// Extrapolates the playback position, clamped to the track length.
pub fn extrapolate_position(position_ms: u64, updated_ms: Option<u64>, now_ms: u64, playing: bool, duration_ms: Option<u64>) -> u64 {
    let advanced = match (playing, updated_ms) {
        (true, Some(updated)) if now_ms > updated => position_ms + (now_ms - updated),
        _ => position_ms,
    };
    duration_ms.map_or(advanced, |d| advanced.min(d))
}

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::shell::with_com;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    fn err(e: windows::core::Error) -> String {
        e.message().to_string()
    }

    fn current_session() -> CommandResult<Option<Session>> {
        let manager = Manager::RequestAsync().map_err(err)?.join().map_err(err)?;
        Ok(manager.GetCurrentSession().ok())
    }

    pub fn state() -> CommandResult<Option<MediaState>> {
        with_com(false, || {
            let Some(session) = current_session()? else { return Ok(None) };
            let props = session.TryGetMediaPropertiesAsync().map_err(err)?.join().map_err(err)?;
            let playback = session.GetPlaybackInfo().map_err(err)?;
            let controls = playback.Controls().map_err(err)?;
            let status = match playback.PlaybackStatus().map_err(err)? {
                Status::Playing => "playing",
                Status::Paused => "paused",
                Status::Stopped => "stopped",
                Status::Changing => "changing",
                Status::Opened => "opened",
                _ => "closed",
            };

            let now = unix_millis();
            let (position_ms, duration_ms) = match session.GetTimelineProperties() {
                Ok(timeline) => {
                    let ticks = |r: windows::core::Result<windows::Foundation::TimeSpan>| r.map(|t| t.Duration).unwrap_or(0);
                    let start = ticks(timeline.StartTime());
                    let end = ticks(timeline.EndTime());
                    let position = ticks(timeline.Position());
                    let duration = (end > start).then(|| ((end - start) / 10_000) as u64);
                    let updated = timeline.LastUpdatedTime().ok().and_then(|t| filetime_to_unix_ms(t.UniversalTime));
                    let position = duration.map(|_| {
                        extrapolate_position(((position - start).max(0) / 10_000) as u64, updated, now, status == "playing", duration)
                    });
                    (position, duration)
                }
                Err(_) => (None, None),
            };

            let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
            let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
            let album = props.AlbumTitle().map(|s| s.to_string()).unwrap_or_default();
            let has_artwork = props.Thumbnail().is_ok();
            Ok(Some(MediaState {
                source_app_id: session.SourceAppUserModelId().map(|s| s.to_string()).unwrap_or_default(),
                artwork_key: has_artwork.then(|| crate::apps::stable_id("art", &format!("{title}\u{1f}{artist}\u{1f}{album}"))),
                title,
                artist,
                album,
                status,
                can_play_pause: controls.IsPlayPauseToggleEnabled().unwrap_or(false),
                can_next: controls.IsNextEnabled().unwrap_or(false),
                can_previous: controls.IsPreviousEnabled().unwrap_or(false),
                position_ms,
                duration_ms,
                sampled_at_ms: now,
            }))
        })
    }

    pub fn artwork() -> CommandResult<Option<String>> {
        use base64::Engine;
        with_com(false, || {
            let Some(session) = current_session()? else { return Ok(None) };
            let props = session.TryGetMediaPropertiesAsync().map_err(err)?.join().map_err(err)?;
            let Ok(reference) = props.Thumbnail() else { return Ok(None) };
            let stream = reference.OpenReadAsync().map_err(err)?.join().map_err(err)?;
            let size = stream.Size().map_err(err)?;
            if size == 0 || size > 8 * 1024 * 1024 {
                return Ok(None);
            }
            let content_type = stream.ContentType().map(|s| s.to_string()).unwrap_or_default();
            let mime = if content_type.starts_with("image/") { content_type } else { "image/png".into() };
            let reader = DataReader::CreateDataReader(&stream).map_err(err)?;
            reader.LoadAsync(size as u32).map_err(err)?.join().map_err(err)?;
            let mut bytes = vec![0u8; size as usize];
            reader.ReadBytes(&mut bytes).map_err(err)?;
            Ok(Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
        })
    }

    pub fn control(action: &str) -> CommandResult<()> {
        with_com(false, || {
            let session = current_session()?.ok_or("Nothing is playing")?;
            let controls = session.GetPlaybackInfo().map_err(err)?.Controls().map_err(err)?;
            let (supported, operation) = match action {
                "toggle" => (controls.IsPlayPauseToggleEnabled().unwrap_or(false), session.TryTogglePlayPauseAsync()),
                "next" => (controls.IsNextEnabled().unwrap_or(false), session.TrySkipNextAsync()),
                "previous" => (controls.IsPreviousEnabled().unwrap_or(false), session.TrySkipPreviousAsync()),
                other => return Err(format!("Unknown media action “{other}”")),
            };
            if !supported {
                return Err("The current player doesn't support this control".into());
            }
            let accepted = operation.map_err(err)?.join().map_err(err)?;
            if accepted {
                Ok(())
            } else {
                Err("The player ignored the request".into())
            }
        })
    }

    fn endpoint_volume() -> CommandResult<windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume> {
        use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
        use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
        // SAFETY: called with COM initialized; interfaces are reference counted by the bindings.
        unsafe {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(err)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|_| "No audio output device".to_string())?;
            device.Activate(CLSCTX_ALL, None).map_err(err)
        }
    }

    pub fn volume() -> CommandResult<VolumeState> {
        with_com(false, || {
            let endpoint = endpoint_volume()?;
            // SAFETY: valid interface obtained above.
            unsafe {
                Ok(VolumeState {
                    level: endpoint.GetMasterVolumeLevelScalar().map_err(err)?,
                    muted: endpoint.GetMute().map_err(err)?.as_bool(),
                })
            }
        })
    }

    pub fn set_volume(level: Option<f32>, muted: Option<bool>) -> CommandResult<VolumeState> {
        with_com(false, || {
            let endpoint = endpoint_volume()?;
            // SAFETY: valid interface; a null event context is allowed by the API.
            unsafe {
                if let Some(level) = level {
                    endpoint.SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null()).map_err(err)?;
                }
                if let Some(muted) = muted {
                    endpoint.SetMute(muted, std::ptr::null()).map_err(err)?;
                }
            }
            Ok(())
        })?;
        volume()
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    const UNSUPPORTED: &str = "Media controls require Windows";
    pub fn state() -> CommandResult<Option<MediaState>> {
        Err(UNSUPPORTED.into())
    }
    pub fn artwork() -> CommandResult<Option<String>> {
        Err(UNSUPPORTED.into())
    }
    pub fn control(_: &str) -> CommandResult<()> {
        Err(UNSUPPORTED.into())
    }
    pub fn volume() -> CommandResult<VolumeState> {
        Err(UNSUPPORTED.into())
    }
    pub fn set_volume(_: Option<f32>, _: Option<bool>) -> CommandResult<VolumeState> {
        Err(UNSUPPORTED.into())
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CommandResult<T> + Send + 'static) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn media_state() -> CommandResult<Option<MediaState>> {
    blocking(platform::state).await
}

#[tauri::command]
pub async fn media_artwork() -> CommandResult<Option<String>> {
    blocking(platform::artwork).await
}

#[tauri::command]
pub async fn media_control(action: String) -> CommandResult<()> {
    blocking(move || platform::control(&action)).await
}

#[tauri::command]
pub async fn media_volume() -> CommandResult<VolumeState> {
    blocking(platform::volume).await
}

#[tauri::command]
pub async fn media_volume_set(level: Option<f32>, muted: Option<bool>) -> CommandResult<VolumeState> {
    blocking(move || platform::set_volume(level, muted)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_filetime() {
        // 2026-01-01T00:00:00Z
        assert_eq!(filetime_to_unix_ms(134_116_992_000_000_000), Some(1_767_225_600_000));
        assert_eq!(filetime_to_unix_ms(0), None);
    }

    #[test]
    fn extrapolates_only_while_playing() {
        assert_eq!(extrapolate_position(10_000, Some(1_000), 3_000, true, Some(60_000)), 12_000);
        assert_eq!(extrapolate_position(10_000, Some(1_000), 3_000, false, Some(60_000)), 10_000);
        assert_eq!(extrapolate_position(59_000, Some(1_000), 9_000, true, Some(60_000)), 60_000);
        assert_eq!(extrapolate_position(10_000, None, 3_000, true, None), 10_000);
    }

    #[test]
    fn state_query_does_not_fail() {
        // Environment-dependent: nothing playing is a valid `None`.
        assert!(platform::state().is_ok());
    }

    #[test]
    fn rejects_unknown_actions() {
        if let Err(message) = platform::control("explode") {
            assert!(message.contains("Unknown") || message.contains("Nothing is playing"));
        }
    }
}
