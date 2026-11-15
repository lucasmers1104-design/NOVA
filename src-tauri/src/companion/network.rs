//! Why a phone may not reach this PC, and the one fix NOVA can offer for it.
//!
//! A PC on a LAN cable is usually on the same home network as the phone in the
//! router's WLAN, so the phone can reach it. What stops it is Windows' firewall: a
//! wired network is often classed "Public", and on public networks Windows blocks
//! incoming connections unless a rule allows them. The prompt Windows shows at the
//! first start only covers private networks.
//!
//! When another program's firewall is switched on (Avast, Norton, …), it filters
//! incoming connections by its own rules and network profiles. NOVA can't read those,
//! so the check says so instead of reporting Windows' rule as the answer.
//!
//! SECURITY: the rule NOVA adds allows only NOVA's own program, only TCP on the
//! companion's port, and only from the local subnet. Windows asks for administrator
//! rights (UAC); NOVA never elevates itself, and the command has no user input.

use serde::Serialize;

/// The name of NOVA's firewall rule, also how it is found again.
pub const RULE_NAME: &str = "NOVA Companion";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    /// NOVA's rule is there, on, for this program and port.
    Ready,
    /// A public network is active and nothing allows the phone in.
    Blocked,
    /// Only private networks: Windows' own prompt may have allowed NOVA. Adding the rule doesn't hurt.
    Unsure,
    /// Another program's firewall (Avast, Norton, …) is switched on. It filters incoming
    /// connections itself, so Windows' rules don't settle it: NOVA has to be allowed there.
    OtherFirewall,
    /// Windows' firewall couldn't be asked.
    Unknown,
}

/// The verdict from what Windows reports. A third-party firewall wins over everything
/// else: NOVA can't see or change its rules, so "ready" would be a guess.
fn verdict_of(rule_ok: bool, blocks_everything: bool, public: bool, public_firewall: bool, other_firewall: bool) -> Verdict {
    if other_firewall {
        Verdict::OtherFirewall
    } else if rule_ok && !blocks_everything {
        Verdict::Ready
    } else if public && public_firewall {
        Verdict::Blocked
    } else {
        Verdict::Unsure
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCheck {
    pub verdict: Verdict,
    /// Network kinds active right now (Windows' firewall profiles).
    pub public_network: bool,
    pub private_network: bool,
    pub domain_network: bool,
    /// NOVA's rule exists (maybe for another port or program after an update).
    pub rule_present: bool,
    /// The firewall blocks every incoming connection on public networks, rules or not.
    pub blocks_everything: bool,
    /// The name Windows Security shows for another firewall that is switched on.
    pub other_firewall: Option<String>,
}

/// What the rule should say; also what `check` compares an existing rule against.
fn rule_arguments(exe: &str, port: u16, add: bool) -> String {
    let what = format!("dir=in action=allow program=\"{exe}\" protocol=TCP localport={port} remoteip=localsubnet profile=any enable=yes");
    if add {
        format!("advfirewall firewall add rule name=\"{RULE_NAME}\" {what}")
    } else {
        format!("advfirewall firewall set rule name=\"{RULE_NAME}\" new {what}")
    }
}

fn this_program() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy().to_string();
    // A quote would end the argument early; Windows paths never contain one.
    if exe.contains('"') {
        return Err("NOVA's path can't be used in a firewall rule".into());
    }
    Ok(exe)
}

#[cfg(windows)]
mod platform {
    use windows::core::BSTR;
    use windows::Win32::NetworkManagement::WindowsFirewall::{INetFwPolicy2, NetFwPolicy2, NET_FW_PROFILE2_DOMAIN, NET_FW_PROFILE2_PRIVATE, NET_FW_PROFILE2_PUBLIC};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};

    use super::{NetworkCheck, RULE_NAME};

    fn err(error: windows::core::Error) -> String {
        error.message().to_string()
    }

    pub fn other_firewall() -> Option<String> {
        let found = crate::scan::active_security_products("FirewallProduct");
        (!found.is_empty()).then(|| found.join(", "))
    }

    pub fn check(port: u16, other_firewall: Option<String>) -> Result<NetworkCheck, String> {
        let exe = super::this_program().unwrap_or_default().to_lowercase();
        crate::shell::with_com(false, || {
            // SAFETY: COM is initialized on this thread; the bindings count references.
            unsafe {
                let policy: INetFwPolicy2 = CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER).map_err(err)?;
                let active = policy.CurrentProfileTypes().map_err(err)?;
                let public = active & NET_FW_PROFILE2_PUBLIC.0 != 0;
                let private = active & NET_FW_PROFILE2_PRIVATE.0 != 0;
                let domain = active & NET_FW_PROFILE2_DOMAIN.0 != 0;
                let public_firewall = policy.get_FirewallEnabled(NET_FW_PROFILE2_PUBLIC).map(|on| on.as_bool()).unwrap_or(true);
                let blocks_everything = public && public_firewall && policy.get_BlockAllInboundTraffic(NET_FW_PROFILE2_PUBLIC).map(|on| on.as_bool()).unwrap_or(false);
                let rule = policy.Rules().ok().and_then(|rules| rules.Item(&BSTR::from(RULE_NAME)).ok());
                let rule_ok = rule.as_ref().is_some_and(|rule| {
                    let enabled = rule.Enabled().map(|on| on.as_bool()).unwrap_or(false);
                    let ports = rule.LocalPorts().map(|p| p.to_string()).unwrap_or_default();
                    let program = rule.ApplicationName().map(|p| p.to_string().to_lowercase()).unwrap_or_default();
                    enabled && ports.split(',').any(|p| p.trim() == port.to_string()) && (exe.is_empty() || program == exe)
                });
                let verdict = super::verdict_of(rule_ok, blocks_everything, public, public_firewall, other_firewall.is_some());
                Ok(NetworkCheck { verdict, public_network: public, private_network: private, domain_network: domain, rule_present: rule.is_some(), blocks_everything, other_firewall })
            }
        })
    }

    /// Runs netsh with Windows' administrator prompt, in front of `owner`, and waits for it, so
    /// the caller learns whether the rule was really made.
    pub fn run_elevated(arguments: &str, owner: Option<isize>) -> Result<(), String> {
        use windows::core::{w, HSTRING};
        use windows::Win32::Foundation::{CloseHandle, HWND, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
        use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
        let parameters = HSTRING::from(arguments);
        crate::shell::with_com(true, || {
            let mut info = SHELLEXECUTEINFOW {
                cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
                hwnd: HWND(owner.unwrap_or(0) as *mut core::ffi::c_void),
                lpVerb: w!("runas"),
                lpFile: w!("netsh.exe"),
                lpParameters: windows::core::PCWSTR(parameters.as_ptr()),
                nShow: SW_HIDE.0,
                ..Default::default()
            };
            // SAFETY: `info` and the strings it points to live for the whole call.
            if let Err(error) = unsafe { ShellExecuteExW(&mut info) } {
                // ERROR_CANCELLED: the user said no to Windows' question.
                return Err(if error.code().0 as u32 == 0x8007_04C7 {
                    "Windows asked for permission and it wasn't given. Nothing was changed.".into()
                } else {
                    format!("Windows couldn't change the firewall: {}", error.message())
                });
            }
            if info.hProcess.is_invalid() {
                return Ok(());
            }
            // SAFETY: the handle is ours (SEE_MASK_NOCLOSEPROCESS) and closed once below.
            unsafe {
                let finished = WaitForSingleObject(info.hProcess, 60_000) == WAIT_OBJECT_0;
                let mut code = 0u32;
                let read = GetExitCodeProcess(info.hProcess, &mut code).is_ok();
                let _ = CloseHandle(info.hProcess);
                match (finished, read, code) {
                    (true, true, 0) => Ok(()),
                    (false, _, _) => Err("Windows' firewall didn't answer in time.".into()),
                    (_, _, code) => Err(format!("Windows' firewall refused the rule (netsh ended with {code}).")),
                }
            }
        })
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{NetworkCheck, Verdict};

    pub fn other_firewall() -> Option<String> {
        None
    }

    pub fn check(_port: u16, other_firewall: Option<String>) -> Result<NetworkCheck, String> {
        Ok(NetworkCheck { verdict: Verdict::Unknown, public_network: false, private_network: false, domain_network: false, rule_present: false, blocks_everything: false, other_firewall })
    }

    pub fn run_elevated(_arguments: &str, _owner: Option<isize>) -> Result<(), String> {
        Err("This requires Windows".into())
    }
}

/// How things stand for a phone that wants to reach this PC on `port`.
pub fn check(port: u16) -> NetworkCheck {
    let other_firewall = platform::other_firewall();
    platform::check(port, other_firewall.clone()).unwrap_or(NetworkCheck {
        verdict: if other_firewall.is_some() { Verdict::OtherFirewall } else { Verdict::Unknown },
        public_network: false,
        private_network: false,
        domain_network: false,
        rule_present: false,
        blocks_everything: false,
        other_firewall,
    })
}

/// Adds NOVA's rule, or brings an existing one up to date (new port, NOVA moved), and says how
/// things stand afterwards. Windows asks the user for administrator rights first, in front of
/// `owner` (NOVA's window), so the question doesn't hide behind it.
pub fn allow(port: u16, owner: Option<isize>) -> Result<NetworkCheck, String> {
    let exe = this_program()?;
    let present = platform::check(port, None).map(|check| check.rule_present).unwrap_or(false);
    platform::run_elevated(&rule_arguments(&exe, port, !present), owner)?;
    Ok(check(port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rule_lets_in_only_nova_on_its_port_from_the_local_network() {
        let add = rule_arguments(r"C:\Program Files\NOVA\nova.exe", 47621, true);
        assert!(add.starts_with("advfirewall firewall add rule name=\"NOVA Companion\" dir=in action=allow"));
        for part in ["program=\"C:\\Program Files\\NOVA\\nova.exe\"", "protocol=TCP", "localport=47621", "remoteip=localsubnet", "profile=any"] {
            assert!(add.contains(part), "{part} missing in {add}");
        }
        let set = rule_arguments(r"C:\NOVA\nova.exe", 47622, false);
        assert!(set.starts_with("advfirewall firewall set rule name=\"NOVA Companion\" new dir=in"));
        assert!(set.contains("localport=47622"));
    }

    #[test]
    fn another_firewall_is_never_reported_as_ready() {
        // Windows' rule is there and fine, but Avast filters on its own.
        assert_eq!(verdict_of(true, false, true, true, true), Verdict::OtherFirewall);
        assert_eq!(verdict_of(false, false, false, false, true), Verdict::OtherFirewall);
        assert_eq!(verdict_of(true, false, true, true, false), Verdict::Ready);
        assert_eq!(verdict_of(true, true, true, true, false), Verdict::Blocked);
        assert_eq!(verdict_of(false, false, true, true, false), Verdict::Blocked);
        assert_eq!(verdict_of(false, false, false, true, false), Verdict::Unsure);
    }

    /// Asks this PC's real firewalls. `cargo test -- --ignored real_network_check --nocapture`
    #[test]
    #[ignore]
    fn real_network_check() {
        let check = check(47621);
        println!("{check:?}");
        if check.other_firewall.is_some() {
            assert_eq!(check.verdict, Verdict::OtherFirewall);
        }
    }
}
