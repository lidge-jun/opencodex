use crate::protocol::{CanonicalPaths, CommandOutcome, HelperRequest, PROTOCOL_VERSION};
use std::ffi::{OsStr, OsString, c_void};
use std::fs;
use std::io::Read;
use std::mem::{align_of, size_of};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, LocalFree, SetHandleInformation, WAIT_FAILED,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile,
};
use windows_sys::Win32::Security::{FreeSid, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
    InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject,
};

const MAX_JOB_PROCESSES: u32 = 256;

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain([0]).collect()
}

fn last_error(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE, context: &str) -> Result<Self, String> {
        if handle.is_null() {
            Err(last_error(context))
        } else {
            Ok(Self(handle))
        }
    }

    fn raw(&self) -> HANDLE {
        self.0
    }

    fn into_raw(mut self) -> HANDLE {
        let handle = self.0;
        self.0 = null_mut();
        handle
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this wrapper uniquely owns a valid Win32 handle.
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct AppContainerProfile {
    name: Vec<u16>,
    sid: PSID,
}

impl AppContainerProfile {
    fn create() -> Result<Self, String> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "system clock is unavailable".to_owned())?
            .as_nanos();
        let display = format!("OpenCodex Remote Workspace {}-{nonce}", std::process::id());
        let name = wide(format!(
            "opencodex.remote.workspace.{}.{nonce}",
            std::process::id()
        ));
        let display_wide = wide(&display);
        let mut sid = null_mut();
        // SAFETY: all strings are NUL-terminated and sid points to writable storage. The profile
        // owns the returned SID and releases it with FreeSid.
        let result = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                display_wide.as_ptr(),
                display_wide.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result < 0 || sid.is_null() {
            return Err(format!(
                "could not create Windows AppContainer profile (HRESULT {result:#x})"
            ));
        }
        Ok(Self { name, sid })
    }

    fn sid_string(&self) -> Result<String, String> {
        let mut raw = null_mut();
        // SAFETY: the profile owns a valid SID and raw points to writable PWSTR storage.
        if unsafe { ConvertSidToStringSidW(self.sid, &mut raw) } == 0 || raw.is_null() {
            return Err(last_error("could not render AppContainer SID"));
        }
        let mut length = 0usize;
        // SAFETY: ConvertSidToStringSidW returns a NUL-terminated allocation.
        unsafe {
            while *raw.add(length) != 0 {
                length += 1;
            }
        }
        // SAFETY: the allocation contains length initialized UTF-16 code units.
        let value = OsString::from_wide(unsafe { std::slice::from_raw_parts(raw, length) })
            .to_string_lossy()
            .into_owned();
        // SAFETY: ConvertSidToStringSidW documents LocalFree for this allocation.
        unsafe { LocalFree(raw.cast()) };
        Ok(value)
    }
}

impl Drop for AppContainerProfile {
    fn drop(&mut self) {
        // SAFETY: the name is NUL-terminated and the SID was allocated by the profile API.
        unsafe {
            DeleteAppContainerProfile(self.name.as_ptr());
            FreeSid(self.sid);
        }
    }
}

struct AttributeList {
    pointer: *mut c_void,
    layout: std::alloc::Layout,
}

impl AttributeList {
    fn create(count: u32) -> Result<Self, String> {
        let mut size = 0usize;
        // SAFETY: the documented sizing call accepts a null list and fills size.
        unsafe { InitializeProcThreadAttributeList(null_mut(), count, 0, &mut size) };
        let layout = std::alloc::Layout::from_size_align(size, align_of::<usize>())
            .map_err(|_| "invalid process attribute allocation".to_owned())?;
        // SAFETY: layout has non-zero size returned by the Win32 sizing call.
        let pointer = unsafe { std::alloc::alloc_zeroed(layout) }.cast::<c_void>();
        if pointer.is_null() {
            return Err("could not allocate process attribute list".to_owned());
        }
        // SAFETY: pointer references layout.size() writable bytes with pointer alignment.
        if unsafe { InitializeProcThreadAttributeList(pointer, count, 0, &mut size) } == 0 {
            // SAFETY: pointer was allocated with layout above and initialization failed.
            unsafe { std::alloc::dealloc(pointer.cast(), layout) };
            return Err(last_error("could not initialize process attribute list"));
        }
        Ok(Self { pointer, layout })
    }

    fn update<T>(&mut self, attribute: usize, value: &T) -> Result<(), String> {
        // SAFETY: the list is initialized and value remains alive through CreateProcessW.
        if unsafe {
            UpdateProcThreadAttribute(
                self.pointer,
                0,
                attribute,
                (value as *const T).cast(),
                size_of::<T>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last_error("could not update process attribute list"));
        }
        Ok(())
    }

    fn update_slice<T>(&mut self, attribute: usize, values: &[T]) -> Result<(), String> {
        let size = size_of::<T>()
            .checked_mul(values.len())
            .ok_or_else(|| "process attribute is too large".to_owned())?;
        // SAFETY: the initialized list and non-empty slice remain alive through CreateProcessW.
        if values.is_empty()
            || unsafe {
                UpdateProcThreadAttribute(
                    self.pointer,
                    0,
                    attribute,
                    values.as_ptr().cast(),
                    size,
                    null_mut(),
                    null(),
                )
            } == 0
        {
            return Err(last_error("could not update process handle allowlist"));
        }
        Ok(())
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: pointer references a successfully initialized list, then the matching allocation.
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
            std::alloc::dealloc(self.pointer.cast(), self.layout);
        }
    }
}

struct AclGrants {
    icacls: PathBuf,
    sid: String,
    paths: Vec<PathBuf>,
}

impl AclGrants {
    fn new(system32: &Path, sid: String) -> Self {
        Self {
            icacls: system32.join("icacls.exe"),
            sid,
            paths: Vec::new(),
        }
    }

    fn grant(&mut self, path: &Path, permission: &str) -> Result<(), String> {
        if self.paths.iter().any(|existing| existing == path) {
            return Ok(());
        }
        let principal = format!("*{}:(OI)(CI){permission}", self.sid);
        let status = Command::new(&self.icacls)
            .arg(path)
            .arg("/grant")
            .arg(principal)
            .arg("/Q")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| "could not start icacls for AppContainer grant".to_owned())?;
        if !status.success() {
            return Err("could not grant AppContainer workspace access".to_owned());
        }
        self.paths.push(path.to_owned());
        Ok(())
    }
}

impl Drop for AclGrants {
    fn drop(&mut self) {
        for path in self.paths.iter().rev() {
            let principal = format!("*{}", self.sid);
            let _ = Command::new(&self.icacls)
                .arg(path)
                .arg("/remove:g")
                .arg(principal)
                .arg("/Q")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

fn system32() -> Result<PathBuf, String> {
    let root = std::env::var_os("SystemRoot")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "SystemRoot is unavailable".to_owned())?;
    let path = PathBuf::from(root).join("System32");
    path.canonicalize()
        .map_err(|_| "Windows System32 is unavailable".to_owned())
}

fn within_any(candidate: &Path, roots: &[&Path]) -> bool {
    roots.iter().any(|root| candidate.starts_with(root))
}

fn resolve_executable(
    command: &str,
    paths: &CanonicalPaths,
    system32: &Path,
) -> Result<PathBuf, String> {
    let input = Path::new(command);
    let system_powershell = system32.join("WindowsPowerShell").join("v1.0");
    let roots = std::iter::once(paths.root.as_path())
        .chain(paths.toolchain_roots.iter().map(PathBuf::as_path))
        .chain([system32, system_powershell.as_path()])
        .collect::<Vec<_>>();
    let mut candidates = Vec::new();
    if input.is_absolute() || command.contains(['\\', '/']) {
        candidates.push(if input.is_absolute() {
            input.to_owned()
        } else {
            paths.cwd.join(input)
        });
    } else {
        let has_extension = input.extension().is_some();
        for root in &roots {
            if has_extension {
                candidates.push(root.join(input));
            } else {
                for extension in [".com", ".exe", ".bat", ".cmd"] {
                    candidates.push(root.join(format!("{command}{extension}")));
                }
            }
        }
    }
    for candidate in candidates {
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if canonical.is_file() && within_any(&canonical, &roots) {
            return Ok(canonical);
        }
    }
    Err("remote workspace command executable is outside approved roots or unavailable".to_owned())
}

fn quote_windows_arg(value: &OsStr) -> String {
    let text = value.to_string_lossy();
    if !text.is_empty()
        && !text
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return text.into_owned();
    }
    let mut result = String::from("\"");
    let mut backslashes = 0usize;
    for character in text.chars() {
        if character == '\\' {
            backslashes += 1;
            continue;
        }
        if character == '"' {
            result.push_str(&"\\".repeat(backslashes * 2 + 1));
            result.push('"');
        } else {
            result.push_str(&"\\".repeat(backslashes));
            result.push(character);
        }
        backslashes = 0;
    }
    result.push_str(&"\\".repeat(backslashes * 2));
    result.push('"');
    result
}

fn escape_cmd_token(value: &str, quote: bool, double_escape: bool) -> String {
    const META: &str = "()[]%!^\"`<>&|;, *?";
    let mut prepared = if quote {
        let mut escaped = String::new();
        let mut backslashes = 0usize;
        for character in value.chars() {
            if character == '\\' {
                backslashes += 1;
            } else {
                if character == '"' {
                    escaped.push_str(&"\\".repeat(backslashes * 2 + 1));
                } else {
                    escaped.push_str(&"\\".repeat(backslashes));
                }
                escaped.push(character);
                backslashes = 0;
            }
        }
        escaped.push_str(&"\\".repeat(backslashes * 2));
        format!("\"{escaped}\"")
    } else {
        value.to_owned()
    };
    let passes = if double_escape { 2 } else { 1 };
    for _ in 0..passes {
        let mut escaped = String::with_capacity(prepared.len());
        for character in prepared.chars() {
            if META.contains(character) {
                escaped.push('^');
            }
            escaped.push(character);
        }
        prepared = escaped;
    }
    prepared
}

fn invocation(
    request: &HelperRequest,
    paths: &CanonicalPaths,
    system32: &Path,
) -> Result<(PathBuf, Vec<u16>), String> {
    let executable = resolve_executable(&request.command[0], paths, system32)?;
    let extension = executable
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
        let command_path = executable.to_string_lossy();
        let double_escape = command_path
            .to_ascii_lowercase()
            .contains("node_modules\\.bin\\");
        let line = std::iter::once(escape_cmd_token(&command_path, false, false))
            .chain(
                request
                    .command
                    .iter()
                    .skip(1)
                    .map(|arg| escape_cmd_token(arg, true, double_escape)),
            )
            .collect::<Vec<_>>()
            .join(" ");
        let cmd = system32.join("cmd.exe");
        let command_line = format!("{} /d /s /c \"{line}\"", quote_windows_arg(cmd.as_os_str()));
        Ok((cmd, wide(command_line)))
    } else {
        let command_line = std::iter::once(quote_windows_arg(executable.as_os_str()))
            .chain(
                request
                    .command
                    .iter()
                    .skip(1)
                    .map(|arg| quote_windows_arg(OsStr::new(arg))),
            )
            .collect::<Vec<_>>()
            .join(" ");
        Ok((executable, wide(command_line)))
    }
}

fn ordinary_windows_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    value
        .strip_prefix(r"\\?\")
        .unwrap_or(value.as_ref())
        .to_owned()
}

fn environment(
    paths: &CanonicalPaths,
    system32: &Path,
    temporary: &Path,
) -> Result<Vec<u16>, String> {
    let path = paths
        .toolchain_roots
        .iter()
        .chain(
            [
                system32.to_owned(),
                system32.join("WindowsPowerShell").join("v1.0"),
            ]
            .iter(),
        )
        .map(|value| ordinary_windows_path(value))
        .collect::<Vec<_>>()
        .join(";");
    let root = ordinary_windows_path(&paths.root);
    let temporary = ordinary_windows_path(temporary);
    let windows = ordinary_windows_path(system32.parent().unwrap_or(system32));
    let system_drive = windows
        .get(..2)
        .filter(|value| value.as_bytes().get(1) == Some(&b':'))
        .ok_or_else(|| "Windows system drive is unavailable".to_owned())?;
    let mut values = vec![
        format!("APPDATA={temporary}"),
        format!("ComSpec={}\\cmd.exe", ordinary_windows_path(system32)),
        format!("HOME={root}"),
        "LANG=C.UTF-8".to_owned(),
        format!("LOCALAPPDATA={temporary}"),
        format!("PATH={path}"),
        "PATHEXT=.COM;.EXE;.BAT;.CMD".to_owned(),
        format!("SystemDrive={system_drive}"),
        format!("SystemRoot={windows}"),
        format!("TEMP={temporary}"),
        format!("TMP={temporary}"),
        format!("USERPROFILE={root}"),
        format!("WINDIR={windows}"),
    ];
    // CreateProcessW requires a case-insensitively sorted Unicode environment block. Build only
    // the OS values needed to start a process and point every user-writable location at the
    // workspace-owned temporary directory; inheriting the helper environment would expose tokens.
    values.sort_by_key(|value| {
        value
            .split_once('=')
            .map_or("", |entry| entry.0)
            .to_ascii_uppercase()
    });
    Ok(values
        .iter()
        .flat_map(|value| value.encode_utf16().chain([0]))
        .chain([0])
        .collect())
}

struct WorkspaceTemporaryDirectory(PathBuf);

impl WorkspaceTemporaryDirectory {
    fn create(root: &Path) -> Result<Self, String> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "system clock is unavailable".to_owned())?
            .as_nanos();
        let path = root.join(format!(".ocx-remote-tmp-{}-{nonce}", std::process::id()));
        fs::create_dir(&path)
            .map_err(|_| "could not create workspace temporary directory".to_owned())?;
        Ok(Self(path))
    }
}

impl Drop for WorkspaceTemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct PipePair {
    read: OwnedHandle,
    write: OwnedHandle,
}

fn pipe() -> Result<PipePair, String> {
    let mut read = null_mut();
    let mut write = null_mut();
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    // SAFETY: read/write point to writable handle slots and attributes is initialized.
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(last_error("could not create command output pipe"));
    }
    let read = OwnedHandle::new(read, "invalid output read handle")?;
    let write = OwnedHandle::new(write, "invalid output write handle")?;
    // SAFETY: read is a valid pipe handle; clearing inherit keeps it out of the child.
    if unsafe { SetHandleInformation(read.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(last_error("could not protect command output pipe"));
    }
    Ok(PipePair { read, write })
}

struct Capture {
    body: Vec<u8>,
    failed: bool,
}

fn reserve(total: &AtomicUsize, amount: usize, maximum: usize) -> bool {
    total
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current.checked_add(amount).filter(|next| *next <= maximum)
        })
        .is_ok()
}

fn capture(
    handle: OwnedHandle,
    total: Arc<AtomicUsize>,
    maximum: usize,
    overflowed: Arc<AtomicBool>,
) -> thread::JoinHandle<Capture> {
    let raw = handle.into_raw() as usize;
    thread::spawn(move || {
        // SAFETY: ownership of the valid pipe handle moves from OwnedHandle into File exactly once.
        let mut source = unsafe { fs::File::from_raw_handle(raw as RawHandle) };
        let mut body = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match source.read(&mut chunk) {
                Ok(0) => {
                    return Capture {
                        body,
                        failed: false,
                    };
                }
                Ok(read) if reserve(&total, read, maximum) => {
                    body.extend_from_slice(&chunk[..read])
                }
                Ok(_) => {
                    overflowed.store(true, Ordering::Release);
                    return Capture {
                        body,
                        failed: false,
                    };
                }
                Err(_) => return Capture { body, failed: true },
            }
        }
    })
}

fn configure_job() -> Result<OwnedHandle, String> {
    // SAFETY: null security/name arguments request an unnamed job with defaults.
    let job = OwnedHandle::new(
        unsafe { CreateJobObjectW(null(), null()) },
        "could not create command job",
    )?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = MAX_JOB_PROCESSES;
    // SAFETY: limits points to a correctly sized initialized structure.
    if unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(last_error("could not configure command job"));
    }
    Ok(job)
}

fn run_with_paths(
    request: &HelperRequest,
    paths: CanonicalPaths,
) -> Result<CommandOutcome, String> {
    if request.network_access {
        return Err("Windows AppContainer network capability is not enabled".to_owned());
    }
    let system32 = system32()?;
    let (executable, mut command_line) = invocation(request, &paths, &system32)?;
    let temporary = WorkspaceTemporaryDirectory::create(&paths.root)?;
    let profile = AppContainerProfile::create()?;
    let mut grants = AclGrants::new(&system32, profile.sid_string()?);
    grants.grant(&paths.root, "M")?;
    for toolchain in &paths.toolchain_roots {
        if !toolchain.starts_with(&paths.root) {
            grants.grant(toolchain, "RX")?;
        }
    }
    let job = configure_job()?;
    let security = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid,
        Capabilities: null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let stdout = pipe()?;
    let stderr = pipe()?;
    let stdin = fs::File::open("NUL").map_err(|_| "could not open null input".to_owned())?;
    use std::os::windows::io::AsRawHandle;
    let stdin_handle = stdin.as_raw_handle() as HANDLE;
    // SAFETY: stdin_handle is valid for the lifetime of CreateProcessW.
    if unsafe { SetHandleInformation(stdin_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0
    {
        return Err(last_error("could not inherit null input"));
    }
    let inherited_handles = [stdin_handle, stdout.write.raw(), stderr.write.raw()];
    let mut attributes = AttributeList::create(2)?;
    attributes.update(
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
        &security,
    )?;
    attributes.update_slice(
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
        &inherited_handles,
    )?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin_handle;
    startup.StartupInfo.hStdOutput = stdout.write.raw();
    startup.StartupInfo.hStdError = stderr.write.raw();
    startup.lpAttributeList = attributes.pointer;
    let mut information = PROCESS_INFORMATION::default();
    let application = wide(executable.as_os_str());
    let cwd = wide(paths.cwd.as_os_str());
    let environment = environment(&paths, &system32, &temporary.0)?;
    // SAFETY: every pointer references initialized, live, NUL-terminated storage. Inherited handles
    // are limited to the three standard handles, and both process attributes stay alive for the call.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | CREATE_SUSPENDED,
            environment.as_ptr().cast(),
            cwd.as_ptr(),
            &startup.StartupInfo as *const _,
            &mut information,
        )
    };
    if created == 0 {
        return Err(last_error("could not start AppContainer command"));
    }
    let process = OwnedHandle::new(information.hProcess, "invalid command process handle")?;
    let thread_handle = OwnedHandle::new(information.hThread, "invalid command thread handle")?;
    // Assign while the primary thread is still suspended. No command instruction can run outside
    // the non-breakaway, kill-on-close job, while this path remains compatible with hosted Windows
    // environments that reject PROC_THREAD_ATTRIBUTE_JOB_LIST during CreateProcessW.
    if unsafe { AssignProcessToJobObject(job.raw(), process.raw()) } == 0 {
        let error = last_error("could not assign AppContainer command to its job");
        // SAFETY: the process is still suspended and owned by this helper.
        unsafe {
            TerminateProcess(process.raw(), 1);
            WaitForSingleObject(process.raw(), 2_000);
        }
        return Err(error);
    }
    // SAFETY: thread_handle owns the suspended primary thread created above.
    if unsafe { ResumeThread(thread_handle.raw()) } == u32::MAX {
        let error = last_error("could not resume AppContainer command");
        // SAFETY: the job owns the process and is configured to contain every descendant.
        unsafe { TerminateJobObject(job.raw(), 1) };
        return Err(error);
    }
    drop(thread_handle);
    drop(stdout.write);
    drop(stderr.write);
    let total = Arc::new(AtomicUsize::new(0));
    let overflowed = Arc::new(AtomicBool::new(false));
    let stdout_capture = capture(
        stdout.read,
        Arc::clone(&total),
        request.max_output_bytes,
        Arc::clone(&overflowed),
    );
    let stderr_capture = capture(
        stderr.read,
        Arc::clone(&total),
        request.max_output_bytes,
        Arc::clone(&overflowed),
    );
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    let mut failure: Option<String> = None;
    loop {
        if overflowed.load(Ordering::Acquire) {
            failure = Some("remote workspace command output limit exceeded".to_owned());
            break;
        }
        if Instant::now() >= deadline {
            failure = Some("remote workspace command timed out".to_owned());
            break;
        }
        // SAFETY: process is a live process handle; a short wait keeps output and timeout bounded.
        match unsafe { WaitForSingleObject(process.raw(), 10) } {
            WAIT_OBJECT_0 => break,
            WAIT_TIMEOUT => continue,
            WAIT_FAILED => {
                failure = Some(last_error("could not wait for AppContainer command"));
                break;
            }
            _ => {
                failure = Some("unexpected AppContainer wait result".to_owned());
                break;
            }
        }
    }
    // The job was attached before the primary thread resumed, cannot break away, and is
    // kill-on-close. Terminating it
    // also closes pipes held by background descendants before collector threads are joined.
    // SAFETY: job is a valid handle owned by this helper.
    let terminated = unsafe { TerminateJobObject(job.raw(), 1) } != 0;
    // KILL_ON_JOB_CLOSE is the second termination path and prevents a failed explicit termination
    // from leaving background descendants holding their output pipes forever.
    drop(job);
    // SAFETY: process remains valid and is now signaled or being terminated.
    let final_wait = unsafe { WaitForSingleObject(process.raw(), 2_000) };
    let mut code = 1u32;
    // SAFETY: process is a valid process handle and code points to initialized writable storage.
    let exit_code_error = if unsafe { GetExitCodeProcess(process.raw(), &mut code) } == 0 {
        Some(last_error("could not read AppContainer exit code"))
    } else {
        None
    };
    let stdout = stdout_capture
        .join()
        .map_err(|_| "command stdout collector failed".to_owned())?;
    let stderr = stderr_capture
        .join()
        .map_err(|_| "command stderr collector failed".to_owned())?;
    if stdout.failed || stderr.failed {
        return Err("could not read AppContainer command output".to_owned());
    }
    if !terminated && final_wait != WAIT_OBJECT_0 {
        return Err("could not terminate AppContainer command job".to_owned());
    }
    if let Some(error) = exit_code_error {
        return Err(error);
    }
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(CommandOutcome {
        exit_code: code as i32,
        stdout: stdout.body,
        stderr: stderr.body,
    })
}

pub fn run(request: &HelperRequest) -> Result<CommandOutcome, String> {
    run_with_paths(request, request.canonical_paths()?)
}

pub fn probe() -> Result<(), String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is unavailable".to_owned())?
        .as_nanos();
    let parent =
        std::env::temp_dir().join(format!("ocx-remote-probe-{}-{nonce}", std::process::id()));
    let workspace = parent.join("workspace");
    let nested_workspace = workspace.join("src");
    let existing_workspace_file = nested_workspace.join("existing.txt");
    let outside_file = parent.join("outside-secret");
    let outside_write = parent.join("outside-write");
    fs::create_dir_all(&nested_workspace)
        .map_err(|_| "could not create confinement probe workspace".to_owned())?;
    fs::write(&existing_workspace_file, b"existing")
        .map_err(|_| "could not create confinement probe workspace fixture".to_owned())?;
    fs::write(&outside_file, b"must-not-be-visible")
        .map_err(|_| "could not create confinement probe sentinel".to_owned())?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "could not create confinement probe listener".to_owned())?;
    let address = listener
        .local_addr()
        .map_err(|_| "could not inspect confinement probe listener".to_owned())?;
    let helper =
        std::env::current_exe().map_err(|_| "could not locate native helper".to_owned())?;
    let helper_parent = helper
        .parent()
        .ok_or_else(|| "native helper has no parent directory".to_owned())?;
    let to_string = |value: &Path| {
        value
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| "probe path is not valid Unicode".to_owned())
    };
    let request = HelperRequest {
        version: PROTOCOL_VERSION,
        operation: "run".to_owned(),
        root: to_string(&workspace)?,
        cwd: to_string(&workspace)?,
        command: vec![
            to_string(&helper)?,
            "__probe-child".to_owned(),
            to_string(&workspace)?,
            to_string(&outside_file)?,
            to_string(&outside_write)?,
            address.to_string(),
            to_string(&existing_workspace_file)?,
        ],
        toolchain_roots: vec![to_string(helper_parent)?],
        timeout_ms: 5_000,
        max_output_bytes: 16 * 1024,
        network_access: false,
    };
    let result = run(&request);
    drop(listener);
    let marker_ok = matches!(
        fs::read(workspace.join("probe-marker")),
        Ok(value) if value == b"sandboxed"
    );
    let existing_workspace_ok = matches!(
        fs::read(&existing_workspace_file),
        Ok(value) if value == b"updated"
    );
    let outside_ok = matches!(
        fs::read(&outside_file),
        Ok(value) if value == b"must-not-be-visible"
    ) && !outside_write.exists();
    let cleanup = fs::remove_dir_all(&parent);
    let outcome = result?;
    if cleanup.is_err()
        || !marker_ok
        || !existing_workspace_ok
        || !outside_ok
        || outcome.exit_code != 0
    {
        return Err("Windows AppContainer confinement probe failed".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment_strings(block: &[u16]) -> Vec<String> {
        block
            .split(|value| *value == 0)
            .take_while(|value| !value.is_empty())
            .map(|value| String::from_utf16(value).expect("environment fixture is UTF-16"))
            .collect()
    }

    #[test]
    fn sanitized_environment_is_sorted_complete_and_never_inherits_secrets() {
        let paths = CanonicalPaths {
            root: PathBuf::from(r"\\?\C:\workspace"),
            cwd: PathBuf::from(r"\\?\C:\workspace\project"),
            toolchain_roots: vec![PathBuf::from(r"\\?\D:\toolchain")],
        };
        let block = environment(
            &paths,
            Path::new(r"\\?\C:\Windows\System32"),
            Path::new(r"\\?\C:\workspace\.tmp"),
        )
        .expect("environment should be representable");
        assert!(block.ends_with(&[0, 0]));
        let values = environment_strings(&block);
        let mut sorted = values.clone();
        sorted.sort_by_key(|value| {
            value
                .split_once('=')
                .map_or("", |entry| entry.0)
                .to_ascii_uppercase()
        });
        assert_eq!(values, sorted);
        assert!(values.contains(&"APPDATA=C:\\workspace\\.tmp".to_owned()));
        assert!(values.contains(&"LOCALAPPDATA=C:\\workspace\\.tmp".to_owned()));
        assert!(values.contains(&"SystemDrive=C:".to_owned()));
        assert!(values.contains(&"SystemRoot=C:\\Windows".to_owned()));
        assert!(values.contains(&"ComSpec=C:\\Windows\\System32\\cmd.exe".to_owned()));
        assert!(values.iter().all(|value| !value.contains(r"\\?\")));
        assert!(values.iter().all(|value| !value.contains("OPENAI_API_KEY")));
    }

    #[test]
    fn ordinary_windows_paths_remove_only_verbatim_transport_prefixes() {
        assert_eq!(
            ordinary_windows_path(Path::new(r"\\?\C:\workspace")),
            r"C:\workspace",
        );
        assert_eq!(
            ordinary_windows_path(Path::new(r"\\?\UNC\server\share\workspace")),
            r"\\server\share\workspace",
        );
        assert_eq!(
            ordinary_windows_path(Path::new(r"C:\workspace")),
            r"C:\workspace",
        );
    }
}
