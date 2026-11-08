use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{Ordering, compiler_fence};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryIdentity {
    pub volume: u64,
    pub file_id: [u8; 16],
}

pub fn directory_identity(path: &Path) -> Result<DirectoryIdentity, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let directory = File::open(path).map_err(|e| format!("cannot open directory: {e}"))?;
        let metadata = directory
            .metadata()
            .map_err(|e| format!("cannot inspect directory: {e}"))?;
        if !metadata.is_dir() {
            return Err("expected a directory".to_owned());
        }
        let mut file_id = [0u8; 16];
        file_id[..8].copy_from_slice(&metadata.ino().to_le_bytes());
        Ok(DirectoryIdentity {
            volume: metadata.dev(),
            file_id,
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct FileIdInfo {
            volume: u64,
            file_id: [u8; 16],
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetFileInformationByHandleEx(
                file: *mut std::ffi::c_void,
                class: u32,
                info: *mut std::ffi::c_void,
                size: u32,
            ) -> i32;
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000 | 0x00200000)
            .open(path)
            .map_err(|e| format!("cannot open directory: {e}"))?;
        let metadata = directory
            .metadata()
            .map_err(|e| format!("cannot inspect directory: {e}"))?;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
            return Err("expected a directory".to_owned());
        }
        let mut info = FileIdInfo {
            volume: 0,
            file_id: [0; 16],
        };
        // SAFETY: The open directory handle and output buffer remain valid for the call.
        if unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle(),
                18,
                (&mut info as *mut FileIdInfo).cast(),
                std::mem::size_of::<FileIdInfo>() as u32,
            )
        } == 0
        {
            return Err(format!(
                "cannot inspect directory identity: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(DirectoryIdentity {
            volume: info.volume,
            file_id: info.file_id,
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err("directory identity is unavailable on this platform".to_owned())
    }
}

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

/// A secret string that is wiped on drop, so every copy of it (a clone, or a state read that is
/// dropped) is scrubbed. Serialized as a plain string; `Debug` never prints it.
#[derive(Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl std::ops::Deref for SecretString {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        // SAFETY: Zero bytes are valid UTF-8, so the string stays valid while it is wiped.
        volatile_zero_bytes(unsafe { self.0.as_bytes_mut() });
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

/// `O_NOFOLLOW` for the open(2) flags of this target, from the libc crate's definitions.
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd",
    target_os = "dragonfly"
))]
const O_NOFOLLOW: i32 = 0x0100;
#[cfg(all(
    any(target_os = "linux", target_os = "android"),
    any(
        target_arch = "aarch64",
        target_arch = "arm",
        target_arch = "powerpc",
        target_arch = "powerpc64",
        target_arch = "m68k"
    )
))]
const O_NOFOLLOW: i32 = 0x8000;
#[cfg(any(
    all(
        any(target_os = "linux", target_os = "android"),
        not(any(
            target_arch = "aarch64",
            target_arch = "arm",
            target_arch = "powerpc",
            target_arch = "powerpc64",
            target_arch = "m68k"
        ))
    ),
    target_os = "solaris",
    target_os = "illumos"
))]
const O_NOFOLLOW: i32 = 0x2_0000;

pub fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(format!("refusing symlinked path: {}", path.display()))
        }
        #[cfg(windows)]
        Ok(meta) => {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(format!("refusing reparse point: {}", path.display()));
            }
            Ok(())
        }
        #[cfg(not(windows))]
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to inspect {}: {e}", path.display())),
    }
}

#[cfg(windows)]
mod windows_private_acl {
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::Path;
    use std::ptr;

    type Ptr = *mut c_void;
    const ACL_REVISION: u32 = 2;
    const FULL_CONTROL: u32 = 0x1f01ff;
    const OBJECT_INHERIT_ACE: u32 = 0x1;
    const CONTAINER_INHERIT_ACE: u32 = 0x2;
    const SE_FILE_OBJECT: u32 = 1;
    const DACL_SECURITY_INFORMATION: u32 = 4;
    const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x80000000;

    #[repr(C)]
    struct Acl {
        revision: u8,
        reserved: u8,
        size: u16,
        count: u16,
        reserved2: u16,
    }

    #[repr(C)]
    struct AceHeader {
        kind: u8,
        flags: u8,
        size: u16,
    }

    #[repr(C)]
    struct SecurityDescriptor {
        revision: u8,
        reserved: u8,
        control: u16,
        owner: Ptr,
        group: Ptr,
        sacl: Ptr,
        dacl: Ptr,
    }

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: Ptr,
        inherit_handle: i32,
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: Ptr, access: u32, token: *mut Ptr) -> i32;
        fn GetTokenInformation(
            token: Ptr,
            class: u32,
            info: Ptr,
            size: u32,
            needed: *mut u32,
        ) -> i32;
        fn CreateWellKnownSid(kind: u32, domain: Ptr, sid: Ptr, size: *mut u32) -> i32;
        fn InitializeAcl(acl: *mut Acl, size: u32, revision: u32) -> i32;
        fn AddAccessAllowedAceEx(
            acl: *mut Acl,
            revision: u32,
            flags: u32,
            mask: u32,
            sid: Ptr,
        ) -> i32;
        fn SetNamedSecurityInfoW(
            name: *mut u16,
            kind: u32,
            info: u32,
            owner: Ptr,
            group: Ptr,
            dacl: *mut Acl,
            sacl: *mut Acl,
        ) -> u32;
        fn GetNamedSecurityInfoW(
            name: *const u16,
            kind: u32,
            info: u32,
            owner: *mut Ptr,
            group: *mut Ptr,
            dacl: *mut *mut Acl,
            sacl: *mut *mut Acl,
            descriptor: *mut Ptr,
        ) -> u32;
        fn GetSecurityDescriptorControl(
            descriptor: Ptr,
            control: *mut u16,
            revision: *mut u32,
        ) -> i32;
        fn GetSecurityDescriptorDacl(
            descriptor: Ptr,
            present: *mut i32,
            dacl: *mut *mut Acl,
            defaulted: *mut i32,
        ) -> i32;
        fn EqualSid(a: Ptr, b: Ptr) -> i32;
        fn IsValidSid(sid: Ptr) -> i32;
        fn IsValidAcl(acl: *mut Acl) -> i32;
        fn GetAce(acl: *mut Acl, index: u32, ace: *mut Ptr) -> i32;
        fn GetLengthSid(sid: Ptr) -> u32;
        fn InitializeSecurityDescriptor(descriptor: Ptr, revision: u32) -> i32;
        fn SetSecurityDescriptorDacl(
            descriptor: Ptr,
            present: i32,
            dacl: *mut Acl,
            defaulted: i32,
        ) -> i32;
        fn SetSecurityDescriptorControl(descriptor: Ptr, mask: u16, control: u16) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> Ptr;
        fn CloseHandle(handle: Ptr) -> i32;
        fn LocalFree(memory: Ptr) -> Ptr;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            attributes: *mut SecurityAttributes,
            disposition: u32,
            flags: u32,
            template: Ptr,
        ) -> Ptr;
    }

    struct Local(Ptr);
    impl Drop for Local {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: `self.0` was allocated by `GetNamedSecurityInfoW`.
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
    }

    struct Token(Ptr);
    impl Drop for Token {
        fn drop(&mut self) {
            // SAFETY: `self.0` is an open process token handle.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn current_user_sid() -> Result<Vec<usize>, String> {
        let mut token = ptr::null_mut();
        // SAFETY: Queries current process token for TOKEN_QUERY (0x8).
        if unsafe { OpenProcessToken(GetCurrentProcess(), 0x8, &mut token) } == 0 {
            return Err("private-acl-unsafe: OpenProcessToken failed".to_owned());
        }
        let token = Token(token);
        let mut needed = 0u32;
        // SAFETY: First call sizes TokenUser (1).
        unsafe {
            GetTokenInformation(token.0, 1, ptr::null_mut(), 0, &mut needed);
        }
        if needed < std::mem::size_of::<usize>() as u32 || needed > 65536 {
            return Err("private-acl-unsafe: invalid token user size".to_owned());
        }
        let mut buf = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        // SAFETY: `buf` has `>= needed` bytes aligned to `usize`.
        if unsafe { GetTokenInformation(token.0, 1, buf.as_mut_ptr().cast(), needed, &mut needed) }
            == 0
        {
            return Err("private-acl-unsafe: GetTokenInformation failed".to_owned());
        }
        // SAFETY: `buf[0]` holds the `PSID` pointer inside `TOKEN_USER`.
        if unsafe { IsValidSid(buf[0] as Ptr) } == 0 {
            return Err("private-acl-unsafe: invalid user SID".to_owned());
        }
        Ok(buf)
    }

    fn wide_nul(path: &Path) -> Result<Vec<u16>, String> {
        let out: Vec<u16> = path.as_os_str().encode_wide().collect();
        if out.contains(&0) {
            return Err("private-acl-unsafe: interior NUL".to_owned());
        }
        Ok(out.into_iter().chain(Some(0)).collect())
    }

    fn well_known_sid(kind: u32) -> Result<[u32; 17], String> {
        let mut sid = [0u32; 17];
        let mut size = std::mem::size_of_val(&sid) as u32;
        // SAFETY: `sid` is 68 bytes (SECURITY_MAX_SID_SIZE), DWORD-aligned.
        if unsafe { CreateWellKnownSid(kind, ptr::null_mut(), sid.as_mut_ptr().cast(), &mut size) }
            == 0
        {
            return Err("private-acl-unsafe: CreateWellKnownSid failed".to_owned());
        }
        Ok(sid)
    }

    fn private_acl(
        directory: bool,
    ) -> Result<(Vec<usize>, [u32; 17], [u32; 17], Vec<u32>), String> {
        let user = current_user_sid()?;
        let mut system = well_known_sid(22)?;
        let mut admins = well_known_sid(26)?;
        let sids: Vec<Ptr> = if directory {
            vec![
                user[0] as Ptr,
                system.as_mut_ptr().cast(),
                admins.as_mut_ptr().cast(),
            ]
        } else {
            vec![user[0] as Ptr]
        };
        // SAFETY: All 3 SIDs were validated by `IsValidSid` / `CreateWellKnownSid`.
        let acl_bytes = std::mem::size_of::<Acl>() as u32
            + sids
                .iter()
                .map(|&s| 8 + unsafe { GetLengthSid(s) })
                .sum::<u32>();
        let mut acl_buf = vec![0u32; (acl_bytes as usize).div_ceil(std::mem::size_of::<u32>())];
        let acl_ptr = acl_buf.as_mut_ptr().cast::<Acl>();
        let flags = if directory {
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
        } else {
            0
        };
        // SAFETY: `acl_buf` has `>= acl_bytes` DWORD-aligned capacity.
        if unsafe { InitializeAcl(acl_ptr, acl_bytes, ACL_REVISION) } == 0 {
            return Err("private-acl-unsafe: InitializeAcl failed".to_owned());
        }
        for &sid in &sids {
            // SAFETY: `acl_ptr` initialized with exact room for `sids`.
            if unsafe { AddAccessAllowedAceEx(acl_ptr, ACL_REVISION, flags, FULL_CONTROL, sid) }
                == 0
            {
                return Err("private-acl-unsafe: AddAccessAllowedAceEx failed".to_owned());
            }
        }
        Ok((user, system, admins, acl_buf))
    }

    /// Verify, without changing it, that an existing file carries the protected owner-only DACL.
    pub fn verify_private_file(path: &Path) -> Result<(), String> {
        let (user, mut system, mut admins, _acl) = private_acl(false)?;
        verify(path, false, &user, &mut system, &mut admins)
    }

    pub fn harden_and_verify(path: &Path, directory: bool) -> Result<(), String> {
        let (user, mut system, mut admins, mut acl_buf) = private_acl(directory)?;
        let acl_ptr = acl_buf.as_mut_ptr().cast::<Acl>();
        let mut wname = wide_nul(path)?;
        // SAFETY: Applies protected DACL to `wname`.
        if unsafe {
            SetNamedSecurityInfoW(
                wname.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                acl_ptr,
                ptr::null_mut(),
            )
        } != 0
        {
            return Err(format!(
                "private-acl-unsafe: SetNamedSecurityInfoW failed on {}",
                path.display()
            ));
        }
        verify(path, directory, &user, &mut system, &mut admins)
    }

    /// Create an exclusive file with its protected DACL installed by the kernel at creation.
    pub fn create_private_file(path: &Path) -> Result<File, String> {
        let (user, mut system, mut admins, mut acl_buf) = private_acl(false)?;
        let mut descriptor = SecurityDescriptor {
            revision: 0,
            reserved: 0,
            control: 0,
            owner: ptr::null_mut(),
            group: ptr::null_mut(),
            sacl: ptr::null_mut(),
            dacl: ptr::null_mut(),
        };
        let descriptor_ptr = (&mut descriptor as *mut SecurityDescriptor).cast::<c_void>();
        // SAFETY: The descriptor and ACL are initialized, aligned and live through CreateFileW.
        if unsafe { InitializeSecurityDescriptor(descriptor_ptr, 1) } == 0
            || unsafe {
                SetSecurityDescriptorDacl(descriptor_ptr, 1, acl_buf.as_mut_ptr().cast(), 0)
            } == 0
            || unsafe { SetSecurityDescriptorControl(descriptor_ptr, 0x1000, 0x1000) } == 0
        {
            return Err("private-acl-unsafe: security descriptor initialization failed".to_owned());
        }
        let mut attributes = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: descriptor_ptr,
            inherit_handle: 0,
        };
        let wname = wide_nul(path)?;
        // SAFETY: The path and security attributes stay live for the call; CREATE_NEW cannot replace a file.
        let handle = unsafe {
            CreateFileW(
                wname.as_ptr(),
                0x40000000,
                0x00000007,
                &mut attributes,
                1,
                0x00000080,
                ptr::null_mut(),
            )
        };
        if handle == (-1isize as Ptr) {
            return Err(format!(
                "private-acl-unsafe: create failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: CreateFileW returned a newly owned file handle.
        let file = unsafe { File::from_raw_handle(handle) };
        verify(path, false, &user, &mut system, &mut admins)?;
        Ok(file)
    }

    fn verify(
        path: &Path,
        root: bool,
        user: &[usize],
        system: &mut [u32; 17],
        admins: &mut [u32; 17],
    ) -> Result<(), String> {
        let wname = wide_nul(path)?;
        let mut owner = ptr::null_mut();
        let mut dacl = ptr::null_mut();
        let mut desc = ptr::null_mut();
        // SAFETY: Reads owner + DACL into LocalAlloc'd security descriptor.
        let rc = unsafe {
            GetNamedSecurityInfoW(
                wname.as_ptr(),
                SE_FILE_OBJECT,
                1 | DACL_SECURITY_INFORMATION,
                &mut owner,
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut desc,
            )
        };
        let desc = Local(desc);
        if rc != 0 || desc.0.is_null() || owner.is_null() || dacl.is_null() {
            return Err("private-acl-unsafe: GetNamedSecurityInfoW failed".to_owned());
        }
        let mut control = 0u16;
        let mut rev = 0u32;
        let mut present = 0i32;
        let mut defaulted = 0i32;
        // SAFETY: Inspects valid security descriptor `desc.0`.
        let ok = unsafe {
            GetSecurityDescriptorControl(desc.0, &mut control, &mut rev) != 0
                && GetSecurityDescriptorDacl(desc.0, &mut present, &mut dacl, &mut defaulted) != 0
                && present != 0
                && !dacl.is_null()
                && IsValidAcl(dacl) != 0
                && IsValidSid(owner) != 0
                && (EqualSid(owner, user[0] as Ptr) != 0
                    || EqualSid(owner, admins.as_mut_ptr().cast()) != 0)
                && control & 0x1000 != 0
        };
        if !ok {
            return Err("private-acl-unsafe: DACL header/owner verification failed".to_owned());
        }
        let mut user_fc = false;
        // SAFETY: `dacl` was validated by `IsValidAcl`.
        let ace_count = unsafe { (*dacl).count } as u32;
        for i in 0..ace_count {
            let mut ace = ptr::null_mut();
            // SAFETY: `i < ace_count`.
            if unsafe { GetAce(dacl, i, &mut ace) } == 0 || ace.is_null() {
                return Err("private-acl-unsafe: GetAce failed".to_owned());
            }
            // SAFETY: `ace` points to a valid ACE inside `dacl`.
            let hdr = unsafe { &*ace.cast::<AceHeader>() };
            if hdr.kind != 0 || hdr.size < 16 || (root && hdr.flags & 0x10 != 0) {
                return Err("private-acl-unsafe: unexpected ACE kind/flags".to_owned());
            }
            // SAFETY: ACCESS_ALLOWED_ACE has mask at +4 and SID at +8.
            let mask = unsafe { *ace.cast::<u8>().add(4).cast::<u32>() };
            let sid = unsafe { ace.cast::<u8>().add(8).cast::<c_void>() };
            // SAFETY: Bounds-checks SID inside `hdr.size`.
            if unsafe { IsValidSid(sid) } == 0 || unsafe { GetLengthSid(sid) } + 8 > hdr.size as u32
            {
                return Err("private-acl-unsafe: invalid ACE SID".to_owned());
            }
            // SAFETY: Compares valid SIDs.
            let is_user = unsafe { EqualSid(sid, user[0] as Ptr) } != 0;
            let is_sys = unsafe { EqualSid(sid, system.as_mut_ptr().cast()) } != 0;
            let is_adm = unsafe { EqualSid(sid, admins.as_mut_ptr().cast()) } != 0;
            if !is_user && !is_sys && !is_adm {
                return Err("private-acl-unsafe: foreign ACE present".to_owned());
            }
            user_fc |= is_user
                && hdr.flags & 0x8 == 0
                && (mask & FULL_CONTROL == FULL_CONTROL || mask & 0x10000000 != 0);
        }
        if !user_fc {
            return Err("private-acl-unsafe: missing current-user FullControl ACE".to_owned());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::fs;
        use std::io::Write;
        use std::process::Command;

        #[test]
        fn regular_replacement_is_private_under_a_permissive_parent() {
            struct Scratch(std::path::PathBuf);
            impl Drop for Scratch {
                fn drop(&mut self) {
                    let _ = fs::remove_dir_all(&self.0);
                }
            }

            let root = std::env::temp_dir().join(format!(
                "ocx-child-acl-{}-{}",
                std::process::id(),
                crate::platform::random_hex(6).unwrap()
            ));
            fs::create_dir(&root).unwrap();
            let _scratch = Scratch(root.clone());
            let grant = Command::new("icacls")
                .arg(&root)
                .args(["/grant", "*S-1-1-0:(OI)(CI)F"])
                .output()
                .unwrap();
            assert!(
                grant.status.success(),
                "could not make fixture parent permissive"
            );
            let config = root.join("config.toml");
            fs::write(&config, b"original").unwrap();
            harden_and_verify(&config, false).unwrap();

            let temp = root.join("new-private.tmp");
            let mut created = create_private_file(&temp).unwrap();
            let user = current_user_sid().unwrap();
            let mut system = well_known_sid(22).unwrap();
            let mut admins = well_known_sid(26).unwrap();
            verify(&temp, false, &user, &mut system, &mut admins).unwrap();
            created.write_all(b"fixture").unwrap();
            drop(created);

            crate::platform::write_regular_atomic(&config, b"replacement").unwrap();
            verify(&config, false, &user, &mut system, &mut admins).unwrap();
            assert_eq!(fs::read(config).unwrap(), b"replacement");
        }
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
    #[cfg(windows)]
    {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
        reject_symlink(dir)?;
        windows_private_acl::harden_and_verify(dir, true)?;
    }
    #[cfg(not(any(unix, windows)))]
    {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
        reject_symlink(dir)?;
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    let directory =
        File::open(parent).map_err(|e| format!("failed to open parent directory: {e}"))?;
    directory
        .sync_all()
        .map_err(|e| format!("failed to sync parent directory: {e}"))
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
    #[cfg(windows)]
    let mut f = windows_private_acl::create_private_file(&tmp)?;
    #[cfg(not(windows))]
    let mut f = {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&tmp)
            .map_err(|e| format!("failed to create temp file {}: {e}", tmp.display()))?
    };
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
    #[cfg(unix)]
    sync_parent_directory(parent)?;
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
    #[cfg(windows)]
    let mut f = windows_private_acl::create_private_file(&tmp)?;
    #[cfg(not(windows))]
    let mut f = {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(preserved_mode.unwrap_or(0o600));
        }
        opts.open(&tmp)
            .map_err(|e| format!("failed to create temp file {}: {e}", tmp.display()))?
    };
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
    #[cfg(unix)]
    sync_parent_directory(parent)?;
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

/// What a lock acquisition does with the lock file's parent directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockParentAction {
    /// The parent is missing and ocx-child creates it, private, as its own directory.
    CreatePrivate,
    /// The parent already exists; its permissions are never changed. It may be an
    /// `OPENCODEX_HOME` shared with a full OpenCodex install, or `CODEX_HOME`.
    UseExisting,
    Refuse,
}

/// `parent` is the parent's metadata, or `None` when it does not exist.
pub fn lock_parent_action(parent: Option<&fs::Metadata>, create_missing: bool) -> LockParentAction {
    match parent {
        None if create_missing => LockParentAction::CreatePrivate,
        None => LockParentAction::Refuse,
        Some(meta) if meta.is_dir() => LockParentAction::UseExisting,
        Some(_) => LockParentAction::Refuse,
    }
}

/// Create `dir` private (`0700`, or a protected owner-only DACL on Windows) if it is missing.
/// Returns whether this call created it. A directory that already exists, including one another
/// process creates concurrently, is left exactly as it is.
pub fn create_private_dir_if_missing(dir: &Path) -> Result<bool, String> {
    if let Some(ancestor) = dir.parent().filter(|p| !p.as_os_str().is_empty()) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(ancestor)
                .map_err(|e| format!("failed to create {}: {e}", ancestor.display()))?;
        }
        #[cfg(not(unix))]
        fs::create_dir_all(ancestor)
            .map_err(|e| format!("failed to create {}: {e}", ancestor.display()))?;
    }
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(dir)
    };
    #[cfg(not(unix))]
    let created = fs::DirBuilder::new().create(dir);
    match created {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return if fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir()) {
                Ok(false)
            } else {
                Err(format!("{} exists and is not a directory", dir.display()))
            };
        }
        Err(e) => return Err(format!("failed to create {}: {e}", dir.display())),
    }
    reject_symlink(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("failed to chmod 0700 {}: {e}", dir.display()))?;
    }
    #[cfg(windows)]
    windows_private_acl::harden_and_verify(dir, true)?;
    Ok(true)
}

impl FileLock {
    /// Lock `path`, creating its parent private only if it is missing. An existing parent keeps
    /// its permissions; the lock file itself is created owner-only.
    pub fn try_acquire_nonblocking(path: &Path) -> Result<Self, LockAcquireError> {
        Self::acquire_inner(path, false, true)
    }

    pub fn acquire_blocking(path: &Path) -> Result<Self, LockAcquireError> {
        Self::acquire_inner(path, true, true)
    }

    /// Lock a file inside a directory the caller does not own (such as `CODEX_HOME`), leaving
    /// the directory's permissions untouched. The lock file itself is created private.
    pub fn acquire_in_existing_dir(path: &Path, blocking: bool) -> Result<Self, LockAcquireError> {
        Self::acquire_inner(path, blocking, false)
    }

    fn acquire_inner(
        path: &Path,
        blocking: bool,
        create_missing_parent: bool,
    ) -> Result<Self, LockAcquireError> {
        let parent = path.parent().ok_or(LockAcquireError::Io)?;
        // A symlinked parent is refused rather than followed, as ensure_private_dir did.
        let parent_meta = fs::symlink_metadata(parent).ok();
        match lock_parent_action(parent_meta.as_ref(), create_missing_parent) {
            LockParentAction::CreatePrivate => {
                create_private_dir_if_missing(parent).map_err(|_| LockAcquireError::Io)?;
            }
            LockParentAction::UseExisting => {}
            LockParentAction::Refuse => return Err(LockAcquireError::Io),
        }
        reject_symlink(path).map_err(|_| LockAcquireError::Io)?;
        crate::test_hooks::barrier("lock-before-open");
        #[cfg(windows)]
        let existed = path.exists();
        let mut opts = OpenOptions::new();
        opts.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600).custom_flags(O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
            opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = opts.open(path).map_err(|_| LockAcquireError::Io)?;
        // The open did not follow a link; refuse anything that is not a plain file anyway.
        let metadata = file.metadata().map_err(|_| LockAcquireError::Io)?;
        if !metadata.is_file() {
            return Err(LockAcquireError::Io);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(LockAcquireError::Io);
            }
            let private = if existed {
                windows_private_acl::verify_private_file(path)
            } else {
                windows_private_acl::harden_and_verify(path, false)
            };
            private.map_err(|_| LockAcquireError::Io)?;
        }
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

/// Spawn `serve --foreground --lifecycle-start` and write `start_line` to its stdin, which
/// stays open: the caller later writes the commit line or drops it to make the child exit.
pub fn spawn_detached_serve(
    exe: &Path,
    opencodex_home: &Path,
    codex_home: &Path,
    listen_port: u16,
    start_line: &[u8],
) -> Result<std::process::Child, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("serve")
        .arg("--foreground")
        .arg("--lifecycle-start")
        .arg("--listen-port")
        .arg(listen_port.to_string())
        .env("OPENCODEX_HOME", opencodex_home)
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::test_hooks::strip_barrier_env(&mut cmd);

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

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn detached ocx-child serve: {e}"))?;
    let write_result = match child.stdin.as_mut() {
        Some(stdin) => stdin.write_all(start_line).and_then(|()| stdin.flush()),
        None => Err(std::io::Error::other("missing child stdin")),
    };
    if let Err(e) = write_result {
        let cleanup = child.kill().and_then(|()| child.wait().map(|_| ()));
        return Err(format!(
            "failed to authorize spawned child: {e}; cleanup: {cleanup:?}"
        ));
    }
    Ok(child)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurgeExecutableOutcome {
    Removed,
    SkippedUnmanagedPath,
}

fn reject_managed_subpath_symlinks(root: &Path, components: &[&str]) -> Result<PathBuf, String> {
    let mut cur = root.to_path_buf();
    for comp in components {
        cur.push(comp);
        reject_symlink(&cur)?;
    }
    Ok(cur)
}

pub fn is_managed_plant_executable(
    exe_path: &Path,
    user_home: &Path,
    local_appdata: Option<&Path>,
) -> Result<bool, String> {
    reject_symlink(exe_path)?;
    if !fs::symlink_metadata(exe_path).is_ok_and(|m| m.file_type().is_file()) {
        return Ok(false);
    }
    let Some(parent) = exe_path.parent() else {
        return Ok(false);
    };
    reject_symlink(parent)?;
    let expected_name = if cfg!(windows) {
        "ocx-child.exe"
    } else {
        "ocx-child"
    };
    if exe_path.file_name().and_then(|n| n.to_str()) != Some(expected_name) {
        return Ok(false);
    }
    let canon_parent = fs::canonicalize(parent)
        .map_err(|e| format!("failed canonicalizing {}: {e}", parent.display()))?;
    let cache_bin = reject_managed_subpath_symlinks(user_home, &[".cache", "opencodex", "bin"])?;
    if fs::canonicalize(&cache_bin).ok().as_ref() == Some(&canon_parent) {
        return Ok(true);
    }
    if let Some(appdata) = local_appdata {
        let win_bin = reject_managed_subpath_symlinks(appdata, &["opencodex", "bin"])?;
        if fs::canonicalize(&win_bin).ok().as_ref() == Some(&canon_parent) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn purge_managed_executable(
    exe_path: &Path,
    user_home: &Path,
    local_appdata: Option<&Path>,
) -> Result<PurgeExecutableOutcome, String> {
    if !is_managed_plant_executable(exe_path, user_home, local_appdata)? {
        return Ok(PurgeExecutableOutcome::SkippedUnmanagedPath);
    }
    #[cfg(unix)]
    {
        fs::remove_file(exe_path).map_err(|e| {
            format!(
                "failed removing planted ocx-child {}: {e}",
                exe_path.display()
            )
        })?;
        let _ = exe_path.parent().map(fs::remove_dir);
        let _ = exe_path.parent().and_then(Path::parent).map(fs::remove_dir);
        Ok(PurgeExecutableOutcome::Removed)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        let parent = exe_path
            .parent()
            .ok_or_else(|| "missing parent".to_owned())?;
        let trashed = parent.join(format!(".ocx-child.purge.{}.old", std::process::id()));
        let _ = fs::remove_file(&trashed);
        fs::rename(exe_path, &trashed)
            .map_err(|e| format!("failed renaming planted ocx-child for purge: {e}"))?;
        let _ = Command::new("cmd.exe")
            .args([
                "/d",
                "/c",
                "ping -n 2 127.0.0.1 >nul & del /f /q \"%OCX_PURGE_TARGET%\"",
            ])
            .env("OCX_PURGE_TARGET", &trashed)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn();
        Ok(PurgeExecutableOutcome::Removed)
    }
}

#[cfg(test)]
mod lock_parent_tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn scratch() -> Scratch {
        let dir = std::env::temp_dir().join(format!(
            "ocx-child-lock-parent-{}-{}",
            std::process::id(),
            random_hex(6).unwrap()
        ));
        fs::create_dir(&dir).unwrap();
        Scratch(dir)
    }

    #[test]
    fn only_a_missing_parent_is_created_and_an_existing_one_is_never_touched() {
        let root = scratch();
        let file = root.0.join("plain-file");
        fs::write(&file, b"x").unwrap();
        let dir_meta = fs::symlink_metadata(&root.0).unwrap();
        let file_meta = fs::symlink_metadata(&file).unwrap();
        assert_eq!(
            lock_parent_action(None, true),
            LockParentAction::CreatePrivate
        );
        assert_eq!(lock_parent_action(None, false), LockParentAction::Refuse);
        for create in [true, false] {
            assert_eq!(
                lock_parent_action(Some(&dir_meta), create),
                LockParentAction::UseExisting
            );
            assert_eq!(
                lock_parent_action(Some(&file_meta), create),
                LockParentAction::Refuse
            );
        }
    }

    #[test]
    fn create_private_dir_if_missing_reports_creation_and_keeps_existing_modes() {
        let root = scratch();
        let created = root.0.join("new").join("home");
        assert!(create_private_dir_if_missing(&created).unwrap());
        assert!(!create_private_dir_if_missing(&created).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&created), 0o700);
            let shared = root.0.join("shared");
            fs::create_dir(&shared).unwrap();
            fs::set_permissions(&shared, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(!create_private_dir_if_missing(&shared).unwrap());
            let lock = FileLock::acquire_blocking(&shared.join("child.lock")).unwrap();
            drop(lock);
            assert_eq!(mode(&shared), 0o755);
            assert_eq!(mode(&shared.join("child.lock")), 0o600);
        }
    }
}
