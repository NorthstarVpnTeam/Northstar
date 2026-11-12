//! Administrator elevation for TUN mode on Windows.
//!
//! Creating the Wintun adapter and changing the system routing table needs
//! administrator rights. When TUN mode is on and Northstar is not elevated we
//! relaunch the same executable through the Windows `runas` verb, which shows
//! the standard UAC prompt, and exit the current instance once it is accepted.

#[cfg(windows)]
pub fn is_elevated() -> bool {
    // SAFETY: IsUserAnAdmin has no arguments and only reads the current token.
    unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    true
}

/// Relaunches this executable elevated. Returns once the new process has been
/// launched; an error means the user declined UAC or the prompt could not open.
#[cfg(windows)]
pub fn relaunch_elevated() -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let exe = std::env::current_exe()
        .map_err(|error| format!("Could not locate the Northstar executable: {error}"))?;
    let operation = wide(OsStr::new("runas"));
    let file = wide(exe.as_os_str());
    // SAFETY: all strings are NUL-terminated UTF-16 and the handles are null.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize > 32 {
        Ok(())
    } else {
        Err("Administrator permission was not granted.".into())
    }
}

#[cfg(not(windows))]
pub fn relaunch_elevated() -> Result<(), String> {
    Err("TUN mode is only supported on Windows.".into())
}
