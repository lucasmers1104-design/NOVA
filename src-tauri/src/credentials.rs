//! Secrets in Windows Credential Manager (DPAPI-protected, per user).
//! Secrets never leave the Rust side once stored.

#[cfg(windows)]
mod platform {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn set(target: &str, secret: &str) -> Result<(), String> {
        let mut target_w = wide(target);
        let mut user_w = wide("NOVA");
        let blob = secret.as_bytes();
        let credential = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target_w.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user_w.as_mut_ptr()),
            ..Default::default()
        };
        // SAFETY: all pointers reference buffers that outlive the call.
        unsafe { CredWriteW(&credential, 0) }.map_err(|e| format!("Could not save to Credential Manager: {}", e.message()))
    }

    pub fn get(target: &str) -> Result<Option<String>, String> {
        let target_w = wide(target);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: on success Windows allocates `credential`, released with CredFree below.
        let read = unsafe { CredReadW(PCWSTR(target_w.as_ptr()), CRED_TYPE_GENERIC, None, &mut credential) };
        if read.is_err() || credential.is_null() {
            return Ok(None);
        }
        let secret = unsafe {
            let c = &*credential;
            let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
            let value = String::from_utf8(bytes.to_vec()).ok();
            CredFree(credential as *const core::ffi::c_void);
            value
        };
        Ok(secret)
    }

    pub fn delete(target: &str) -> Result<(), String> {
        let target_w = wide(target);
        // SAFETY: valid NUL-terminated target name. A missing entry is not an error.
        let _ = unsafe { CredDeleteW(PCWSTR(target_w.as_ptr()), CRED_TYPE_GENERIC, None) };
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err("Secure storage requires Windows".into())
    }
    pub fn get(_: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn delete(_: &str) -> Result<(), String> {
        Ok(())
    }
}

pub use platform::{delete, get, set};

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_secret() {
        let target = format!("NOVA:test:{}", std::process::id());
        set(&target, "sk-test-123").unwrap();
        assert_eq!(get(&target).unwrap().as_deref(), Some("sk-test-123"));
        delete(&target).unwrap();
        assert_eq!(get(&target).unwrap(), None);
    }
}
