//! NOVA AI's reach beyond its own folders: the Task Manager's view of what
//! runs and what it costs, ending programs, and working other apps' windows
//! (front, close, keys, buttons). Everything that changes something goes
//! through the confirmations in `tools`; this file only does the work.

use std::time::{Duration, Instant};

use sysinfo::{CpuRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use super::tools::human_size;

/// CPU and disk rates are the difference between two samples this far apart.
const SAMPLE: Duration = Duration::from_millis(1000);
/// How long a program gets to close its windows before NOVA reports back.
const CLOSE_WAIT: Duration = Duration::from_secs(4);
const TOP: usize = 8;
const MAX_ELEMENTS: usize = 300;
const MAX_REPEAT: u32 = 200;
pub const MAX_TEXT: usize = 2000;

/// Windows itself, the security software and NOVA's own parts: ending these
/// crashes the session or NOVA instead of helping.
const PROTECTED: &[&str] = &[
    "system", "registry", "secure system", "memory compression", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsaiso", "svchost", "dwm", "fontdrvhost", "sihost", "ctfmon",
    "msmpeng", "nissrv", "securityhealthservice", "mssense", "nova", "nova-phonemize", "msedgewebview2",
];
/// Typing into these runs commands, which NOVA AI must not do.
const NO_INPUT: &[&str] = &["cmd", "powershell", "pwsh", "windowsterminal", "wt", "conhost", "openconsole", "regedit", "mmc", "bash", "wsl", "wslhost", "mintty"];

/// "Opera.EXE" → "opera".
pub fn stem(process: &str) -> String {
    let lower = process.trim().to_lowercase();
    lower.strip_suffix(".exe").map(str::to_string).unwrap_or(lower)
}

/// All instances of one program in the sample.
#[derive(Debug, Clone, PartialEq)]
pub struct AppUsage {
    pub name: String,
    pub processes: u32,
    /// Share of total CPU capacity, 0–100.
    pub cpu: f32,
    pub memory: u64,
    pub disk_per_sec: u64,
}

fn sample() -> Result<(Vec<AppUsage>, f32), String> {
    let mut sys = System::new().map_err(|e| format!("Process information isn't available: {e}"))?;
    sys.refresh_cpu_list(CpuRefreshKind::nothing());
    let kind = ProcessRefreshKind::nothing().with_cpu().with_memory().with_disk_usage();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let started = Instant::now();
    std::thread::sleep(SAMPLE);
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let seconds = started.elapsed().as_secs_f64().max(0.1);
    let cores = sys.cpus().len().max(1) as f32;
    let mut apps: Vec<AppUsage> = Vec::new();
    for process in sys.processes().values().filter(|p| p.pid().as_u32() != 0) {
        let name = stem(&process.name().to_string_lossy());
        let disk = process.disk_usage();
        let rate = ((disk.read_bytes + disk.written_bytes) as f64 / seconds) as u64;
        let cpu = (process.cpu_usage() / cores).clamp(0.0, 100.0);
        match apps.iter_mut().find(|a| a.name == name) {
            Some(app) => {
                app.processes += 1;
                app.cpu += cpu;
                app.memory += process.memory();
                app.disk_per_sec += rate;
            }
            None => apps.push(AppUsage { name, processes: 1, cpu, memory: process.memory(), disk_per_sec: rate }),
        }
    }
    Ok((apps, cores))
}

fn app_line(app: &AppUsage) -> String {
    let count = if app.processes > 1 { format!(" ({} processes)", app.processes) } else { String::new() };
    format!("{}{count}: CPU {:.1} %, RAM {}, disk {}/s", app.name, app.cpu, human_size(app.memory as i64), human_size(app.disk_per_sec as i64))
}

/// The heaviest programs per resource, for the model to read.
pub fn top_lists(apps: &[AppUsage]) -> String {
    let list = |title: &str, score: &dyn Fn(&AppUsage) -> f64| {
        let mut sorted: Vec<&AppUsage> = apps.iter().filter(|a| score(a) > 0.0).collect();
        sorted.sort_by(|a, b| score(b).total_cmp(&score(a)));
        let lines: Vec<String> = sorted.iter().take(TOP).map(|a| format!("- {}", app_line(a))).collect();
        format!("{title}:\n{}", if lines.is_empty() { "- nothing measurable".to_string() } else { lines.join("\n") })
    };
    [list("Highest CPU", &|a| a.cpu as f64), list("Highest memory", &|a| a.memory as f64), list("Highest disk activity", &|a| a.disk_per_sec as f64)].join("\n\n")
}

/// What the Task Manager would show right now. Blocks for about a second.
pub fn task_manager(overview: &serde_json::Value, volumes: &[String]) -> Result<(String, String), String> {
    let (apps, cores) = sample()?;
    let now = &overview["now"];
    let gib = |v: &serde_json::Value| v.as_f64().unwrap_or(0.0) / 1_073_741_824.0;
    let total_cpu: f32 = apps.iter().map(|a| a.cpu).sum();
    let mut lines = vec![format!(
        "Whole PC: CPU {:.0} % ({cores} logical cores), RAM {:.1} of {:.1} GB, swap {:.1} of {:.1} GB",
        now["cpuUsage"].as_f64().unwrap_or(total_cpu as f64),
        gib(&now["memoryUsed"]),
        gib(&now["memoryTotal"]),
        gib(&now["swapUsed"]),
        gib(&now["swapTotal"]),
    )];
    for gpu in now["gpus"].as_array().into_iter().flatten() {
        let usage = gpu["usage"].as_f64().map_or("usage unknown".to_string(), |u| format!("{u:.0} %"));
        let memory = gpu["memoryUsed"].as_f64().map_or(String::new(), |m| format!(", {:.1} GB video memory", m / 1_073_741_824.0));
        lines.push(format!("GPU {}: {usage}{memory}", gpu["name"].as_str().unwrap_or("?")));
    }
    if !volumes.is_empty() {
        lines.push(format!("Drives: {}", volumes.join("; ")));
    }
    let hung: Vec<String> = win::windows().into_iter().filter(|w| w.hung).map(|w| format!("{} ({})", w.title, w.process)).collect();
    if !hung.is_empty() {
        lines.push(format!("Not responding: {}", hung.join("; ")));
    }
    lines.push(String::new());
    lines.push(top_lists(&apps));
    lines.push("\nPer-program GPU use isn't available. Sizes on disk: use installed_programs.".into());
    let busiest = apps.iter().max_by(|a, b| a.cpu.total_cmp(&b.cpu)).map_or_else(String::new, |a| format!(" · most CPU: {} ({:.0} %)", a.name, a.cpu));
    Ok((lines.join("\n"), format!("{} programs running{busiest}", apps.len())))
}

/// The processes `wanted` means, by process id or program name.
pub fn pick_processes(all: &[(u32, String)], wanted: &str) -> Result<(String, Vec<u32>), String> {
    let wanted = wanted.trim();
    if let Ok(pid) = wanted.parse::<u32>() {
        let (_, name) = all.iter().find(|(p, _)| *p == pid).ok_or_else(|| format!("No process has the id {pid}. Check task_manager."))?;
        return Ok((name.clone(), vec![pid]));
    }
    let wanted = stem(wanted);
    let matching = |name: &str| all.iter().filter(|(_, n)| n == name).map(|(p, _)| *p).collect::<Vec<u32>>();
    let exact = matching(&wanted);
    if !exact.is_empty() {
        return Ok((wanted, exact));
    }
    let mut similar: Vec<&str> = all.iter().map(|(_, n)| n.as_str()).filter(|n| n.contains(wanted.as_str())).collect();
    similar.sort_unstable();
    similar.dedup();
    match similar.as_slice() {
        [] => Err(format!("No running program is called “{wanted}”. Check task_manager.")),
        [one] => Ok((one.to_string(), matching(one))),
        many => Err(format!("Several programs match “{wanted}”: {}. Ask which one.", many.join(", "))),
    }
}

pub fn is_protected(name: &str) -> bool {
    PROTECTED.contains(&stem(name).as_str())
}

/// Running processes as (id, program name), without NOVA itself.
pub fn processes() -> Result<Vec<(u32, String)>, String> {
    let mut sys = System::new().map_err(|e| format!("Process information isn't available: {e}"))?;
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let own = std::process::id();
    Ok(sys.processes().values().map(|p| (p.pid().as_u32(), stem(&p.name().to_string_lossy()))).filter(|(pid, _)| *pid != own && *pid != 0).collect())
}

/// Ends a program: its windows are asked to close (so it can save); what has
/// no window, or everything with `force`, is terminated.
pub fn end_processes(name: &str, pids: &[u32], force: bool) -> Result<String, String> {
    // Only what is still that program: a process id can be reused.
    let alive = |pids: &[u32]| -> Result<Vec<u32>, String> { Ok(processes()?.into_iter().filter(|(p, n)| n == name && pids.contains(p)).map(|(p, _)| p).collect()) };
    let targets = alive(pids)?;
    if targets.is_empty() {
        return Ok(format!("{name} isn't running anymore."));
    }
    let asked = if force { 0 } else { win::close_windows_of(&targets) };
    if asked > 0 {
        let started = Instant::now();
        while started.elapsed() < CLOSE_WAIT && !alive(&targets)?.is_empty() {
            std::thread::sleep(Duration::from_millis(200));
        }
        let left = alive(&targets)?;
        return Ok(if left.is_empty() {
            format!("{name} closed.")
        } else if win::windows().iter().any(|w| left.contains(&w.pid)) {
            format!("{name} was asked to close but is still open; it may be asking about unsaved work. Tell the user, and offer to force it only if they want that.")
        } else {
            format!("{name}'s windows are closed; {} background process(es) keep running. Forcing would end them too.", left.len())
        });
    }
    let mut sys = System::new().map_err(|e| e.to_string())?;
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let mut denied = 0;
    for pid in &targets {
        if !sys.process(Pid::from_u32(*pid)).is_some_and(|p| p.kill()) {
            denied += 1;
        }
    }
    std::thread::sleep(Duration::from_millis(300));
    let left = alive(&targets)?.len();
    match (left, denied) {
        (0, _) => Ok(format!("{name} ended ({} process(es)).", targets.len())),
        _ => Err(format!("{left} of {} {name} process(es) keep running. Windows didn't allow ending them; they probably run with administrator rights.", targets.len())),
    }
}

// ---------------------------------------------------------------------------
// Other apps' windows
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub title: String,
    /// Program name without ".exe", lower case.
    pub process: String,
    pub pid: u32,
    pub hung: bool,
    pub minimized: bool,
    pub foreground: bool,
}

/// A window a tool call means, re-checked before anything is done to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub hwnd: isize,
    pub pid: u32,
    pub label: String,
}

/// `wanted`: a window id from list_windows, a program name or part of a title.
/// Several fit: the one nearest the top of the screen.
pub fn pick_window(windows: &[WindowInfo], wanted: &str) -> Result<Target, String> {
    let wanted = wanted.trim().trim_start_matches('#').to_lowercase();
    let id = wanted.parse::<isize>().ok();
    let program = stem(&wanted);
    let found = windows
        .iter()
        .find(|w| Some(w.hwnd) == id)
        .or_else(|| windows.iter().find(|w| w.process == program))
        .or_else(|| windows.iter().find(|w| w.title.to_lowercase().contains(&wanted)))
        .or_else(|| windows.iter().find(|w| w.process.contains(&program)));
    let window = found.ok_or_else(|| format!("No open window matches “{wanted}”. Check list_windows; if the app isn't running, start it with open_app."))?;
    let name: String = window.title.chars().take(60).collect();
    Ok(Target { hwnd: window.hwnd, pid: window.pid, label: format!("{name} ({})", window.process) })
}

pub fn accepts_input(process_label: &str) -> bool {
    !NO_INPUT.iter().any(|name| process_label.ends_with(&format!("({name})")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowVerb {
    Focus,
    Minimize,
    Maximize,
    Restore,
    Close,
}

/// One key press with its modifiers, as virtual-key codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub modifiers: Vec<u16>,
    pub key: u16,
    pub extended: bool,
}

/// "ctrl+shift+w", "enter", "f5". The Windows key is refused: with it, keys
/// would reach Windows itself (Run, Start) instead of the chosen window.
pub fn parse_combo(raw: &str) -> Result<Combo, String> {
    let mut modifiers = Vec::new();
    let mut key = None;
    for part in raw.split('+').map(|p| p.trim().to_lowercase()) {
        match part.as_str() {
            "ctrl" | "control" | "strg" => modifiers.push(0x11),
            "shift" => modifiers.push(0x10),
            "alt" => modifiers.push(0x12),
            "win" | "windows" | "meta" | "cmd" | "super" => return Err("The Windows key can't be used: keys only go to the chosen window".into()),
            _ if key.is_some() => return Err(format!("“{raw}” has more than one main key")),
            name => key = Some(key_code(name).ok_or_else(|| format!("“{name}” isn't a key NOVA knows"))?),
        }
    }
    let (key, extended) = key.ok_or_else(|| format!("“{raw}” has no main key"))?;
    Ok(Combo { modifiers, key, extended })
}

fn key_code(name: &str) -> Option<(u16, bool)> {
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return match c {
            'a'..='z' => Some((c.to_ascii_uppercase() as u16, false)),
            '0'..='9' => Some((c as u16, false)),
            _ => None,
        };
    }
    if let Some(number) = name.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()).filter(|n| (1..=24).contains(n)) {
        return Some((0x6F + number, false));
    }
    Some(match name {
        "enter" | "return" => (0x0D, false),
        "esc" | "escape" => (0x1B, false),
        "tab" => (0x09, false),
        "space" => (0x20, false),
        "backspace" => (0x08, false),
        "delete" | "del" => (0x2E, true),
        "insert" | "ins" => (0x2D, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "pageup" => (0x21, true),
        "pagedown" => (0x22, true),
        "left" => (0x25, true),
        "up" => (0x26, true),
        "right" => (0x27, true),
        "down" => (0x28, true),
        _ => return None,
    })
}

pub fn clamp_repeat(repeat: u64) -> u32 {
    repeat.clamp(1, MAX_REPEAT as u64) as u32
}

/// What `read_window` found, for the model. Tabs come first, so it can count them.
pub fn element_lines(elements: &[(String, String, Option<String>)]) -> String {
    let tabs = elements.iter().filter(|(kind, ..)| kind == "tab").count();
    let mut sorted: Vec<&(String, String, Option<String>)> = elements.iter().collect();
    sorted.sort_by_key(|(kind, ..)| kind != "tab");
    let mut lines = Vec::new();
    if tabs > 0 {
        lines.push(format!("{tabs} open tab(s)."));
    }
    lines.extend(sorted.iter().map(|(kind, name, value)| match value {
        Some(value) => format!("[{kind}] {name} = {value}"),
        None => format!("[{kind}] {name}"),
    }));
    lines.join("\n")
}

pub use win::{installed_programs, read_window, send_input, use_element, window_action, windows};

#[cfg(windows)]
mod win {
    use std::time::{Duration, Instant};

    use windows::core::{w, BOOL, BSTR, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HWND, LPARAM, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern, IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationValuePattern, TreeScope_Descendants,
        UIA_InvokePatternId, UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetAncestor, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowTextW, GetWindowThreadProcessId, IsHungAppWindow, IsIconic, IsWindow, IsWindowVisible, PostMessageW,
        SetForegroundWindow, ShowWindow, GA_ROOT, GWL_EXSTYLE, GW_OWNER, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WM_CLOSE, WS_EX_TOOLWINDOW,
    };

    use super::{Combo, Target, WindowInfo, WindowVerb, MAX_ELEMENTS};

    fn handle(raw: isize) -> HWND {
        HWND(raw as *mut core::ffi::c_void)
    }

    fn process_name(pid: u32) -> String {
        // SAFETY: the handle is closed below; the buffer outlives the call.
        unsafe {
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
            let mut buffer = [0u16; 1024];
            let mut len = buffer.len() as u32;
            let done = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut len);
            let _ = CloseHandle(process);
            if done.is_err() {
                return String::new();
            }
            let path = String::from_utf16_lossy(&buffer[..len as usize]);
            super::stem(path.rsplit('\\').next().unwrap_or_default())
        }
    }

    /// The windows a person sees (top of the screen first), without NOVA's own.
    pub fn windows() -> Vec<WindowInfo> {
        unsafe extern "system" fn collect(window: HWND, list: LPARAM) -> BOOL {
            // SAFETY: `list` is the Vec below, alive for the whole EnumWindows call.
            unsafe { (*(list.0 as *mut Vec<isize>)).push(window.0 as isize) };
            BOOL(1)
        }
        let mut raw: Vec<isize> = Vec::new();
        // SAFETY: the callback only pushes into `raw`, which outlives the call.
        let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut raw as *mut Vec<isize> as isize)) };
        // SAFETY: plain queries on handles; a window that has gone away just fails them.
        let foreground = unsafe { GetForegroundWindow() }.0 as isize;
        raw.into_iter()
            .filter_map(|id| unsafe {
                let window = handle(id);
                if !IsWindowVisible(window).as_bool() || GetWindow(window, GW_OWNER).is_ok_and(|owner| !owner.0.is_null()) || GetWindowLongPtrW(window, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
                    return None;
                }
                let mut cloaked = 0u32;
                let _ = DwmGetWindowAttribute(window, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), size_of::<u32>() as u32);
                if cloaked != 0 {
                    return None;
                }
                let mut buffer = [0u16; 256];
                let len = GetWindowTextW(window, &mut buffer);
                let title = String::from_utf16_lossy(&buffer[..len.max(0) as usize]);
                if title.trim().is_empty() {
                    return None;
                }
                let mut pid = 0u32;
                GetWindowThreadProcessId(window, Some(&mut pid));
                if pid == std::process::id() {
                    return None;
                }
                Some(WindowInfo { hwnd: id, title, process: process_name(pid), pid, hung: IsHungAppWindow(window).as_bool(), minimized: IsIconic(window).as_bool(), foreground: id == foreground })
            })
            .collect()
    }

    /// Asks every window of these processes to close; how many were asked.
    pub fn close_windows_of(pids: &[u32]) -> usize {
        let targets: Vec<WindowInfo> = windows().into_iter().filter(|w| pids.contains(&w.pid)).collect();
        for window in &targets {
            // SAFETY: posting a message to a handle is safe even if it has just gone away.
            let _ = unsafe { PostMessageW(Some(handle(window.hwnd)), WM_CLOSE, WPARAM(0), LPARAM(0)) };
        }
        targets.len()
    }

    /// The window is still there and still belongs to the same program.
    fn check(target: &Target) -> Result<HWND, String> {
        let window = handle(target.hwnd);
        let mut pid = 0u32;
        // SAFETY: plain queries on a handle that may have gone away.
        let same = unsafe {
            GetWindowThreadProcessId(window, Some(&mut pid));
            IsWindow(Some(window)).as_bool() && pid == target.pid
        };
        if same { Ok(window) } else { Err(format!("{} was closed in the meantime", target.label)) }
    }

    fn is_foreground(window: HWND) -> bool {
        // SAFETY: plain queries.
        unsafe { GetAncestor(GetForegroundWindow(), GA_ROOT) == window }
    }

    /// Brings the window to the front; Windows only allows this while attached
    /// to the input of the window that is in front now.
    fn bring_to_front(window: HWND) -> Result<(), String> {
        // Attaching to its input would drop keys still on their way to it.
        if is_foreground(window) {
            return Ok(());
        }
        // SAFETY: the thread input is detached again right after; handles are only queried.
        unsafe {
            if IsIconic(window).as_bool() {
                let _ = ShowWindow(window, SW_RESTORE);
            }
            let current = GetCurrentThreadId();
            let front = GetWindowThreadProcessId(GetForegroundWindow(), None);
            let attached = front != 0 && front != current && AttachThreadInput(current, front, true).as_bool();
            let _ = BringWindowToTop(window);
            let _ = SetForegroundWindow(window);
            if attached {
                let _ = AttachThreadInput(current, front, false);
            }
        }
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(800) {
            if is_foreground(window) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        Err("Windows didn't let NOVA bring that window to the front, so nothing was typed. Ask the user to click it once.".into())
    }

    pub fn window_action(target: &Target, verb: WindowVerb) -> Result<(), String> {
        let window = check(target)?;
        // SAFETY: plain calls on a checked handle.
        unsafe {
            match verb {
                WindowVerb::Focus => return bring_to_front(window),
                WindowVerb::Minimize => {
                    let _ = ShowWindow(window, SW_MINIMIZE);
                }
                WindowVerb::Maximize => {
                    let _ = ShowWindow(window, SW_MAXIMIZE);
                }
                WindowVerb::Restore => {
                    let _ = ShowWindow(window, SW_RESTORE);
                }
                WindowVerb::Close => PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0)).map_err(|e| e.to_string())?,
            }
        }
        Ok(())
    }

    fn key(code: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(code), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
    }

    fn send(events: &[INPUT]) -> Result<(), String> {
        // SAFETY: the slice is valid for the call and the size matches INPUT.
        let sent = unsafe { SendInput(events, size_of::<INPUT>() as i32) };
        if sent as usize == events.len() { Ok(()) } else { Err("Windows blocked the keys. The app probably runs with administrator rights.".into()) }
    }

    fn combo_events(combo: &Combo) -> Vec<INPUT> {
        let extended = if combo.extended { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) };
        let mut events: Vec<INPUT> = combo.modifiers.iter().map(|m| key(*m, 0, KEYBD_EVENT_FLAGS(0))).collect();
        events.push(key(combo.key, 0, extended));
        events.push(key(combo.key, 0, extended | KEYEVENTF_KEYUP));
        events.extend(combo.modifiers.iter().rev().map(|m| key(*m, 0, KEYEVENTF_KEYUP)));
        events
    }

    /// Brings the window up, then sends keys and text. Checked before each step:
    /// keys never land in another window when the user switches away. Returns
    /// how many key presses were sent.
    pub fn send_input(target: &Target, combos: &[Combo], repeat: u32, text: Option<&str>) -> Result<u32, String> {
        let window = check(target)?;
        bring_to_front(window)?;
        // The app needs a moment before it takes keys.
        std::thread::sleep(Duration::from_millis(120));
        let mut sent = 0;
        for _ in 0..repeat {
            for combo in combos {
                // A window that closed itself (the last tab) is done, not an error.
                if sent > 0 && check(target).is_err() {
                    return Ok(sent);
                }
                if !is_foreground(window) {
                    return Err(format!("Stopped after {sent} key press(es): another window came to the front"));
                }
                send(&combo_events(combo))?;
                sent += 1;
                std::thread::sleep(Duration::from_millis(70));
            }
        }
        if let Some(text) = text {
            if !is_foreground(window) {
                return Err("Stopped before typing: another window came to the front".into());
            }
            let events: Vec<INPUT> = text
                .encode_utf16()
                .flat_map(|unit| [key(0, unit, KEYEVENTF_UNICODE), key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)])
                .collect();
            send(&events)?;
            // Whatever comes next (reading it back, more keys) comes after the app has taken this in.
            std::thread::sleep(Duration::from_millis(200));
        }
        Ok(sent)
    }

    fn automation() -> Result<IUIAutomation, String> {
        // SAFETY: standard COM activation; the caller initialized COM.
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.map_err(|e| format!("Windows UI Automation isn't available: {e}"))
    }

    fn kind_name(id: i32) -> Option<&'static str> {
        Some(match id {
            50000 | 50031 => "button",
            50002 => "checkbox",
            50003 => "dropdown",
            50004 => "input",
            50005 => "link",
            50007 => "item",
            50011 => "menu",
            50013 => "radio",
            50015 => "slider",
            50019 => "tab",
            50020 => "text",
            50024 => "tree",
            50029 => "cell",
            50030 => "document",
            _ => return None,
        })
    }

    /// Every element of interest in the window: (kind, name, value, element).
    #[allow(clippy::type_complexity)]
    fn elements(target: &Target) -> Result<Vec<(String, String, Option<String>, IUIAutomationElement)>, String> {
        let window = check(target)?;
        let automation = automation()?;
        let fail = |e: windows::core::Error| format!("Couldn't read {}: {e}", target.label);
        // SAFETY: COM calls on interfaces owned here.
        unsafe {
            let root = automation.ElementFromHandle(window).map_err(fail)?;
            let all = root.FindAll(TreeScope_Descendants, &automation.CreateTrueCondition().map_err(fail)?).map_err(fail)?;
            let mut found = Vec::new();
            for index in 0..all.Length().map_err(fail)? {
                let Ok(element) = all.GetElement(index) else { continue };
                let Some(kind) = element.CurrentControlType().ok().and_then(|id| kind_name(id.0)) else { continue };
                let name = element.CurrentName().map(|n| n.to_string()).unwrap_or_default();
                let value = element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).ok().and_then(|p| p.CurrentValue().ok()).map(|v| v.to_string()).filter(|v| !v.is_empty());
                if name.trim().is_empty() && value.is_none() {
                    continue;
                }
                found.push((kind.to_string(), name.chars().take(160).collect(), value.map(|v| v.chars().take(300).collect()), element));
                if found.len() >= MAX_ELEMENTS {
                    break;
                }
            }
            Ok(found)
        }
    }

    pub fn read_window(target: &Target) -> Result<Vec<(String, String, Option<String>)>, String> {
        Ok(elements(target)?.into_iter().map(|(kind, name, value, _)| (kind, name, value)).collect())
    }

    /// Presses a button, selects a tab or item, flips a checkbox, or fills a field.
    pub fn use_element(target: &Target, name: &str, kind: Option<&str>, nth: usize, text: Option<&str>) -> Result<String, String> {
        let lower = name.to_lowercase();
        let found = elements(target)?;
        let fits = |wanted_exact: bool| {
            found
                .iter()
                .filter(|(k, n, ..)| kind.is_none_or(|kind| kind == k) && if wanted_exact { n.to_lowercase() == lower } else { n.to_lowercase().contains(&lower) })
                .collect::<Vec<_>>()
        };
        let exact = fits(true);
        let candidates = if exact.is_empty() { fits(false) } else { exact };
        let (kind_found, name_found, _, element) = *candidates.get(nth).ok_or_else(|| format!("No element “{name}” in {}. Use read_window to see what's there.", target.label))?;
        // SAFETY: COM calls on interfaces owned here.
        unsafe {
            if let Some(text) = text {
                let pattern = element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).map_err(|_| format!("“{name_found}” can't take text. Try send_input."))?;
                pattern.SetValue(&BSTR::from(text)).map_err(|e| format!("Couldn't fill “{name_found}”: {e}"))?;
                return Ok(format!("Filled “{name_found}”"));
            }
            if let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                pattern.Invoke().map_err(|e| format!("Couldn't press “{name_found}”: {e}"))?;
            } else if let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
                pattern.Select().map_err(|e| format!("Couldn't select “{name_found}”: {e}"))?;
            } else if let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
                pattern.Toggle().map_err(|e| format!("Couldn't switch “{name_found}”: {e}"))?;
            } else {
                return Err(format!("“{name_found}” ({kind_found}) can't be pressed from outside. Try send_input."));
            }
        }
        Ok(format!("Used “{name_found}”"))
    }

    fn read_string(key: HKEY, name: PCWSTR) -> Option<String> {
        let mut buffer = [0u16; 512];
        let mut size = (buffer.len() * 2) as u32;
        // SAFETY: the buffer and its size in bytes are passed together.
        let result = unsafe { RegGetValueW(key, PCWSTR::null(), name, RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut size)) };
        (result == ERROR_SUCCESS).then(|| String::from_utf16_lossy(&buffer[..(size as usize / 2).saturating_sub(1)]))
    }

    /// Programs from the Windows uninstall list with the size they report, biggest first.
    pub fn installed_programs() -> Vec<(String, u64)> {
        let roots = [
            (HKEY_LOCAL_MACHINE, w!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall")),
            (HKEY_LOCAL_MACHINE, w!("SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall")),
            (HKEY_CURRENT_USER, w!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall")),
        ];
        let mut programs: Vec<(String, u64)> = Vec::new();
        for (hive, path) in roots {
            let mut root = HKEY::default();
            // SAFETY: valid strings and out pointers; every opened key is closed.
            unsafe {
                if RegOpenKeyExW(hive, path, None, KEY_READ, &mut root) != ERROR_SUCCESS {
                    continue;
                }
                for index in 0.. {
                    let mut name = [0u16; 256];
                    let mut len = name.len() as u32;
                    if RegEnumKeyExW(root, index, Some(PWSTR(name.as_mut_ptr())), &mut len, None, Some(PWSTR::null()), None, None) != ERROR_SUCCESS {
                        break;
                    }
                    let mut entry = HKEY::default();
                    if RegOpenKeyExW(root, PCWSTR(name.as_ptr()), None, KEY_READ, &mut entry) != ERROR_SUCCESS {
                        continue;
                    }
                    let shown = read_string(entry, w!("DisplayName"));
                    let mut kilobytes = 0u32;
                    let mut size = size_of::<u32>() as u32;
                    let _ = RegGetValueW(entry, PCWSTR::null(), w!("EstimatedSize"), RRF_RT_REG_DWORD, None, Some((&mut kilobytes as *mut u32).cast()), Some(&mut size));
                    let _ = RegCloseKey(entry);
                    if let Some(shown) = shown.filter(|s| !s.trim().is_empty()) {
                        if !programs.iter().any(|(n, _)| *n == shown) {
                            programs.push((shown, kilobytes as u64 * 1024));
                        }
                    }
                }
                let _ = RegCloseKey(root);
            }
        }
        programs.sort_by_key(|program| std::cmp::Reverse(program.1));
        programs
    }
}

#[cfg(not(windows))]
mod win {
    use super::{Combo, Target, WindowInfo, WindowVerb};
    const NO: &str = "This requires Windows";
    pub fn windows() -> Vec<WindowInfo> { Vec::new() }
    pub fn close_windows_of(_: &[u32]) -> usize { 0 }
    pub fn window_action(_: &Target, _: WindowVerb) -> Result<(), String> { Err(NO.into()) }
    pub fn send_input(_: &Target, _: &[Combo], _: u32, _: Option<&str>) -> Result<u32, String> { Err(NO.into()) }
    pub fn read_window(_: &Target) -> Result<Vec<(String, String, Option<String>)>, String> { Err(NO.into()) }
    pub fn use_element(_: &Target, _: &str, _: Option<&str>, _: usize, _: Option<&str>) -> Result<String, String> { Err(NO.into()) }
    pub fn installed_programs() -> Vec<(String, u64)> { Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(hwnd: isize, title: &str, process: &str) -> WindowInfo {
        WindowInfo { hwnd, title: title.into(), process: process.into(), pid: hwnd as u32, hung: false, minimized: false, foreground: false }
    }

    #[test]
    fn finds_processes_by_id_and_name() {
        let all = vec![(1, "opera".to_string()), (2, "opera".to_string()), (3, "operacrashreporter".to_string()), (4, "code".to_string())];
        assert_eq!(pick_processes(&all, "Opera.exe").unwrap(), ("opera".to_string(), vec![1, 2]));
        assert_eq!(pick_processes(&all, "4").unwrap(), ("code".to_string(), vec![4]));
        assert_eq!(pick_processes(&all, "cod").unwrap().0, "code");
        assert!(pick_processes(&all, "oper").unwrap_err().contains("Several"));
        assert!(pick_processes(&all, "nothing").is_err());
        assert!(pick_processes(&all, "99").is_err());
    }

    #[test]
    fn protects_windows_and_nova() {
        for name in ["csrss.exe", "LSASS", "svchost", "nova.exe", "msedgewebview2.exe"] {
            assert!(is_protected(name), "{name}");
        }
        assert!(!is_protected("opera.exe"));
    }

    #[test]
    fn picks_windows_by_id_program_and_title() {
        let windows = [window(10, "Rechnung - Word", "winword"), window(20, "YouTube – Opera", "opera"), window(30, "Mail – Opera", "opera")];
        assert_eq!(pick_window(&windows, "opera").unwrap().hwnd, 20, "the topmost of a program");
        assert_eq!(pick_window(&windows, "#30").unwrap().hwnd, 30);
        assert_eq!(pick_window(&windows, "rechnung").unwrap().hwnd, 10);
        assert_eq!(pick_window(&windows, "WINWORD.exe").unwrap().hwnd, 10);
        assert!(pick_window(&windows, "spotify").is_err());
    }

    #[test]
    fn terminals_take_no_input() {
        assert!(!accepts_input("Administrator: cmd (cmd)"));
        assert!(!accepts_input("Windows PowerShell (powershell)"));
        assert!(accepts_input("YouTube – Opera (opera)"));
    }

    #[test]
    fn parses_key_combinations() {
        assert_eq!(parse_combo("ctrl+w").unwrap(), Combo { modifiers: vec![0x11], key: 0x57, extended: false });
        assert_eq!(parse_combo("Ctrl + Shift + T").unwrap().modifiers, vec![0x11, 0x10]);
        assert_eq!(parse_combo("f5").unwrap().key, 0x74);
        assert_eq!(parse_combo("f24").unwrap().key, 0x87);
        assert!(parse_combo("delete").unwrap().extended);
        assert!(parse_combo("win+r").unwrap_err().contains("Windows key"));
        assert!(parse_combo("ctrl").is_err());
        assert!(parse_combo("a+b").is_err());
        assert!(parse_combo("explode").is_err());
        assert_eq!(clamp_repeat(0), 1);
        assert_eq!(clamp_repeat(10_000), MAX_REPEAT);
    }

    #[test]
    fn lists_put_the_heaviest_first_and_tabs_on_top() {
        let app = |name: &str, cpu, memory, disk| AppUsage { name: name.into(), processes: 2, cpu, memory, disk_per_sec: disk };
        let text = top_lists(&[app("small", 1.0, 10, 0), app("game", 60.0, 5_000_000_000, 1000), app("opera", 5.0, 9_000_000_000, 0)]);
        let memory = text.split("Highest memory").nth(1).unwrap();
        assert!(text.find("game").unwrap() < text.find("opera").unwrap());
        assert!(memory.find("opera").unwrap() < memory.find("game").unwrap());
        let lines = element_lines(&[("button".into(), "OK".into(), None), ("tab".into(), "YouTube".into(), None), ("input".into(), "Adresse".into(), Some("nova.dev".into()))]);
        assert!(lines.starts_with("1 open tab(s).\n[tab] YouTube"));
        assert!(lines.contains("[input] Adresse = nova.dev"));
    }

    #[test]
    fn measures_the_programs_running_now() {
        let (apps, cores) = sample().unwrap();
        assert!(cores >= 1.0 && apps.len() > 3);
        assert!(apps.iter().any(|a| a.memory > 0));
        assert!(top_lists(&apps).contains("Highest memory"));
    }

    /// Against the real desktop: a small test window of its own is typed into, read
    /// back, clicked and closed; then a background process is ended. Takes over the
    /// keyboard for a moment, so only by hand: `cargo test -- --ignored drives_a_real_window`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn drives_a_real_window() {
        const FORM: &str = "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object Windows.Forms.Form; $f.Text='NOVA Test'; $t=New-Object Windows.Forms.TextBox; $t.Name='Feld'; $t.AccessibleName='Feld'; $t.Width=200; $b=New-Object Windows.Forms.Button; $b.Text='Klick'; $b.Top=40; $b.Add_Click({$f.Text='NOVA geklickt'}); $f.Controls.Add($t); $f.Controls.Add($b); [void]$f.ShowDialog()";
        let mut child = std::process::Command::new("powershell.exe").args(["-NoProfile", "-Command", FORM]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        std::thread::sleep(Duration::from_secs(5));
        let target = pick_window(&windows(), "NOVA Test").unwrap();
        crate::shell::with_com(false, || {
            send_input(&target, &[], 1, Some("Hallo von NOVA"))?;
            send_input(&target, &[parse_combo("backspace")?], 4, None)?;
            std::thread::sleep(Duration::from_millis(400));
            let found = read_window(&target)?;
            assert!(found.iter().any(|(_, _, value)| value.as_deref() == Some("Hallo von ")), "{found:?}");
            use_element(&target, "Feld", Some("input"), 0, Some("gefüllt"))?;
            assert!(read_window(&target)?.iter().any(|(_, _, value)| value.as_deref() == Some("gefüllt")));
            use_element(&target, "Klick", None, 0, None)?;
            let clicked = Instant::now();
            while !windows().iter().any(|w| w.title == "NOVA geklickt") {
                assert!(clicked.elapsed() < Duration::from_secs(5), "the button was pressed");
                std::thread::sleep(Duration::from_millis(100));
            }
            window_action(&target, WindowVerb::Close)
        })
        .inspect_err(|_| drop(child.kill()))
        .unwrap();
        for _ in 0..150 {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let closed = child.try_wait().unwrap().is_some();
        let _ = child.kill();
        assert!(closed, "the window closed and its program ended");

        let mut background = std::process::Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(end_processes("ping", &[background.id()], false).unwrap().contains("ended"));
        assert!(background.wait().is_ok());
    }
}
