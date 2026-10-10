use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn io<T>(value: std::io::Result<T>) -> Result<T> {
    value.map_err(|_| "io-failed".into())
}
fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub const RECORD_LIMIT: usize = 64 * 1024;
const JOURNAL_LIMIT: usize = 8 * 1024 * 1024;
pub fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}
fn absolute_for(s: &str, host: &str) -> bool {
    if s.chars().count() > 4096 || s.contains(['\0', '\n', '\r']) {
        return false;
    }
    let absolute = if host == "win32" {
        let b = s.as_bytes();
        (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\'))
            || s.starts_with("\\\\")
            || s.starts_with("//")
    } else {
        s.starts_with('/')
    };
    absolute
        && !s
            .split(if host == "win32" {
                &['/', '\\'][..]
            } else {
                &['/'][..]
            })
            .any(|part| matches!(part, "." | ".."))
}
fn absolute(s: &str) -> bool {
    absolute_for(s, platform())
}
fn bundle_valid(b: &Bundle, host: &str) -> bool {
    b.platform == host
        && absolute_for(&b.app_executable, host)
        && absolute_for(&b.cli_executable, host)
        && !b.version.is_empty()
        && matches!(
            (host, b.kind.as_str()),
            ("darwin", "macos-app") | ("win32", "windows-install") | ("linux", "linux-deb")
        )
}
fn fingerprint(bytes: Option<&[u8]>) -> String {
    bytes.map(hash).unwrap_or_else(|| "absent".into())
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    pub platform: String,
    pub app_executable: String,
    pub cli_executable: String,
    pub version: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnedFile {
    pub kind: String,
    pub path: String,
    pub sha256: String,
    pub created: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RcFile {
    pub shell: String,
    pub path: String,
    pub block_sha256: String,
    pub created: bool,
    pub backup_path: Option<String>,
    pub result: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Posix {
    pub bin_directory: String,
    pub files: Vec<OwnedFile>,
    pub rc_files: Vec<RcFile>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Windows {
    pub key: String,
    pub value: String,
    pub entry: String,
    pub value_type: String,
    pub action: String,
    pub previous_before: Option<String>,
    pub previous_after: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub kind: String,
    pub path: String,
    pub before: Option<Vec<u8>>,
    pub after: Option<Vec<u8>>,
    pub mode: u32,
    pub backup_path: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingChange {
    pub kind: String,
    pub path: String,
    pub mode: u32,
    pub backup_path: Option<String>,
    pub journal_file: String,
    pub before_sha256: String,
    pub after_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    pub operation: String,
    pub changes: Vec<PendingChange>,
    pub next: Box<Record>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalFile {
    version: u32,
    kind: String,
    path: String,
    mode: Option<u32>,
    before: Option<String>,
    after: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub version: u32,
    pub owner_id: String,
    pub install_id: String,
    pub generation: u64,
    pub enabled: bool,
    pub bundle: Option<Bundle>,
    pub posix: Option<Posix>,
    pub windows: Option<Windows>,
    #[serde(default)]
    pub notify_pending: bool,
    pub pending: Option<Journal>,
}
impl Record {
    pub fn fresh(bundle: Bundle) -> Self {
        let install_id = Uuid::new_v4().to_string();
        Self {
            version: 1,
            owner_id: Uuid::new_v4().to_string(),
            install_id,
            generation: 1,
            enabled: true,
            bundle: Some(bundle),
            posix: None,
            windows: None,
            notify_pending: false,
            pending: None,
        }
    }
}
// Desired targets authorize new writes; persisted rc ownership survives environment changes.
pub struct Store {
    pub root: PathBuf,
    pub rc_allowed: Vec<PathBuf>,
    _lock: fs::File,
}
#[cfg(unix)]
unsafe extern "C" {
    fn geteuid() -> u32;
    fn flock(fd: i32, op: i32) -> i32;
}
#[cfg(target_os = "macos")]
mod acl {
    use super::*;
    use std::{
        ffi::{c_void, CString},
        os::unix::ffi::OsStrExt,
    };
    const EXTENDED: i32 = 0x100;
    unsafe extern "C" {
        fn acl_get_file(path: *const i8, kind: i32) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: i32, entry: *mut *mut c_void) -> i32;
        fn acl_set_file(path: *const i8, kind: i32, acl: *mut c_void) -> i32;
        fn acl_init(count: i32) -> *mut c_void;
        fn acl_free(acl: *mut c_void) -> i32;
    }
    fn name(path: &Path) -> Result<CString> {
        CString::new(path.as_os_str().as_bytes()).map_err(|_| "private-acl-unsafe".into())
    }
    pub fn present(path: &Path) -> Result<bool> {
        // NULL/ENOENT denotes no ACL only on an existing, non-symlink path.
        let m = fs::symlink_metadata(path).map_err(|_| "private-acl-unsafe")?;
        if m.file_type().is_symlink() {
            return Err("private-acl-unsafe".into());
        }
        let path = name(path)?;
        let acl = unsafe { acl_get_file(path.as_ptr(), EXTENDED) };
        if acl.is_null() {
            return if std::io::Error::last_os_error().raw_os_error() == Some(2) {
                Ok(false)
            } else {
                Err("private-acl-unsafe".into())
            };
        }
        let mut entry = std::ptr::null_mut();
        // Darwin returns 0 for an entry and -1/EINVAL for an empty ACL.
        let result = unsafe { acl_get_entry(acl, 0, &mut entry) };
        let errno = std::io::Error::last_os_error().raw_os_error();
        let freed = unsafe { acl_free(acl) };
        if freed != 0 {
            return Err("private-acl-unsafe".into());
        }
        match (result, errno) {
            (0, _) => Ok(true),
            (-1, Some(22)) => Ok(false),
            _ => Err("private-acl-unsafe".into()),
        }
    }
    pub fn clear(path: &Path) -> Result<()> {
        let path = name(path)?;
        let acl = unsafe { acl_init(0) };
        if acl.is_null() {
            return Err("private-acl-unsafe".into());
        }
        let result = unsafe { acl_set_file(path.as_ptr(), EXTENDED, acl) };
        let freed = unsafe { acl_free(acl) };
        if result != 0 || freed != 0 {
            Err("private-acl-unsafe".into())
        } else {
            Ok(())
        }
    }
}
#[cfg(target_os = "linux")]
mod acl {
    use super::*;
    use std::{
        ffi::{c_void, CString},
        os::unix::ffi::OsStrExt,
    };
    const NAMES: [&[u8]; 2] = [b"system.posix_acl_access\0", b"system.posix_acl_default\0"];
    unsafe extern "C" {
        fn getxattr(path: *const i8, name: *const i8, value: *mut c_void, size: usize) -> isize;
        fn removexattr(path: *const i8, name: *const i8) -> i32;
    }
    fn name(path: &Path) -> Result<CString> {
        CString::new(path.as_os_str().as_bytes()).map_err(|_| "private-acl-unsafe".into())
    }
    pub fn present(path: &Path) -> Result<bool> {
        let m = fs::symlink_metadata(path).map_err(|_| "private-acl-unsafe")?;
        if m.file_type().is_symlink() {
            return Err("private-acl-unsafe".into());
        }
        let path = name(path)?;
        for attr in NAMES {
            let n =
                unsafe { getxattr(path.as_ptr(), attr.as_ptr().cast(), std::ptr::null_mut(), 0) };
            if n >= 0 {
                return Ok(true);
            }
            if !matches!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(61 | 95)
            ) {
                return Err("private-acl-unsafe".into());
            }
        }
        Ok(false)
    }
    pub fn clear(path: &Path) -> Result<()> {
        let path = name(path)?;
        for attr in NAMES {
            if unsafe { removexattr(path.as_ptr(), attr.as_ptr().cast()) } != 0
                && !matches!(
                    std::io::Error::last_os_error().raw_os_error(),
                    Some(61 | 95)
                )
            {
                return Err("private-acl-unsafe".into());
            }
        }
        Ok(())
    }
}
pub fn rc_acl_check(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("rc-acl-present".into()),
        Ok(_) => {}
    }
    #[cfg(unix)]
    if acl::present(path).map_err(|_| "rc-acl-present")? {
        return Err("rc-acl-present".into());
    }
    Ok(())
}
fn private_check(path: &Path, directory: bool, mode: u32, root: bool) -> Result<()> {
    check(path, directory).map_err(|_| "private-acl-unsafe")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = fs::symlink_metadata(path).map_err(|_| "private-acl-unsafe")?;
        if m.mode() & 0o777 != mode || acl::present(path)? {
            return Err("private-acl-unsafe".into());
        }
        let _ = root;
    }
    #[cfg(windows)]
    {
        let _ = mode;
        crate::cli_command_windows::private_acl::verify(path, root)?;
    }
    Ok(())
}
fn harden_new(path: &Path, directory: bool) -> Result<()> {
    #[cfg(unix)]
    {
        acl::clear(path)?;
        if acl::present(path)? {
            return Err("private-acl-unsafe".into());
        }
        let _ = directory;
    }
    #[cfg(windows)]
    crate::cli_command_windows::private_acl::harden(path, directory)?;
    Ok(())
}
pub fn check(path: &Path, directory: bool) -> Result<()> {
    let m = io(fs::symlink_metadata(path))?;
    for parent in path.ancestors().skip(1) {
        if fs::symlink_metadata(parent)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true)
        {
            return Err("unsafe-parent".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if fs::symlink_metadata(parent)
                .map(|m| m.file_attributes() & 0x400 != 0)
                .unwrap_or(true)
            {
                return Err("unsafe-parent".into());
            }
        }
    }
    if m.file_type().is_symlink() || (directory && !m.is_dir()) || (!directory && !m.is_file()) {
        return Err("unsafe-file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if m.uid() != unsafe { geteuid() } {
            return Err("foreign-owner".into());
        }
        if m.mode() & 0o222 == 0 {
            return Err("read-only".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err("unsafe-file".into());
        }
    }
    if m.permissions().readonly() {
        return Err("read-only".into());
    }
    Ok(())
}
pub fn private_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => private_check(path, true, 0o700, true)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                let mut b = fs::DirBuilder::new();
                b.mode(0o700);
                io(b.create(path))?;
            }
            #[cfg(not(unix))]
            io(fs::create_dir(path))?;
            harden_new(path, true)?;
        }
        Err(_) => return Err("io-failed".into()),
    }
    private_check(path, true, 0o700, true)
}
fn read_limited(path: &Path, limit: usize, reason: &str) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("io-failed".into()),
        Ok(m) if m.len() > limit as u64 => return Err(reason.into()),
        Ok(_) => check(path, false)?,
    }
    let mut f = io(fs::File::open(path))?;
    let mut out = Vec::new();
    io((&mut f).take(limit as u64 + 1).read_to_end(&mut out))?;
    if out.len() > limit {
        return Err(reason.into());
    }
    Ok(Some(out))
}
pub fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    read_limited(path, JOURNAL_LIMIT, "rc-too-large")
}
fn private_bytes(path: &Path, limit: usize, reason: &str) -> Result<Option<Vec<u8>>> {
    let bytes = read_limited(path, limit, reason)?;
    if bytes.is_some() {
        private_check(path, false, 0o600, false)?;
    }
    Ok(bytes)
}
fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    io(fs::File::open(path).and_then(|f| f.sync_all()))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn new_file(path: &Path, mode: u32) -> Result<fs::File> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let file = io(o.open(path))?;
    harden_new(path, false)?;
    Ok(file)
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(a: *const u16, b: *const u16, flags: u32) -> i32;
    }
    let a: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let b: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0x1 | 0x8) } == 0 {
        Err("rename-failed".into())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> Result<()> {
    io(fs::rename(from, to))
}
pub fn atomic(path: &Path, before: Option<&[u8]>, after: &[u8], mode: u32) -> Result<()> {
    let parent = path.parent().ok_or("unsafe-file")?;
    check(parent, true)?;
    rc_acl_check(path)?;
    let tmp = parent.join(format!(".ocx-cli-{}", Uuid::new_v4()));
    let result = (|| {
        let original = fs::symlink_metadata(path).ok();
        let mut f = new_file(&tmp, mode)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            io(f.set_permissions(fs::Permissions::from_mode(mode)))?;
        }
        io(f.write_all(after))?;
        io(f.sync_all())?;
        let observed = fs::symlink_metadata(path).ok();
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if original
                .as_ref()
                .map(|m| (m.dev(), m.ino(), m.mode(), m.mtime(), m.mtime_nsec()))
                != observed
                    .as_ref()
                    .map(|m| (m.dev(), m.ino(), m.mode(), m.mtime(), m.mtime_nsec()))
            {
                return Err("concurrent-edit".into());
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if original
                .as_ref()
                .map(|m| (m.creation_time(), m.last_write_time(), m.file_attributes()))
                != observed
                    .as_ref()
                    .map(|m| (m.creation_time(), m.last_write_time(), m.file_attributes()))
            {
                return Err("concurrent-edit".into());
            }
        }
        rc_acl_check(path)?;
        if read_bytes(path)?.as_deref() != before {
            return Err("concurrent-edit".into());
        }
        replace(&tmp, path)?;
        #[cfg(unix)]
        io(fs::File::open(parent).and_then(|f| f.sync_all()))?;
        Ok(())
    })();
    let _ = fs::remove_file(tmp);
    result
}
fn lock(root: &Path) -> Result<fs::File> {
    let p = root.join("cli.lock");
    let existed = fs::symlink_metadata(&p).is_ok();
    if fs::symlink_metadata(&p).is_ok() {
        check(&p, false)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if io(fs::metadata(&p))?.permissions().mode() & 0o777 != 0o600 {
                return Err("lock-permissions".into());
            }
        }
    }
    let mut o = fs::OpenOptions::new();
    o.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let f = io(o.open(&p))?;
    if !existed {
        harden_new(&p, false)?;
    }
    private_check(&p, false, 0o600, false)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // LOCK_EX | LOCK_NB: OS releases the lock on close/process death; no stale PID deletion.
        if unsafe { flock(f.as_raw_fd(), 2 | 4) } != 0 {
            return Err("lock-busy".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct Overlapped {
            internal: usize,
            high: usize,
            offset: u32,
            offset_high: u32,
            event: *mut std::ffi::c_void,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn LockFileEx(
                h: *mut std::ffi::c_void,
                flags: u32,
                reserved: u32,
                low: u32,
                high: u32,
                overlapped: *mut Overlapped,
            ) -> i32;
        }
        let mut v = Overlapped {
            internal: 0,
            high: 0,
            offset: 0,
            offset_high: 0,
            event: std::ptr::null_mut(),
        };
        if unsafe { LockFileEx(f.as_raw_handle(), 1 | 2, 0, 1, 0, &mut v) } == 0 {
            return Err("lock-busy".into());
        }
    }
    Ok(f)
}
impl Store {
    pub fn open(root: PathBuf, rc_allowed: Vec<PathBuf>) -> Result<Self> {
        // Inspect every existing private path before creating even the lock file.
        if fs::symlink_metadata(&root).is_ok() {
            private_check(&root, true, 0o700, true)?;
            for (name, directory, mode) in [
                ("bin", true, 0o700),
                ("journal", true, 0o700),
                ("backups", true, 0o700),
                ("cli.json", false, 0o600),
                ("cli.lock", false, 0o600),
                ("bin/ocx", false, 0o700),
                ("path.sh", false, 0o600),
            ] {
                let path = root.join(name);
                match fs::symlink_metadata(&path) {
                    Ok(_) => private_check(&path, directory, mode, false)?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => return Err("private-acl-unsafe".into()),
                }
                if matches!(name, "journal" | "backups") {
                    for entry in io(fs::read_dir(&path))? {
                        private_check(&io(entry)?.path(), false, 0o600, false)?;
                    }
                }
            }
        }
        private_dir(&root)?;
        let guard = lock(&root)?;
        for name in ["bin", "backups", "journal"] {
            let path = root.join(name);
            if fs::symlink_metadata(&path).is_ok() {
                private_check(&path, true, 0o700, false)?;
            } else {
                private_dir(&path)?;
            }
        }
        let store = Self {
            root,
            rc_allowed,
            _lock: guard,
        };
        let record = store.read()?; // A missing record is a validated empty record.
        store.clean_unreferenced(record.as_ref())?;
        Ok(store)
    }
    fn owned_path(&self, s: &str, r: &Record, next: &Record) -> bool {
        let p = Path::new(s);
        absolute(s)
            && (p == self.root.join("bin/ocx")
                || p == self.root.join("path.sh")
                || self.rc_allowed.iter().any(|r| r == p)
                || [r, next].iter().any(|r| {
                    r.posix
                        .as_ref()
                        .is_some_and(|v| v.rc_files.iter().any(|f| f.path == s))
                }))
    }
    fn backup_path(&self, s: &str) -> bool {
        absolute(s) && Path::new(s).parent() == Some(self.root.join("backups").as_path())
    }
    fn journal_path(&self, s: &str) -> bool {
        let p = Path::new(s);
        if !absolute(s)
            || p.parent() != Some(self.root.join("journal").as_path())
            || p.extension().and_then(|s| s.to_str()) != Some("json")
        {
            return false;
        }
        p.file_stem().and_then(|s| s.to_str()).is_some_and(|s| {
            let parts: Vec<_> = s.split('-').collect();
            let (g, i) = match parts.as_slice() {
                [g, i] => (*g, *i),
                [g, tx, i]
                    if tx.len() == 32
                        && tx
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
                {
                    (*g, *i)
                }
                _ => return false,
            };
            g.parse::<u64>()
                .is_ok_and(|n| n > 0 && n <= 9_007_199_254_740_991)
                && i.parse::<usize>().is_ok_and(|n| n < 32)
        })
    }
    fn clean_unreferenced(&self, record: Option<&Record>) -> Result<()> {
        let referenced: std::collections::HashSet<_> = record
            .and_then(|r| r.pending.as_ref())
            .map(|j| {
                j.changes
                    .iter()
                    .map(|c| Path::new(&c.journal_file))
                    .collect()
            })
            .unwrap_or_default();
        for entry in io(fs::read_dir(self.root.join("journal")))? {
            let entry = io(entry)?;
            let path = entry.path();
            if io(entry.file_type())?.is_file()
                && self.journal_path(&path.to_string_lossy())
                && !referenced.contains(path.as_path())
            {
                io(fs::remove_file(path))?;
            }
        }
        sync_dir(&self.root.join("journal"))
    }
    pub fn validate(&self, r: &Record, nested: bool) -> Result<()> {
        self.validate_for(r, nested, platform())
    }
    fn validate_for(&self, r: &Record, nested: bool, host: &str) -> Result<()> {
        let invalid = || "record-invalid".to_owned();
        if r.version != 1
            || Uuid::parse_str(&r.owner_id).is_err()
            || r.install_id.is_empty()
            || r.install_id.len() > 256
            || r.generation == 0
            || r.generation > 9_007_199_254_740_991
        {
            return Err(invalid());
        }
        if let Some(b) = &r.bundle {
            if !bundle_valid(b, host)
                || (b.platform == "win32" && r.posix.is_some())
                || (b.platform != "win32" && r.windows.is_some())
            {
                return Err(invalid());
            }
        } else if r.enabled || r.posix.is_some() || r.windows.is_some() {
            return Err(invalid());
        }
        if let Some(p) = &r.posix {
            if p.bin_directory != self.root.join("bin").to_string_lossy()
                || p.files.len() > 2
                || p.rc_files.len() > 16
            {
                return Err(invalid());
            }
            let mut paths = std::collections::HashSet::new();
            for f in &p.files {
                let expected = match f.kind.as_str() {
                    "shim" => self.root.join("bin/ocx"),
                    "path-helper" => self.root.join("path.sh"),
                    _ => return Err(invalid()),
                };
                if Path::new(&f.path) != expected || !digest(&f.sha256) || !paths.insert(&f.path) {
                    return Err(invalid());
                }
            }
            for f in &p.rc_files {
                if !matches!(f.shell.as_str(), "zsh" | "bash" | "fish")
                    || !absolute(&f.path)
                    || !paths.insert(&f.path)
                    || !digest(&f.block_sha256)
                    || f.result != "installed"
                    || f.backup_path
                        .as_deref()
                        .is_some_and(|s| !self.backup_path(s))
                {
                    return Err(invalid());
                }
            }
        }
        if let Some(w) = &r.windows {
            if w.key != "HKCU\\Environment"
                || w.value != "Path"
                || !absolute_for(&w.entry, "win32")
                || w.entry.contains(';')
                || !matches!(w.value_type.as_str(), "REG_SZ" | "REG_EXPAND_SZ")
                || !matches!(w.action.as_str(), "inserted" | "moved-existing")
                || [&w.previous_before, &w.previous_after].iter().any(|s| {
                    s.as_ref()
                        .is_some_and(|s| s.contains([';', '\0', '\r', '\n']))
                })
            {
                return Err(invalid());
            }
        }
        if let Some(j) = &r.pending {
            if nested
                || !matches!(j.operation.as_str(), "install" | "remove")
                || j.changes.len() > 32
                || j.next.pending.is_some()
                || r.owner_id != j.next.owner_id
                || r.install_id != j.next.install_id
                || r.enabled != j.next.enabled
                || j.next.generation != r.generation + 1
            {
                return Err(invalid());
            }
            self.validate_for(&j.next, true, host)?;
            let mut paths = std::collections::HashSet::new();
            let mut journals = std::collections::HashSet::new();
            for c in &j.changes {
                if !paths.insert(&c.path)
                    || !journals.insert(&c.journal_file)
                    || !self.journal_path(&c.journal_file)
                    || ![&c.before_sha256, &c.after_sha256]
                        .iter()
                        .all(|s| *s == "absent" || digest(s))
                    || c.backup_path
                        .as_deref()
                        .is_some_and(|s| !self.backup_path(s))
                {
                    return Err(invalid());
                }
                match c.kind.as_str() {
                    "file" if self.owned_path(&c.path, r, &j.next) && c.mode <= 0o777 => {}
                    "registry-sz" | "registry-expand"
                        if host == "win32"
                            && c.path == "HKCU\\Environment\\Path"
                            && c.mode == 0
                            && c.backup_path.is_none() => {}
                    _ => return Err(invalid()),
                }
            }
        }
        Ok(())
    }
    pub fn read(&self) -> Result<Option<Record>> {
        let Some(b) = private_bytes(
            &self.root.join("cli.json"),
            RECORD_LIMIT,
            "record-too-large",
        )?
        else {
            return Ok(None);
        };
        let r: Record = serde_json::from_slice(&b).map_err(|_| "record-invalid")?;
        self.validate(&r, false)?;
        Ok(Some(r))
    }
    fn encoded(&self, r: &Record) -> Result<Vec<u8>> {
        self.validate(r, false)?;
        let b = serde_json::to_vec(r).map_err(|_| "record-invalid")?;
        if b.len() > RECORD_LIMIT {
            return Err("record-too-large".into());
        }
        Ok(b)
    }
    pub fn save(&self, r: &Record) -> Result<()> {
        let b = self.encoded(r)?;
        let p = self.root.join("cli.json");
        let old = private_bytes(&p, RECORD_LIMIT, "record-too-large")?;
        if old.as_deref() == Some(b.as_slice()) {
            return Ok(());
        }
        atomic(&p, old.as_deref(), &b, 0o600)
    }
    fn prepare(
        &self,
        current: &Record,
        mut next: Record,
        changes: &[Change],
        op: &str,
    ) -> Result<Record> {
        next.generation = current.generation + 1;
        next.pending = None;
        let registry_changed = changes.iter().any(|c| c.kind.starts_with("registry-"));
        next.notify_pending |= registry_changed || current.notify_pending;
        let txid = Uuid::new_v4().simple().to_string();
        let mut refs = Vec::new();
        let mut payloads = Vec::new();
        for (i, c) in changes.iter().enumerate() {
            let journal_file = self
                .root
                .join("journal")
                .join(format!("{}-{txid}-{i}.json", next.generation));
            let payload = JournalFile {
                version: 1,
                kind: c.kind.clone(),
                path: c.path.clone(),
                mode: (c.kind == "file").then_some(c.mode),
                before: c.before.as_ref().map(|b| STANDARD.encode(b)),
                after: c.after.as_ref().map(|b| STANDARD.encode(b)),
            };
            let bytes = serde_json::to_vec(&payload).map_err(|_| "journal-invalid")?;
            if bytes.len() > JOURNAL_LIMIT {
                return Err("rc-too-large".into());
            }
            refs.push(PendingChange {
                kind: c.kind.clone(),
                path: c.path.clone(),
                mode: c.mode,
                backup_path: c.backup_path.clone(),
                journal_file: journal_file.to_string_lossy().into_owned(),
                before_sha256: fingerprint(c.before.as_deref()),
                after_sha256: fingerprint(c.after.as_deref()),
            });
            payloads.push((journal_file, bytes));
        }
        let mut pending = current.clone();
        pending.notify_pending |= registry_changed;
        pending.pending = Some(Journal {
            operation: op.into(),
            changes: refs,
            next: Box::new(next),
        });
        self.encoded(&pending)?; // Validate all paths and the 64 KiB bound before creating any journal.
        for (path, bytes) in payloads {
            let old = private_bytes(&path, JOURNAL_LIMIT, "journal-too-large")?;
            if old.as_deref().is_some_and(|old| old != bytes) {
                return Err("journal-conflict".into());
            }
            if old.is_none() {
                atomic(&path, None, &bytes, 0o600)?;
            }
        }
        sync_dir(&self.root.join("journal"))?;
        Ok(pending)
    }
    pub fn transact(
        &self,
        current: &mut Record,
        next: Record,
        changes: Vec<Change>,
        op: &str,
    ) -> Result<()> {
        if changes.is_empty() && *current == next {
            return Ok(());
        }
        let pending = self.prepare(current, next, &changes, op)?;
        self.save(&pending)?;
        *current = pending;
        self.recover(current)
    }
    fn load_change(&self, c: &PendingChange) -> Result<Change> {
        let bytes = private_bytes(
            Path::new(&c.journal_file),
            JOURNAL_LIMIT,
            "journal-too-large",
        )?
        .ok_or("journal-missing")?;
        let j: JournalFile = serde_json::from_slice(&bytes).map_err(|_| "journal-invalid")?;
        let decode = |s: Option<String>| {
            s.map(|s| STANDARD.decode(s).map_err(|_| "journal-invalid".to_owned()))
                .transpose()
        };
        let before = decode(j.before)?;
        let after = decode(j.after)?;
        if j.version != 1
            || j.kind != c.kind
            || j.path != c.path
            || j.mode != (c.kind == "file").then_some(c.mode)
            || fingerprint(before.as_deref()) != c.before_sha256
            || fingerprint(after.as_deref()) != c.after_sha256
        {
            return Err("journal-digest-mismatch".into());
        }
        Ok(Change {
            kind: c.kind.clone(),
            path: c.path.clone(),
            before,
            after,
            mode: c.mode,
            backup_path: c.backup_path.clone(),
        })
    }
    pub fn recover(&self, current: &mut Record) -> Result<()> {
        self.recover_with(
            current,
            crate::cli_command_windows::read_change,
            crate::cli_command_windows::apply_change,
        )
    }
    fn recover_with(
        &self,
        current: &mut Record,
        mut read_registry: impl FnMut(&Change) -> Result<Option<Vec<u8>>>,
        mut write_registry: impl FnMut(&Change) -> Result<()>,
    ) -> Result<()> {
        self.validate(current, false)?;
        let Some(j) = current.pending.clone() else {
            return Ok(());
        };
        let wanted = (j.operation == "install") == current.enabled;
        if j.changes.iter().any(|c| c.kind.starts_with("registry-")) && !current.notify_pending {
            current.notify_pending = true;
            self.save(current)?;
        }
        // State table for BOTH operations: wanted: before -> after, after -> done.
        // Cancelled: before -> leave, after -> before (reverse completed prefix).
        // Any third state or unverifiable journal -> stop, preserve pending and backups.
        let mut changes = j
            .changes
            .iter()
            .map(|c| self.load_change(c))
            .collect::<Result<Vec<_>>>()?;
        if !wanted {
            changes.reverse();
        }
        for c in changes {
            if c.kind == "file" && !Path::new(&c.path).starts_with(&self.root) {
                rc_acl_check(Path::new(&c.path))?;
            }
            let (before, after) = if wanted {
                (&c.before, &c.after)
            } else {
                (&c.after, &c.before)
            };
            let found = if c.kind == "file" {
                read_bytes(Path::new(&c.path))?
            } else {
                read_registry(&c)?
            };
            if found == *after {
                continue;
            }
            if found != *before {
                return Err("journal-conflict".into());
            }
            if wanted {
                if let (Some(name), Some(bytes)) = (&c.backup_path, &c.before) {
                    let p = Path::new(name);
                    if let Some(old) = private_bytes(p, JOURNAL_LIMIT, "backup-too-large")? {
                        if old != *bytes {
                            return Err("backup-conflict".into());
                        }
                    } else {
                        atomic(p, None, bytes, 0o600)?;
                    }
                }
            }
            if c.kind == "file" {
                let p = Path::new(&c.path);
                if !p.starts_with(&self.root) {
                    rc_acl_check(p)?;
                }
                if let Some(b) = after {
                    atomic(p, before.as_deref(), b, c.mode)?;
                } else {
                    if read_bytes(p)? != *before {
                        return Err("concurrent-edit".into());
                    }
                    io(fs::remove_file(p))?;
                    sync_dir(p.parent().ok_or("unsafe-file")?)?;
                }
            } else {
                // Old pending records also acquire debt before replay/rollback writes.
                if !current.notify_pending {
                    current.notify_pending = true;
                    self.save(current)?;
                }
                let mut step = c.clone();
                step.before = before.clone();
                step.after = after.clone();
                write_registry(&step)?;
            }
        }
        let mut settled = if wanted { *j.next } else { current.clone() };
        settled.pending = None;
        settled.notify_pending |= current.notify_pending;
        settled.generation = current.generation + 1;
        self.save(&settled)?;
        *current = settled;
        for c in j.changes {
            io(fs::remove_file(c.journal_file))?;
        }
        sync_dir(&self.root.join("journal"))
    }
    pub fn notify_with(
        &self,
        current: &mut Record,
        broadcast: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        if current.notify_pending {
            broadcast()?;
            let mut settled = current.clone();
            settled.notify_pending = false;
            self.save(&settled)?;
            *current = settled;
        }
        Ok(())
    }
    pub fn journal_issues(&self, r: &Record) -> Vec<String> {
        let referenced: std::collections::HashSet<_> = r
            .pending
            .as_ref()
            .map(|j| j.changes.iter().map(|c| c.journal_file.as_str()).collect())
            .unwrap_or_default();
        let orphan = fs::read_dir(self.root.join("journal"))
            .map(|v| {
                v.filter_map(|e| e.ok())
                    .any(|e| !referenced.contains(e.path().to_string_lossy().as_ref()))
            })
            .unwrap_or(true);
        if orphan {
            vec!["orphan-journal".into()]
        } else {
            Vec::new()
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) struct Temp(pub PathBuf);
    impl Temp {
        pub(crate) fn new() -> Self {
            let p = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("ocx-cli-{}", Uuid::new_v4()));
            private_dir(&p).unwrap();
            Self(p)
        }
        pub(crate) fn store(&self) -> Store {
            Store::open(self.0.join("record"), vec![self.0.join(".zshrc")]).unwrap()
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    pub(crate) fn bundle() -> Bundle {
        let (app, cli, kind) = match platform() {
            "win32" => (
                "C:\\Desktop\\app.exe",
                "C:\\Desktop\\ocx.exe",
                "windows-install",
            ),
            "darwin" => (
                "/Applications/Desktop.app/Contents/MacOS/app",
                "/Applications/Desktop.app/Contents/MacOS/ocx",
                "macos-app",
            ),
            _ => ("/usr/bin/app", "/usr/bin/ocx", "linux-deb"),
        };
        Bundle {
            platform: platform().into(),
            kind: kind.into(),
            app_executable: app.into(),
            cli_executable: cli.into(),
            version: "1".into(),
        }
    }
    fn change(p: &Path) -> Change {
        Change {
            kind: "file".into(),
            path: p.to_string_lossy().into_owned(),
            before: Some(b"old".to_vec()),
            after: Some(b"new".to_vec()),
            mode: 0o600,
            backup_path: None,
        }
    }
    #[test]
    fn shared_record_fixtures_match_host_contract_and_first_pending_shape() {
        let t = Temp::new();
        let s = t.store();
        for (json, host, valid) in [
            (
                include_str!("../../../tests/fixtures/desktop-cli-record/notify-pending.json"),
                "win32",
                true,
            ),
            (
                include_str!("../../../tests/fixtures/desktop-cli-record/valid-darwin.json"),
                "darwin",
                true,
            ),
            (
                include_str!("../../../tests/fixtures/desktop-cli-record/valid-win32.json"),
                "win32",
                true,
            ),
            (
                include_str!("../../../tests/fixtures/desktop-cli-record/valid-linux.json"),
                "linux",
                true,
            ),
            (
                include_str!("../../../tests/fixtures/desktop-cli-record/disabled-tombstone.json"),
                "darwin",
                true,
            ),
            (
                include_str!("../../../tests/fixtures/desktop-cli-record/pending-enabled.json"),
                "darwin",
                true,
            ),
            (
                include_str!(
                    "../../../tests/fixtures/desktop-cli-record/disabled-with-pending.json"
                ),
                "darwin",
                true,
            ),
            (
                include_str!("../../../tests/fixtures/desktop-cli-record/appimage-kind.json"),
                "darwin",
                false,
            ),
            (
                include_str!("../../../tests/fixtures/desktop-cli-record/relative-target.json"),
                "darwin",
                false,
            ),
            (
                include_str!("../../../tests/fixtures/desktop-cli-record/dotdot-target.json"),
                "darwin",
                false,
            ),
            (
                include_str!("../../../tests/fixtures/desktop-cli-record/first-pending.json"),
                "darwin",
                true,
            ),
        ] {
            // Windows roots carry backslashes, which must stay escaped inside the JSON text.
            let root = s.root.to_str().unwrap().replace('\\', "\\\\");
            let json = json.replace("/fixture/desktop", &root);
            let r: Record = serde_json::from_str(&json).unwrap();
            // Path rules follow the real host, so a Windows test run cannot simulate a POSIX host.
            // There it checks the real contract instead: any record carrying another platform's
            // bundle is refused, and only a bundle-less disabled tombstone stays valid.
            if cfg!(windows) && host != "win32" {
                let tombstone = !r.enabled && r.bundle.is_none();
                assert_eq!(
                    s.validate(&r, false).is_ok(),
                    tombstone,
                    "{host} fixture on win32"
                );
                continue;
            }
            assert_eq!(
                s.validate_for(&r, false, host).is_ok(),
                valid,
                "{host} fixture: {json}"
            );
            if r.enabled && r.bundle.as_ref().unwrap().platform != platform() {
                assert!(s.validate(&r, false).is_err());
            }
        }
    }
    #[test]
    fn record_roundtrip_validation_and_limits() {
        let t = Temp::new();
        let s = t.store();
        let r = Record::fresh(bundle());
        s.save(&r).unwrap();
        assert_eq!(s.read().unwrap(), Some(r.clone()));
        let mut bad = r.clone();
        bad.version = 2;
        assert!(s.save(&bad).is_err());
        bad = r.clone();
        bad.bundle = None;
        assert!(s.save(&bad).is_err());
        bad = r.clone();
        bad.generation = 9_007_199_254_740_992;
        assert!(s.save(&bad).is_err());
        bad = r.clone();
        bad.owner_id = "bad".into();
        assert!(s.save(&bad).is_err());
        bad = r.clone();
        bad.bundle.as_mut().unwrap().version = "x".repeat(RECORD_LIMIT);
        assert_eq!(s.save(&bad).unwrap_err(), "record-too-large");
        let p = s.root.join("cli.json");
        let old = read_bytes(&p).unwrap().unwrap();
        atomic(&p, Some(&old), &vec![b' '; RECORD_LIMIT + 1], 0o600).unwrap();
        assert_eq!(s.read().unwrap_err(), "record-too-large");
    }
    #[test]
    fn unsaved_first_transaction_journals_are_cleaned_on_reopen() {
        let t = Temp::new();
        let s = t.store();
        let p = t.0.join(".zshrc");
        atomic(&p, None, b"old", 0o600).unwrap();
        let mut r = Record::fresh(bundle());
        let pending = s.prepare(&r, r.clone(), &[change(&p)], "install").unwrap();
        let leftover = pending.pending.unwrap().changes[0].journal_file.clone();
        assert!(Path::new(&leftover).is_file());
        drop(s);
        let s = t.store();
        assert!(!Path::new(&leftover).exists());
        let mut c = change(&p);
        c.after = Some(b"different".to_vec());
        s.transact(&mut r.clone(), r.clone(), vec![c], "install")
            .unwrap();
        r = s.read().unwrap().unwrap();
        assert!(r.pending.is_none());
        assert_eq!(fs::read(p).unwrap(), b"different");
    }
    #[test]
    fn final_save_before_journal_deletion_is_cleaned_on_reopen() {
        let t = Temp::new();
        let s = t.store();
        let p = t.0.join(".zshrc");
        let r = Record::fresh(bundle());
        atomic(&p, None, b"old", 0o600).unwrap();
        let pending = s.prepare(&r, r.clone(), &[change(&p)], "install").unwrap();
        let journal = pending.pending.as_ref().unwrap();
        atomic(&p, Some(b"old"), b"new", 0o600).unwrap();
        s.save(&journal.next).unwrap();
        let leftover = journal.changes[0].journal_file.clone();
        drop(s);
        let s = t.store();
        assert!(!Path::new(&leftover).exists());
        assert!(s.read().unwrap().unwrap().pending.is_none());
        assert_eq!(fs::read(p).unwrap(), b"new");
    }
    #[test]
    fn corrupt_record_preserves_all_journals_on_reopen() {
        let t = Temp::new();
        let s = t.store();
        let r = Record::fresh(bundle());
        let pending = s
            .prepare(&r, r.clone(), &[change(&t.0.join(".zshrc"))], "install")
            .unwrap();
        let leftover = pending.pending.unwrap().changes[0].journal_file.clone();
        let bytes = fs::read(&leftover).unwrap();
        atomic(&s.root.join("cli.json"), None, b"{", 0o600).unwrap();
        drop(s);
        assert!(Store::open(t.0.join("record"), vec![]).is_err());
        assert!(fs::read(leftover).unwrap() == bytes);
    }
    #[test]
    fn referenced_legacy_and_txid_journals_survive_cleanup() {
        for legacy in [false, true] {
            let t = Temp::new();
            let s = t.store();
            let r = Record::fresh(bundle());
            let p = t.0.join(".zshrc");
            atomic(&p, None, b"old", 0o600).unwrap();
            let mut pending = s.prepare(&r, r.clone(), &[change(&p)], "install").unwrap();
            let c = &mut pending.pending.as_mut().unwrap().changes[0];
            if legacy {
                let old = s.root.join("journal/2-0.json");
                fs::rename(&c.journal_file, &old).unwrap();
                c.journal_file = old.to_string_lossy().into_owned();
            }
            let referenced = c.journal_file.clone();
            s.save(&pending).unwrap();
            atomic(&s.root.join("journal/unrelated.txt"), None, b"keep", 0o600).unwrap();
            drop(s);
            let s = t.store();
            assert!(Path::new(&referenced).is_file());
            assert!(s.root.join("journal/unrelated.txt").is_file());
            s.recover(&mut pending).unwrap();
            assert_eq!(fs::read(p).unwrap(), b"new");
        }
    }
    #[test]
    fn broadcast_debt_survives_failure_and_remove_then_retries_once() {
        let t = Temp::new();
        let s = t.store();
        let mut r = Record::fresh(bundle());
        r.notify_pending = true;
        s.save(&r).unwrap();
        assert_eq!(
            s.notify_with(&mut r, || Err("environment-broadcast-failed".into()))
                .unwrap_err(),
            "environment-broadcast-failed"
        );
        assert!(s.read().unwrap().unwrap().notify_pending);
        r.enabled = false;
        r.windows = None;
        s.save(&r).unwrap();
        drop(s);
        let s = t.store();
        let mut r = s.read().unwrap().unwrap();
        let count = std::cell::Cell::new(0);
        s.notify_with(&mut r, || {
            count.set(count.get() + 1);
            Ok(())
        })
        .unwrap();
        s.notify_with(&mut r, || panic!("settled debt must not broadcast again"))
            .unwrap();
        assert_eq!(count.get(), 1);
        assert!(!s.read().unwrap().unwrap().notify_pending);
    }
    #[cfg(windows)]
    #[test]
    fn registry_install_remove_recovery_and_rollback_keep_durable_broadcast_debt() {
        use std::cell::RefCell;
        for scenario in ["install", "remove", "rollback", "crash-after-write"] {
            let t = Temp::new();
            let s = t.store();
            let mut current = Record::fresh(bundle());
            let mut next = current.clone();
            let (_, owned) =
                crate::cli_command_windows::prepend("old", r"C:\Desktop", "REG_SZ").unwrap();
            if scenario == "remove" {
                current.enabled = false;
                current.windows = Some(owned);
                next = current.clone();
                next.windows = None;
            } else {
                next.windows = Some(owned);
            }
            let c = Change {
                kind: "registry-sz".into(),
                path: "HKCU\\Environment\\Path".into(),
                before: Some(b"old".to_vec()),
                after: Some(b"new".to_vec()),
                mode: 0,
                backup_path: None,
            };
            current = s
                .prepare(
                    &current,
                    next,
                    &[c],
                    if scenario == "remove" {
                        "remove"
                    } else {
                        "install"
                    },
                )
                .unwrap();
            assert!(current.notify_pending);
            s.save(&current).unwrap();
            let registry = RefCell::new(Some(
                if matches!(scenario, "rollback" | "crash-after-write") {
                    b"new".to_vec()
                } else {
                    b"old".to_vec()
                },
            ));
            if scenario == "rollback" {
                current.enabled = false;
                current.pending.as_mut().unwrap().next.enabled = false;
                // Exercise legacy debt acquisition in the save that starts rollback.
                current.notify_pending = false;
                s.save(&current).unwrap();
            }
            s.recover_with(
                &mut current,
                |_| Ok(registry.borrow().clone()),
                |c| {
                    assert!(s.read().unwrap().unwrap().notify_pending);
                    *registry.borrow_mut() = c.after.clone();
                    Ok(())
                },
            )
            .unwrap();
            assert!(current.pending.is_none() && current.notify_pending);
            assert_eq!(
                registry.into_inner().unwrap(),
                if scenario == "rollback" {
                    b"old"
                } else {
                    b"new"
                }
            );
            if scenario == "remove" {
                assert!(current.windows.is_none());
            }
            assert!(s
                .notify_with(&mut current, || Err("environment-broadcast-failed".into()))
                .is_err());
            assert!(s.read().unwrap().unwrap().notify_pending);
            drop(s);
            let s = t.store();
            let mut current = s.read().unwrap().unwrap();
            let count = std::cell::Cell::new(0);
            s.notify_with(&mut current, || {
                count.set(count.get() + 1);
                Ok(())
            })
            .unwrap();
            s.notify_with(&mut current, || panic!("broadcast-must-not-repeat"))
                .unwrap();
            assert_eq!(count.get(), 1);
            assert!(!s.read().unwrap().unwrap().notify_pending);
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn rc_acl_refuses_replay_and_rollback_without_losing_pending_ownership() {
        for rollback in [false, true] {
            let t = Temp::new();
            let s = t.store();
            let p = t.0.join(".zshrc");
            let mut r = Record::fresh(bundle());
            atomic(&p, None, if rollback { b"new" } else { b"old" }, 0o600).unwrap();
            r = s.prepare(&r, r.clone(), &[change(&p)], "install").unwrap();
            if rollback {
                r.enabled = false;
                r.pending.as_mut().unwrap().next.enabled = false;
            }
            s.save(&r).unwrap();
            chmod_acl(&p, true);
            assert_eq!(s.recover(&mut r).unwrap_err(), "rc-acl-present");
            assert!(s.read().unwrap().unwrap().pending.is_some());
            assert_eq!(
                fs::read(&p).unwrap(),
                if rollback { b"new" } else { b"old" }
            );
            assert!(rc_acl_check(&p).is_err());
            chmod_acl(&p, false);
            s.recover(&mut r).unwrap();
            assert_eq!(fs::read(p).unwrap(), if rollback { b"old" } else { b"new" });
        }
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn chmod_acl(path: &Path, add: bool) {
        let mut command = std::process::Command::new("/bin/chmod");
        if add {
            command.args(["+a", if path.is_dir() { "everyone allow read,readattr,readextattr,readsecurity,file_inherit,directory_inherit" } else { "everyone allow read,readattr,readextattr,readsecurity" }]);
        } else {
            command.arg("-N");
        }
        assert!(
            command
                .arg(path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success(),
            "acl-command-failed"
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn acl_empty_missing_inherited_and_new_store_contract() {
        let t = Temp::new();
        assert!(!acl::present(&t.0).unwrap());
        assert!(acl::present(&t.0.join("missing")).is_err());
        chmod_acl(&t.0, true);
        let inherited = t.0.join("inherited");
        fs::create_dir(&inherited).unwrap();
        fs::set_permissions(&inherited, {
            use std::os::unix::fs::PermissionsExt;
            fs::Permissions::from_mode(0o700)
        })
        .unwrap();
        assert!(acl::present(&inherited).unwrap());
        assert!(private_dir(&inherited).is_err());
        chmod_acl(&inherited, false);
        private_dir(&inherited).unwrap();
        let s = t.store();
        assert!(!acl::present(&s.root).unwrap());
        atomic(&s.root.join("journal/2-0.json"), None, b"test", 0o600).unwrap();
        assert!(!acl::present(&s.root.join("journal/2-0.json")).unwrap());
        let root = s.root.clone();
        drop(s);
        Store::open(root, vec![]).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn existing_private_acl_is_refused_before_any_store_write() {
        for name in [
            "",
            "bin",
            "journal",
            "backups",
            "cli.json",
            "cli.lock",
            "bin/ocx",
            "path.sh",
            "journal/2-0.json",
            "backups/test",
        ] {
            let t = Temp::new();
            let s = t.store();
            s.save(&Record::fresh(bundle())).unwrap();
            for (file, mode) in [
                ("bin/ocx", 0o700),
                ("path.sh", 0o600),
                ("journal/2-0.json", 0o600),
                ("backups/test", 0o600),
            ] {
                atomic(&s.root.join(file), None, b"keep", mode).unwrap();
            }
            let record = fs::read(s.root.join("cli.json")).unwrap();
            let root = s.root.clone();
            drop(s);
            chmod_acl(&root.join(name), true);
            assert!(Store::open(root.clone(), vec![]).is_err());
            assert!(fs::read(root.join("cli.json")).unwrap() == record);
            assert!(root.join("journal/2-0.json").is_file());
            chmod_acl(&root.join(name), false);
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_acl_inheritance_clear_and_existing_child_refusal() {
        let t = Temp::new();
        let set = |path: &Path, spec: &str| {
            std::process::Command::new("setfacl")
                .args(["-m", spec])
                .arg(path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
        };
        let result = set(&t.0, "d:u:65534:rwx");
        if result
            .as_ref()
            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            eprintln!("acl-test-skipped-setfacl-unavailable");
            return;
        }
        assert!(result.unwrap().success(), "acl-command-failed");
        let s = t.store();
        assert!(!acl::present(&s.root).unwrap());
        let p = s.root.join("backups/test");
        atomic(&p, None, b"keep", 0o600).unwrap();
        assert!(!acl::present(&p).unwrap());
        assert!(set(&p, "u:65534:r--").unwrap().success());
        // Keep the numeric mode private so this negative specifically proves ACL inspection.
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let root = s.root.clone();
        drop(s);
        assert!(Store::open(root, vec![]).is_err());
    }
    #[test]
    fn corrupt_record_does_not_become_first_run() {
        let t = Temp::new();
        let s = t.store();
        atomic(&s.root.join("cli.json"), None, b"{", 0o600).unwrap();
        assert_eq!(s.read().unwrap_err(), "record-invalid");
    }
    #[test]
    fn external_journal_recovery_state_table_and_idempotence() {
        for op in ["install", "remove"] {
            for wanted in [false, true] {
                for state in ["before", "after", "other"] {
                    let t = Temp::new();
                    let s = t.store();
                    let p = t.0.join(".zshrc");
                    let mut r = Record::fresh(bundle());
                    r.enabled = (op == "install") == wanted;
                    let c = change(&p);
                    let bytes = match state {
                        "before" => b"old",
                        "after" => b"new",
                        _ => b"usr",
                    };
                    atomic(&p, None, bytes, 0o600).unwrap();
                    r = s.prepare(&r, r.clone(), &[c], op).unwrap();
                    s.save(&r).unwrap();
                    let result = s.recover(&mut r);
                    if state == "other" {
                        assert_eq!(result.unwrap_err(), "journal-conflict");
                        assert_eq!(fs::read(&p).unwrap(), b"usr");
                        assert!(s.read().unwrap().unwrap().pending.is_some());
                    } else {
                        result.unwrap();
                        assert_eq!(fs::read(&p).unwrap(), if wanted { b"new" } else { b"old" });
                        assert!(r.pending.is_none());
                        s.recover(&mut r).unwrap();
                        assert_eq!(fs::read_dir(s.root.join("journal")).unwrap().count(), 0);
                    }
                }
            }
        }
    }
    #[test]
    fn journal_digest_mismatch_and_unauthorized_paths_are_refused() {
        let t = Temp::new();
        let s = t.store();
        let mut r = Record::fresh(bundle());
        assert!(s
            .prepare(&r, r.clone(), &[change(&t.0.join("unowned"))], "install")
            .is_err());
        r = s
            .prepare(&r, r.clone(), &[change(&t.0.join(".zshrc"))], "install")
            .unwrap();
        let c = &r.pending.as_ref().unwrap().changes[0];
        let p = Path::new(&c.journal_file);
        let old = read_bytes(p).unwrap().unwrap();
        let mut j: JournalFile = serde_json::from_slice(&old).unwrap();
        j.after = Some(STANDARD.encode(b"tampered"));
        atomic(p, Some(&old), &serde_json::to_vec(&j).unwrap(), 0o600).unwrap();
        s.save(&r).unwrap();
        assert_eq!(s.recover(&mut r).unwrap_err(), "journal-digest-mismatch");
        assert!(s.read().unwrap().unwrap().pending.is_some());
    }
    #[test]
    fn oversize_journal_and_change_roster_are_refused_before_save() {
        let t = Temp::new();
        let s = t.store();
        let r = Record::fresh(bundle());
        let mut c = change(&t.0.join(".zshrc"));
        c.after = Some(vec![b'x'; JOURNAL_LIMIT]);
        assert_eq!(
            s.prepare(&r, r.clone(), &[c], "install").unwrap_err(),
            "rc-too-large"
        );
        assert!(s
            .prepare(
                &r,
                r.clone(),
                &vec![change(&t.0.join(".zshrc")); 33],
                "install"
            )
            .is_err());
        assert!(s.read().unwrap().is_none());
        assert_eq!(fs::read_dir(s.root.join("journal")).unwrap().count(), 0);
    }
    #[test]
    fn disabled_pending_install_rolls_back_every_completed_prefix() {
        for prefix in 0..=2 {
            let t = Temp::new();
            let s = t.store();
            let mut r = Record::fresh(bundle());
            let changes: Vec<_> = [s.root.join("bin/ocx"), s.root.join("path.sh")]
                .iter()
                .map(|p| {
                    let mut c = change(p);
                    c.before = None;
                    c
                })
                .collect();
            r = s.prepare(&r, r.clone(), &changes, "install").unwrap();
            s.save(&r).unwrap();
            for c in changes.iter().take(prefix) {
                atomic(Path::new(&c.path), None, c.after.as_ref().unwrap(), c.mode).unwrap();
            }
            r.enabled = false;
            r.generation += 1;
            let j = r.pending.as_mut().unwrap();
            j.next.enabled = false;
            j.next.generation = r.generation + 1;
            s.save(&r).unwrap();
            let mut reloaded = s.read().unwrap().unwrap();
            s.recover(&mut reloaded).unwrap();
            assert!(!reloaded.enabled && reloaded.pending.is_none());
            for c in changes {
                assert!(!Path::new(&c.path).exists());
            }
        }
    }
    #[test]
    fn large_rc_bytes_stay_in_external_private_journal_and_backup() {
        let t = Temp::new();
        let s = t.store();
        let p = t.0.join(".zshrc");
        let r = Record::fresh(bundle());
        let mut c = change(&p);
        c.before = Some(vec![b'x'; 256 * 1024]);
        c.backup_path = Some(
            s.root
                .join("backups/original")
                .to_string_lossy()
                .into_owned(),
        );
        atomic(&p, None, c.before.as_ref().unwrap(), 0o600).unwrap();
        let mut pending = s.prepare(&r, r.clone(), &[c.clone()], "install").unwrap();
        s.save(&pending).unwrap();
        assert!(fs::metadata(s.root.join("cli.json")).unwrap().len() < RECORD_LIMIT as u64);
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(s.root.join("cli.json")).unwrap()).unwrap();
        assert!(json["pending"]["changes"][0].get("before").is_none());
        assert!(private_bytes(
            Path::new(&pending.pending.as_ref().unwrap().changes[0].journal_file),
            JOURNAL_LIMIT,
            "limit"
        )
        .unwrap()
        .is_some());
        s.recover(&mut pending).unwrap();
        assert_eq!(fs::read(c.backup_path.unwrap()).unwrap(), c.before.unwrap());
    }
    #[cfg(unix)]
    #[test]
    fn rc_ownership_limit_and_lexical_path_validation_are_independent_of_desired_targets() {
        let t = Temp::new();
        let s = t.store();
        let mut r = Record::fresh(bundle());
        r.posix = Some(Posix {
            bin_directory: s.root.join("bin").to_string_lossy().into_owned(),
            files: vec![],
            rc_files: (0..16)
                .map(|i| RcFile {
                    shell: "zsh".into(),
                    path: t.0.join(format!("old-{i}")).to_string_lossy().into_owned(),
                    block_sha256: hash(b"block"),
                    created: true,
                    backup_path: None,
                    result: "installed".into(),
                })
                .collect(),
        });
        s.validate(&r, false).unwrap();
        let mut extra = r.posix.as_ref().unwrap().rc_files[0].clone();
        extra.path = t.0.join("extra").to_string_lossy().into_owned();
        r.posix.as_mut().unwrap().rc_files.push(extra);
        assert!(s.validate(&r, false).is_err());
        r.posix.as_mut().unwrap().rc_files.pop();
        for bad in [
            "relative",
            "/example/./ocx",
            "/example/../ocx",
            "/example/ocx\n",
            "/example/ocx\0",
        ] {
            r.bundle.as_mut().unwrap().cli_executable = bad.into();
            assert!(s.validate(&r, false).is_err());
        }
        r.bundle.as_mut().unwrap().cli_executable = format!("/{}", "x".repeat(4096));
        assert!(s.validate(&r, false).is_err());
    }
    #[test]
    fn lock_and_atomic_write_preserve_concurrent_user_edits() {
        let t = Temp::new();
        let s = t.store();
        assert!(Store::open(s.root.clone(), vec![]).is_err());
        drop(s);
        let _s = t.store();
        let p = t.0.join("file");
        atomic(&p, None, b"user", 0o600).unwrap();
        assert_eq!(
            atomic(&p, Some(b"old"), b"replacement", 0o600).unwrap_err(),
            "concurrent-edit"
        );
        assert_eq!(fs::read(p).unwrap(), b"user");
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_special_files_readonly_and_unsafe_parents_are_refused() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let t = Temp::new();
        let p = t.0.join("file");
        atomic(&p, None, b"bytes", 0o600).unwrap();
        symlink(&p, t.0.join("link")).unwrap();
        assert!(read_bytes(&t.0.join("link")).is_err());
        assert!(check(&t.0, false).is_err());
        fs::set_permissions(&p, fs::Permissions::from_mode(0o400)).unwrap();
        assert!(read_bytes(&p).is_err());
        symlink(&t.0, t.0.join("parent")).unwrap();
        assert!(atomic(&t.0.join("parent/child"), None, b"x", 0o600).is_err());
    }
}
