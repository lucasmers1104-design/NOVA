//! Freeing disk space: what a normal person doesn't need on their PC. Only
//! what is listed here can go this way (temporary files, leftovers, the Recycle
//! Bin, installers in Downloads); a person's own files never can.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sysinfo::Disks;

/// Files in use are recent; anything younger stays.
const YOUNGEST: Duration = Duration::from_secs(24 * 60 * 60);
const SETUP_EXTENSIONS: &[&str] = &["exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "iso", "img"];
/// Big and long untouched: shown for the user to decide, never deleted this way.
const BIG_DOWNLOAD: u64 = 200 * 1024 * 1024;
const OLD_DOWNLOAD: Duration = Duration::from_secs(90 * 24 * 60 * 60);
/// Other programs need these, so they don't go even though they take space.
const ESSENTIAL: &[&str] = &["visual c++", "microsoft .net", "microsoft asp.net", ".net runtime", ".net framework", ".net desktop", "directx", "webview2", "microsoft windows", "windows sdk", "microsoft edge", "microsoft update", "nvidia graphics", "nvidia hd audio", "amd software", "intel(r)", "realtek"];
const UNINSTALL_LIMIT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Group {
    Temp,
    WindowsTemp,
    CrashDumps,
    RecycleBin,
}

impl Group {
    pub const ALL: [Group; 4] = [Group::Temp, Group::WindowsTemp, Group::CrashDumps, Group::RecycleBin];

    pub fn id(self) -> &'static str {
        match self {
            Group::Temp => "temp",
            Group::WindowsTemp => "windows_temp",
            Group::CrashDumps => "crash_dumps",
            Group::RecycleBin => "recycle_bin",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Group::Temp => "Temporary files",
            Group::WindowsTemp => "Windows' temporary files",
            Group::CrashDumps => "Crash reports",
            Group::RecycleBin => "Recycle Bin",
        }
    }

    pub fn from_id(id: &str) -> Option<Group> {
        Group::ALL.into_iter().find(|group| group.id() == id)
    }

    fn folder(self) -> Option<PathBuf> {
        match self {
            Group::Temp => Some(std::env::temp_dir()),
            Group::WindowsTemp => std::env::var_os("SystemRoot").map(|root| PathBuf::from(root).join("Temp")),
            Group::CrashDumps => std::env::var_os("LOCALAPPDATA").map(|local| PathBuf::from(local).join("CrashDumps")),
            Group::RecycleBin => None,
        }
    }
}

/// Bytes and items that a sweep of `dir` would take. Links are never followed.
fn sweepable(dir: &Path, cutoff: SystemTime) -> (u64, u64) {
    let mut total = (0, 0);
    let Ok(entries) = std::fs::read_dir(dir) else { return total };
    for entry in entries.flatten() {
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            let inner = sweepable(&entry.path(), cutoff);
            total = (total.0 + inner.0, total.1 + inner.1);
        } else if meta.modified().is_ok_and(|at| at < cutoff) {
            total = (total.0 + meta.len(), total.1 + 1);
        }
    }
    total
}

/// Deletes what is old enough under `dir`; returns the bytes freed. What is in
/// use just stays, and so do folders that aren't empty afterwards.
fn sweep(dir: &Path, cutoff: SystemTime) -> u64 {
    let mut freed = 0;
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            freed += sweep(&path, cutoff);
            // Fails, as wanted, while something is left inside.
            let _ = std::fs::remove_dir(&path);
        } else if meta.modified().is_ok_and(|at| at < cutoff) && std::fs::remove_file(&path).is_ok() {
            freed += meta.len();
        }
    }
    freed
}

fn cutoff() -> SystemTime {
    SystemTime::now().checked_sub(YOUNGEST).unwrap_or(SystemTime::UNIX_EPOCH)
}

#[cfg(windows)]
fn recycle_bin_size() -> (u64, u64) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};
    let mut info = SHQUERYRBINFO { cbSize: size_of::<SHQUERYRBINFO>() as u32, ..Default::default() };
    // SAFETY: `info` is a valid struct with its size set; a null path means all drives.
    match unsafe { SHQueryRecycleBinW(PCWSTR::null(), &mut info) } {
        Ok(()) => (info.i64Size.max(0) as u64, info.i64NumItems.max(0) as u64),
        Err(_) => (0, 0),
    }
}

#[cfg(windows)]
fn empty_recycle_bin() -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND};
    // SAFETY: no window and a null path (all drives); the flags only silence its dialogs.
    unsafe { SHEmptyRecycleBinW(None, PCWSTR::null(), SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND) }.map_err(|e| format!("Couldn't empty the Recycle Bin: {e}"))
}

#[cfg(not(windows))]
fn recycle_bin_size() -> (u64, u64) {
    (0, 0)
}

#[cfg(not(windows))]
fn empty_recycle_bin() -> Result<(), String> {
    Err("This requires Windows".into())
}

pub fn group_size(group: Group) -> (u64, u64) {
    match group.folder() {
        Some(folder) => sweepable(&folder, cutoff()),
        None => recycle_bin_size(),
    }
}

/// Empties a group; the bytes it freed.
pub fn clear_group(group: Group) -> Result<u64, String> {
    match group.folder() {
        Some(folder) => Ok(sweep(&folder, cutoff())),
        None => {
            let (bytes, _) = recycle_bin_size();
            if bytes > 0 {
                empty_recycle_bin()?;
            }
            Ok(bytes)
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DownloadFile {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub days_old: u64,
}

fn is_setup(path: &Path) -> bool {
    path.extension().is_some_and(|ext| SETUP_EXTENSIONS.contains(&ext.to_string_lossy().to_lowercase().as_str()))
}

fn downloads_folder() -> Option<PathBuf> {
    crate::files::known_folders().into_iter().find(|folder| folder.id == "downloads").map(|folder| PathBuf::from(folder.path))
}

/// Files directly in `dir`, biggest first, split into installers and big old ones.
fn sort_downloads(dir: &Path, now: SystemTime) -> (Vec<DownloadFile>, Vec<DownloadFile>) {
    let (mut setups, mut big_old) = (Vec::new(), Vec::new());
    let Ok(entries) = std::fs::read_dir(dir) else { return (setups, big_old) };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        let age = meta.modified().ok().and_then(|at| now.duration_since(at).ok()).unwrap_or_default();
        let file = DownloadFile { name: entry.file_name().to_string_lossy().into_owned(), size: meta.len(), days_old: age.as_secs() / 86_400, path };
        if is_setup(&file.path) {
            setups.push(file);
        } else if file.size >= BIG_DOWNLOAD && age >= OLD_DOWNLOAD {
            big_old.push(file);
        }
    }
    setups.sort_by_key(|file| std::cmp::Reverse(file.size));
    big_old.sort_by_key(|file| std::cmp::Reverse(file.size));
    (setups, big_old)
}

pub fn downloads() -> (Vec<DownloadFile>, Vec<DownloadFile>) {
    downloads_folder().map_or_else(Default::default, |dir| sort_downloads(&dir, SystemTime::now()))
}

/// `raw` as an installer that is really in Downloads: nothing else can be deleted this way.
pub fn setup_file(raw: &str) -> Result<DownloadFile, String> {
    let wanted = PathBuf::from(raw.trim().trim_matches('"'));
    downloads()
        .0
        .into_iter()
        .find(|file| file.path == wanted || file.name.eq_ignore_ascii_case(raw.trim()))
        .ok_or_else(|| format!("“{raw}” isn't an installer in Downloads. Only what find_junk lists can be cleaned up this way."))
}

pub fn delete_setup(file: &DownloadFile) -> Result<u64, String> {
    std::fs::remove_file(&file.path).map(|()| file.size).map_err(|e| format!("Couldn't delete {}: {e}", file.name))
}

/// Free space on all drives together.
fn free_everywhere() -> u64 {
    Disks::new_with_refreshed_list().map_or(0, |disks| (&disks).into_iter().map(|disk| disk.available_space()).sum())
}

/// Free space on the Windows drive: that's the one people run out of.
pub fn free_space() -> u64 {
    let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let on_system = Disks::new_with_refreshed_list().ok().and_then(|disks| (&disks).into_iter().find(|disk| disk.mount_point().to_string_lossy().to_lowercase().starts_with(&system.to_lowercase())).map(|disk| disk.available_space()));
    on_system.unwrap_or_else(free_everywhere)
}

/// Why a program shouldn't be uninstalled to save space, if so.
pub fn refuses_uninstall(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    if lower == "nova" {
        return Some("NOVA doesn't uninstall itself.".into());
    }
    ESSENTIAL.iter().any(|word| lower.contains(word)).then(|| format!("{name} is something other programs or Windows need, so NOVA doesn't uninstall it."))
}

/// A registered uninstall command as program and arguments. `msiexec /I{…}`
/// (which only opens the "change" dialog of some installers) becomes `/X{…}`.
pub fn split_command(command: &str) -> (String, String) {
    let command = command.trim();
    let (program, arguments) = if let Some(rest) = command.strip_prefix('"') {
        rest.split_once('"').map_or((rest, ""), |(program, arguments)| (program, arguments))
    } else {
        // Often unquoted, even with spaces in the path.
        let lower = command.to_lowercase();
        match lower.find(".exe") {
            Some(end) => command.split_at(end + 4),
            None => (command, ""),
        }
    };
    let mut arguments = arguments.trim().to_string();
    if program.to_lowercase().ends_with("msiexec.exe") || program.eq_ignore_ascii_case("msiexec") {
        arguments = arguments.replacen("/I{", "/X{", 1).replacen("/i{", "/X{", 1);
    }
    (program.to_string(), arguments)
}

/// Runs the program's own uninstaller and waits until Windows no longer lists
/// it. Returns the bytes freed, measured on the drives (or the size it reported,
/// where the uninstaller is still tidying up). `stop`: the user pressed stop.
pub fn uninstall(name: &str, estimated: u64, command: &str, stop: &dyn Fn() -> bool, still_listed: &dyn Fn() -> bool) -> Result<u64, String> {
    // On all drives: a game may well sit on another one.
    let before = free_everywhere();
    let (program, arguments) = split_command(command);
    crate::shell::run_program(&program, &arguments)?;
    let started = std::time::Instant::now();
    while still_listed() {
        if stop() {
            return Err(format!("Stopped waiting. {name}'s uninstaller may still be open."));
        }
        if started.elapsed() >= UNINSTALL_LIMIT {
            return Err(format!("{name} is still installed after 10 minutes. Its uninstaller may be waiting for you, or it was cancelled."));
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    let measured = free_everywhere().saturating_sub(before);
    Ok(if measured < estimated / 2 { estimated } else { measured })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nova-cleanup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sweeps_only_what_is_old_enough_and_counts_it() {
        let dir = scratch("sweep");
        std::fs::create_dir_all(dir.join("old").join("deep")).unwrap();
        std::fs::write(dir.join("old").join("deep").join("a.tmp"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("b.tmp"), vec![0u8; 50]).unwrap();
        // A cutoff in the future makes everything old; one in the past, nothing.
        let later = SystemTime::now() + Duration::from_secs(60);
        let earlier = SystemTime::now() - Duration::from_secs(3600);
        assert_eq!(sweepable(&dir, earlier), (0, 0));
        assert_eq!(sweep(&dir, earlier), 0);
        assert!(dir.join("b.tmp").exists());
        assert_eq!(sweepable(&dir, later), (150, 2));
        assert_eq!(sweep(&dir, later), 150);
        assert!(!dir.join("b.tmp").exists() && !dir.join("old").exists());
        // The folder asked for stays.
        assert!(dir.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_is_nothing_to_do() {
        let gone = std::env::temp_dir().join("nova-cleanup-does-not-exist");
        assert_eq!(sweepable(&gone, SystemTime::now()), (0, 0));
        assert_eq!(sweep(&gone, SystemTime::now()), 0);
    }

    #[test]
    fn tells_installers_from_a_persons_files() {
        let dir = scratch("downloads");
        std::fs::write(dir.join("Setup.EXE"), vec![0u8; 10]).unwrap();
        std::fs::write(dir.join("big.iso"), vec![0u8; 30]).unwrap();
        std::fs::write(dir.join("Hausaufgaben.pdf"), vec![0u8; 20]).unwrap();
        std::fs::create_dir_all(dir.join("folder.exe")).unwrap();
        let (setups, big_old) = sort_downloads(&dir, SystemTime::now());
        assert_eq!(setups.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["big.iso", "Setup.EXE"]);
        assert!(big_old.is_empty(), "a small pdf isn't a candidate");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn big_old_downloads_are_listed_but_separate() {
        let dir = scratch("old");
        let file = std::fs::File::create(dir.join("film.mkv")).unwrap();
        file.set_len(BIG_DOWNLOAD).unwrap();
        drop(file);
        let (setups, big_old) = sort_downloads(&dir, SystemTime::now() + OLD_DOWNLOAD + Duration::from_secs(60));
        assert!(setups.is_empty());
        assert_eq!(big_old[0].name, "film.mkv");
        assert_eq!(big_old[0].days_old, 90);
        assert!(sort_downloads(&dir, SystemTime::now()).1.is_empty(), "new, so not old enough");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deletes_only_installers_in_downloads() {
        assert!(setup_file(r"C:\Windows\System32\kernel32.dll").is_err());
        assert!(setup_file(r"C:\Users\me\Documents\Bachelorarbeit.docx").is_err());
    }

    #[test]
    fn leaves_what_others_depend_on() {
        for name in ["Microsoft Visual C++ 2022 X64 Minimum Runtime", "Microsoft .NET Runtime 8.0", "NVIDIA Graphics Driver 551.23", "Microsoft Edge WebView2 Runtime", "NOVA"] {
            assert!(refuses_uninstall(name).is_some(), "{name}");
        }
        for name in ["Discord", "Fortnite", "Opera GX Stable"] {
            assert_eq!(refuses_uninstall(name), None, "{name}");
        }
    }

    #[test]
    fn splits_uninstall_commands_however_they_are_written() {
        let split = |c: &str| split_command(c);
        assert_eq!(split(r#""C:\Program Files\App\unins000.exe" /SILENT"#), (r"C:\Program Files\App\unins000.exe".into(), "/SILENT".into()));
        assert_eq!(split(r"C:\Program Files\App\uninstall.exe --force"), (r"C:\Program Files\App\uninstall.exe".into(), "--force".into()));
        assert_eq!(split(r#""C:\App\u.exe""#), (r"C:\App\u.exe".into(), String::new()));
        assert_eq!(split("MsiExec.exe /I{12345678-AAAA}"), ("MsiExec.exe".into(), "/X{12345678-AAAA}".into()));
        assert_eq!(split("MsiExec.exe /X{12345678-AAAA}"), ("MsiExec.exe".into(), "/X{12345678-AAAA}".into()));
    }

    #[test]
    fn group_ids_round_trip() {
        for group in Group::ALL {
            assert_eq!(Group::from_id(group.id()), Some(group));
        }
        assert_eq!(Group::from_id("documents"), None);
    }

    /// Looks at what this PC has; deletes nothing.
    /// `cargo test -- --ignored real_junk --nocapture`
    #[test]
    #[ignore]
    fn real_junk() {
        eprintln!("free: {} GB", free_space() / (1024 * 1024 * 1024));
        for group in Group::ALL {
            let (bytes, items) = group_size(group);
            eprintln!("{}: {} MB in {items}", group.label(), bytes / (1024 * 1024));
        }
        let (setups, big_old) = downloads();
        eprintln!("installers: {}, {} MB; biggest: {:?}", setups.len(), setups.iter().map(|f| f.size).sum::<u64>() / (1024 * 1024), setups.first().map(|f| &f.name));
        eprintln!("big old downloads: {}", big_old.len());
        let programs = super::super::pc::installed_programs();
        let removable = programs.iter().filter(|(name, _, command)| command.is_some() && refuses_uninstall(name).is_none()).count();
        eprintln!("programs: {}, removable: {removable}", programs.len());
        for (name, _, command) in programs.iter().filter(|(_, size, command)| *size > 0 && command.is_some()).take(5) {
            eprintln!("{name}: {:?}", split_command(command.as_deref().unwrap_or_default()));
        }
    }

    #[test]
    fn measures_free_space() {
        assert!(free_space() > 0);
    }
}
