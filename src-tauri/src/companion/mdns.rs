//! Announces the companion server on the local network as `_nova-companion._tcp`
//! (Windows' own DNS-SD responder, no extra library), so a paired phone finds the PC
//! again after its address changed. Only the PC id goes into the record.

#[cfg(windows)]
mod platform {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::NetworkManagement::Dns::{
        DnsServiceConstructInstance, DnsServiceDeRegister, DnsServiceFreeInstance, DnsServiceRegister, DNS_QUERY_REQUEST_VERSION1, DNS_SERVICE_INSTANCE,
        DNS_SERVICE_REGISTER_REQUEST,
    };

    /// Windows hands every completion its own copy of the instance to free.
    unsafe extern "system" fn completed(_status: u32, _context: *const core::ffi::c_void, instance: *const DNS_SERVICE_INSTANCE) {
        if !instance.is_null() {
            // SAFETY: Windows allocated it for this callback.
            unsafe { DnsServiceFreeInstance(instance) };
        }
    }

    pub struct Registration {
        request: Box<DNS_SERVICE_REGISTER_REQUEST>,
        instance: *mut DNS_SERVICE_INSTANCE,
    }

    // SAFETY: the pointers are only used again in `drop`, on whatever thread owns this.
    unsafe impl Send for Registration {}

    pub fn register(pc_id: &str, port: u16, ip4: Option<std::net::Ipv4Addr>) -> Option<Registration> {
        let computer = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "NOVA".into());
        let computer: String = computer.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(30).collect();
        let service = HSTRING::from(format!("NOVA-{computer}._nova-companion._tcp.local"));
        let host = HSTRING::from(format!("{computer}.local"));
        let key = HSTRING::from("pc");
        let value = HSTRING::from(pc_id);
        let keys = [PCWSTR(key.as_ptr())];
        let values = [PCWSTR(value.as_ptr())];
        // IP4_ADDRESS is the address in network byte order as it lies in memory.
        let address = ip4.map(|ip| u32::from_ne_bytes(ip.octets()));
        // SAFETY: all strings outlive the call, which copies them.
        let instance = unsafe {
            DnsServiceConstructInstance(&service, &host, address.as_ref().map(|a| a as *const u32), None, port, 0, 0, 1, keys.as_ptr(), values.as_ptr())
        };
        if instance.is_null() {
            return None;
        }
        let request = Box::new(DNS_SERVICE_REGISTER_REQUEST {
            Version: DNS_QUERY_REQUEST_VERSION1.0,
            InterfaceIndex: 0,
            pServiceInstance: instance,
            pRegisterCompletionCallback: Some(completed),
            ..Default::default()
        });
        // SAFETY: the request and instance stay alive in `Registration` until deregistered.
        let status = unsafe { DnsServiceRegister(&*request, None) };
        const DNS_REQUEST_PENDING: u32 = 9506;
        if status != DNS_REQUEST_PENDING && status != 0 {
            unsafe { DnsServiceFreeInstance(instance) };
            eprintln!("[NOVA] companion: mDNS announcement failed ({status})");
            return None;
        }
        Some(Registration { request, instance })
    }

    impl Drop for Registration {
        fn drop(&mut self) {
            // Deregistering finishes asynchronously and may still read the request and the
            // instance, so both are leaked rather than freed under it.
            // ponytail: ~300 bytes per companion off/on toggle; free them in the completion callback if that ever matters.
            let request: &'static DNS_SERVICE_REGISTER_REQUEST = Box::leak(std::mem::take(&mut self.request));
            let _ = self.instance;
            // SAFETY: the request that was registered, now alive for good.
            unsafe { DnsServiceDeRegister(request, None) };
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub struct Registration;

    pub fn register(_pc_id: &str, _port: u16, _ip4: Option<std::net::Ipv4Addr>) -> Option<Registration> {
        None
    }
}

pub use platform::{register, Registration};
