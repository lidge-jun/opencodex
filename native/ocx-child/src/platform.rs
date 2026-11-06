use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{Ordering, compiler_fence};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// Zeroes sensitive heap bytes on drop using volatile writes so the compiler cannot elide scrubbing.
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        volatile_zero_bytes(&mut self.0);
    }
}

pub fn volatile_zero_bytes(buf: &mut [u8]) {
    for byte in buf.iter_mut() {
        // SAFETY: `byte` is a valid mutable reference to an initialized `u8` inside `buf`.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex_encode(&sha256_bytes(data))
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const LUT: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(LUT[(b >> 4) as usize] as char);
        out.push(LUT[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn hex_decode_lower(input: &str) -> Option<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(input.len() / 2);
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_nibble_lower(bytes[i])?;
        let lo = hex_nibble_lower(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Some(out)
}

fn hex_nibble_lower(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(1_760_000_000_000)
}

/// Formats epoch milliseconds as ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
pub fn format_iso8601_utc(epoch_ms: u64) -> String {
    let total_secs = (epoch_ms / 1000) as i64;
    let millis = epoch_ms % 1000;
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400) as u32;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    // Howard Hinnant civil_from_days algorithm
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(unix)]
unsafe extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
    fn setsid() -> i32;
    fn kill(pid: i32, sig: i32) -> i32;
}

#[cfg(windows)]
#[repr(C)]
struct Overlapped {
    internal: usize,
    internal_high: usize,
    offset: u32,
    offset_high: u32,
    event: *mut std::ffi::c_void,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LockFileEx(
        file: *mut std::ffi::c_void,
        flags: u32,
        reserved: u32,
        bytes_low: u32,
        bytes_high: u32,
        overlapped: *mut Overlapped,
    ) -> i32;
    fn UnlockFileEx(
        file: *mut std::ffi::c_void,
        reserved: u32,
        bytes_low: u32,
        bytes_high: u32,
        overlapped: *mut Overlapped,
    ) -> i32;
    fn OpenProcess(
        desired_access: u32,
        inherit_handle: i32,
        process_id: u32,
    ) -> *mut std::ffi::c_void;
    fn TerminateProcess(process: *mut std::ffi::c_void, exit_code: u32) -> i32;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    fn CloseHandle(object: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(
        algorithm: *mut std::ffi::c_void,
        buffer: *mut u8,
        bytes: u32,
        flags: u32,
    ) -> i32;
}

pub fn fill_random_bytes(dest: &mut [u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut f =
            File::open("/dev/urandom").map_err(|e| format!("failed to open /dev/urandom: {e}"))?;
        f.read_exact(dest)
            .map_err(|e| format!("failed to read /dev/urandom: {e}"))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
        // SAFETY: `dest` is a valid mutable slice of `dest.len()` bytes.
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                dest.as_mut_ptr(),
                dest.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            return Err(format!(
                "BCryptGenRandom failed with NTSTATUS 0x{status:08x}"
            ));
        }
        Ok(())
    }
}

pub fn random_hex(byte_len: usize) -> Result<String, String> {
    let mut buf = vec![0u8; byte_len];
    fill_random_bytes(&mut buf)?;
    Ok(hex_encode(&buf))
}

pub fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(format!("refusing symlinked path: {}", path.display()))
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to inspect {}: {e}", path.display())),
    }
}

pub fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    reject_symlink(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        if !dir.exists() {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true).mode(0o700);
            builder
                .create(dir)
                .map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
        }
        reject_symlink(dir)?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("failed to chmod 0700 {}: {e}", dir.display()))?;
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
        reject_symlink(dir)?;
    }
    Ok(())
}

pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    ensure_private_dir(parent)?;
    reject_symlink(path)?;
    let nonce = random_hex(8)?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    let tmp = parent.join(format!(".{file_name}.tmp.{}.{nonce}", std::process::id()));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(&tmp)
        .map_err(|e| format!("failed to create temp file {}: {e}", tmp.display()))?;
    if let Err(e) = f.write_all(bytes).and_then(|()| f.sync_all()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("failed writing {}: {e}", tmp.display()));
    }
    drop(f);
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "failed renaming {} -> {}: {e}",
            tmp.display(),
            path.display()
        ));
    }
    Ok(())
}

pub fn write_regular_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    reject_symlink(path)?;
    #[cfg(unix)]
    let preserved_mode = fs::metadata(path).ok().map(|m| {
        use std::os::unix::fs::PermissionsExt;
        m.permissions().mode() & 0o777
    });
    let nonce = random_hex(8)?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = parent.join(format!(
        ".{file_name}.ocx-child.tmp.{}.{nonce}",
        std::process::id()
    ));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(preserved_mode.unwrap_or(0o600));
    }
    let mut f = opts
        .open(&tmp)
        .map_err(|e| format!("failed to create temp file {}: {e}", tmp.display()))?;
    if let Err(e) = f.write_all(bytes).and_then(|()| f.sync_all()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("failed writing {}: {e}", tmp.display()));
    }
    drop(f);
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "failed renaming {} -> {}: {e}",
            tmp.display(),
            path.display()
        ));
    }
    Ok(())
}

pub struct FileLock {
    file: File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockAcquireError {
    Busy,
    Io,
}

impl FileLock {
    pub fn try_acquire_nonblocking(path: &Path) -> Result<Self, LockAcquireError> {
        Self::acquire_inner(path, false)
    }

    pub fn acquire_blocking(path: &Path) -> Result<Self, LockAcquireError> {
        Self::acquire_inner(path, true)
    }

    fn acquire_inner(path: &Path, blocking: bool) -> Result<Self, LockAcquireError> {
        let parent = path.parent().ok_or(LockAcquireError::Io)?;
        ensure_private_dir(parent).map_err(|_| LockAcquireError::Io)?;
        reject_symlink(path).map_err(|_| LockAcquireError::Io)?;
        let mut opts = OpenOptions::new();
        opts.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let file = opts.open(path).map_err(|_| LockAcquireError::Io)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            const LOCK_EX: i32 = 2;
            const LOCK_NB: i32 = 4;
            let op = if blocking { LOCK_EX } else { LOCK_EX | LOCK_NB };
            // SAFETY: `file` owns a valid open descriptor.
            let rc = unsafe { flock(file.as_raw_fd(), op) };
            if rc != 0 {
                return Err(LockAcquireError::Busy);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            const LOCKFILE_FAIL_IMMEDIATELY: u32 = 1;
            const LOCKFILE_EXCLUSIVE_LOCK: u32 = 2;
            let flags = if blocking {
                LOCKFILE_EXCLUSIVE_LOCK
            } else {
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY
            };
            let mut ov = Overlapped {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event: std::ptr::null_mut(),
            };
            // SAFETY: `file` owns a valid open Win32 file handle and `ov` is stack-valid.
            let ok = unsafe { LockFileEx(file.as_raw_handle(), flags, 0, 1, 0, &mut ov) };
            if ok == 0 {
                return Err(LockAcquireError::Busy);
            }
        }
        Ok(Self { file })
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            const LOCK_UN: i32 = 8;
            // SAFETY: `self.file` is still open until Drop returns.
            let _ = unsafe { flock(self.file.as_raw_fd(), LOCK_UN) };
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let mut ov = Overlapped {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event: std::ptr::null_mut(),
            };
            // SAFETY: `self.file` is still open until Drop returns.
            let _ = unsafe { UnlockFileEx(self.file.as_raw_handle(), 0, 1, 0, &mut ov) };
        }
    }
}

pub fn spawn_detached_serve(
    exe: &Path,
    opencodex_home: &Path,
    codex_home: &Path,
    listen_port: u16,
) -> Result<u32, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("serve")
        .arg("--foreground")
        .arg("--listen-port")
        .arg(listen_port.to_string())
        .env("OPENCODEX_HOME", opencodex_home)
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: `setsid()` is async-signal-safe in the forked child before exec.
        unsafe {
            cmd.pre_exec(|| {
                let _ = setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn detached ocx-child serve: {e}"))?;
    Ok(child.id())
}

pub fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        // SAFETY: `kill(pid, 0)` sends no signal and probes process existence.
        let rc = unsafe { kill(pid as i32, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(1) // EPERM
    }
    #[cfg(windows)]
    {
        const SYNCHRONIZE: u32 = 0x0010_0000;
        const WAIT_TIMEOUT: u32 = 258;
        // SAFETY: Opens a temporary SYNCHRONIZE handle for `pid` and closes it immediately.
        unsafe {
            let h = OpenProcess(SYNCHRONIZE, 0, pid);
            if h.is_null() {
                return false;
            }
            let state = WaitForSingleObject(h, 0);
            CloseHandle(h);
            state == WAIT_TIMEOUT
        }
    }
}

pub fn force_terminate_pid(pid: u32, hard_kill: bool) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        let sig = if hard_kill { 9 } else { 15 };
        // SAFETY: Caller verified PID ownership via `/healthz` before invoking termination.
        let _ = unsafe { kill(pid as i32, sig) };
    }
    #[cfg(windows)]
    {
        let _ = hard_kill;
        const PROCESS_TERMINATE: u32 = 0x0001;
        // SAFETY: Caller verified PID ownership before invoking TerminateProcess.
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !h.is_null() {
                let _ = TerminateProcess(h, 1);
                CloseHandle(h);
            }
        }
    }
}

pub fn resolve_user_home() -> PathBuf {
    if let Some(h) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(h);
    }
    if let Some(h) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
        return PathBuf::from(h);
    }
    PathBuf::from(".")
}

pub fn resolve_opencodex_home() -> PathBuf {
    if let Some(custom) = std::env::var_os("OPENCODEX_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(custom);
    }
    resolve_user_home().join(".opencodex")
}

pub fn resolve_codex_home() -> PathBuf {
    if let Some(custom) = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(custom);
    }
    resolve_user_home().join(".codex")
}
