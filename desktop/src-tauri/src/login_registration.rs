//! Start at Login on macOS, judged the way Startup safety judges it.
//!
//! The autostart plugin answers "is Start at Login on?" with whether
//! `~/Library/LaunchAgents/OpenCodex.plist` exists. Startup safety
//! (`src/service/desktop-startup.ts`, `macLoginRegistration`) asks more: the plist must have the
//! shape this app writes, launchd must not have the job disabled, the registered app must be this
//! copy, and a loaded job must have been loaded from this copy and this plist. When the two
//! disagreed the tray showed a checked item while the Startup page reported Start at Login as
//! unverified (#6972).
//!
//! [`classify`] is a step-for-step port of that judgment over an injected [`Probe`], so the tray
//! can be tested without launchd. The cases in `tests/fixtures/desktop-login-registration-cases.json`
//! are run against both implementations; a change to either side that is not mirrored in the other
//! fails one of the two suites. Only [`LoginState::On`] is shown checked: every other state is a
//! reason the registration could not be credited, and none of them may read as on.

use serde_json::Value;
use std::io;
use std::path::{Path, PathBuf};

const SERVICE: &str = "OpenCodex";
const APP_SUFFIX: &str = "/Contents/MacOS/opencodex-desktop";
const AUTOSTART_ARGUMENT: &str = "--autostart";
/// `managed_by` of a job Background Task Management resubmitted through smd (#7019).
const SERVICE_MANAGEMENT: &str = "com.apple.xpc.ServiceManagement";
/// System Settings → General → Login Items & Extensions, where a disabled job is turned back on.
#[cfg(target_os = "macos")]
pub const LOGIN_ITEMS_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginState {
    /// This copy's registration is enabled and either loaded from this copy or valid for the next
    /// login. The only state Startup safety credits, and the only one shown checked.
    On,
    /// No LaunchAgent plist.
    Off,
    /// This copy is registered but launchd has the job disabled (System Settings or
    /// `launchctl disable`). Rewriting the plist does not clear that, so the item opens Login
    /// Items settings instead.
    DisabledBySystem,
    /// The registration, or the job launchd loaded, belongs to another OpenCodex copy. The tray
    /// never rewrites it.
    OtherCopy,
    /// The registration names an app path that does not exist. It is still not this copy's.
    MissingCopy,
    /// The evidence could not be read, was malformed, timed out or changed while it was read.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickAction {
    Disable,
    Enable,
    OpenLoginItems,
    Nothing,
}

impl LoginState {
    pub fn checked(self) -> bool {
        self == Self::On
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::On | Self::Off => "Start at Login",
            Self::DisabledBySystem => "Start at Login (disabled by macOS)",
            Self::OtherCopy => "Start at Login (another OpenCodex copy)",
            Self::MissingCopy => "Start at Login (registered app is missing)",
            Self::Unknown => "Start at Login (status unknown)",
        }
    }

    pub fn click_action(self) -> ClickAction {
        match self {
            Self::On => ClickAction::Disable,
            Self::Off => ClickAction::Enable,
            Self::DisabledBySystem => ClickAction::OpenLoginItems,
            // A missing path may be a copy being replaced or on a volume that is not mounted, so it
            // is no more this copy's to take over than an existing one.
            Self::OtherCopy | Self::MissingCopy | Self::Unknown => ClickAction::Nothing,
        }
    }

    pub fn clickable(self) -> bool {
        self.click_action() != ClickAction::Nothing
    }
}

/// A failed command. `Exit` is an ordinary non-zero exit; everything else (spawn failure,
/// timeout, signal, oversized or non-UTF-8 output) is `Failed`, which never counts as absence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    Exit { status: i32, stderr: String },
    Failed,
}

/// The filesystem and process reads the judgment needs, injectable for tests.
pub trait Probe {
    /// An identity of the path itself (not its target) that changes when it is replaced or edited.
    fn identity(&self, path: &Path) -> io::Result<String>;
    fn realpath(&self, path: &Path) -> io::Result<PathBuf>;
    fn executable(&self, path: &Path) -> io::Result<()>;
    /// Trimmed stdout of a successful run.
    fn run(&self, program: &str, args: &[&str]) -> Result<String, RunError>;
}

/// JavaScript's `\s`, so trimming and the regex ports below match the TypeScript judgment.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Enabled {
    Yes,
    Disabled,
    Unknown,
}

/// `/"OpenCodex"\s*=>\s*(enabled|false|disabled|true)(?=\s*(?:\r?\n|[,;}]|$))/`, first match.
fn override_value(text: &str) -> Option<&'static str> {
    let needle = "\"OpenCodex\"";
    let mut from = 0;
    while let Some(found) = text[from..].find(needle) {
        let start = from + found;
        from = start + needle.len();
        let rest = text[from..].trim_start_matches(js_space);
        let Some(rest) = rest.strip_prefix("=>") else {
            continue;
        };
        let rest = rest.trim_start_matches(js_space);
        for word in ["enabled", "false", "disabled", "true"] {
            let Some(after) = rest.strip_prefix(word) else {
                continue;
            };
            let spaces = after.len() - after.trim_start_matches(js_space).len();
            let (gap, next) = after.split_at(spaces);
            if gap.contains('\n') || next.is_empty() || next.starts_with([',', ';', '}']) {
                return Some(word);
            }
        }
    }
    None
}

/// The print-disabled half of `loginEnabled` in `macLoginRegistration`.
fn enabled(disabled: &str, plist_disabled: Option<bool>) -> Enabled {
    let body = js_trim(disabled);
    if !(body.starts_with("disabled services = {") && body.ends_with('}')) {
        return Enabled::Unknown;
    }
    match disabled.matches("\"OpenCodex\"").count() {
        // launchd's override is absent, so the plist's own Disabled key decides. auto-launch never
        // writes one; a plist that disables itself was edited by something else.
        0 if plist_disabled == Some(true) => Enabled::Unknown,
        0 => Enabled::Yes,
        1 => match override_value(disabled) {
            Some("enabled" | "false") => Enabled::Yes,
            Some(_) => Enabled::Disabled,
            None => Enabled::Unknown,
        },
        _ => Enabled::Unknown,
    }
}

/// ECMAScript line terminators: what `^`, `$` and `.` honour under the `m` flag.
fn js_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `/^\s*key(.+)$/m`, first match.
fn line_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.split(js_line_end).find_map(|line| {
        line.trim_start_matches(js_space)
            .strip_prefix(key)
            .filter(|value| !value.is_empty())
    })
}

/// `/^\(submitted by smd\.\d+\)$/`: launchctl's `path` for a job smd resubmitted.
fn smd_submitted(path: &str) -> bool {
    path.strip_prefix("(submitted by smd.")
        .and_then(|rest| rest.strip_suffix(')'))
        .is_some_and(|pid| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()))
}

/// The registered program when the plist has the shape auto-launch writes for this app.
fn registered_app(plist: &Value) -> Option<(&str, Option<bool>)> {
    let args = plist.get("ProgramArguments")?.as_array()?;
    let app = args.first()?.as_str()?;
    let disabled = match plist.get("Disabled") {
        None => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(_) => return None,
    };
    let shaped = plist.get("Label").and_then(Value::as_str) == Some(SERVICE)
        && plist.get("RunAtLoad") == Some(&Value::Bool(true))
        && args.len() == 2
        && args[1].as_str() == Some(AUTOSTART_ARGUMENT)
        && app.ends_with(APP_SUFFIX)
        && plist
            .get("Program")
            .is_none_or(|program| program.as_str() == Some(app));
    shaped.then_some((app, disabled))
}

#[derive(Debug, PartialEq, Eq)]
struct Capture {
    app: PathBuf,
    proxy: PathBuf,
    registration: PathBuf,
    plist_identity: String,
    target_identity: String,
    definition: String,
    app_identity: String,
    proxy_identity: String,
    disabled: String,
    enabled: Enabled,
}

fn unknown<T>(_: T) -> LoginState {
    LoginState::Unknown
}

fn capture(
    probe: &dyn Probe,
    plist: &Path,
    domain: &str,
    current_app: &Path,
) -> Result<Capture, LoginState> {
    let plist_identity = probe.identity(plist).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            LoginState::Off
        } else {
            LoginState::Unknown
        }
    })?;
    let registration = probe.realpath(plist).map_err(unknown)?;
    let target_identity = probe.identity(&registration).map_err(unknown)?;
    let plist_arg = plist.to_str().ok_or(LoginState::Unknown)?;
    let definition = probe
        .run(
            "/usr/bin/plutil",
            &["-convert", "json", "-o", "-", plist_arg],
        )
        .map_err(unknown)?;
    let parsed: Value = serde_json::from_str(&definition).map_err(unknown)?;
    let (registered, plist_disabled) = registered_app(&parsed).ok_or(LoginState::Unknown)?;
    let registered = Path::new(registered);
    let app = probe.realpath(registered).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            LoginState::MissingCopy
        } else {
            LoginState::Unknown
        }
    })?;
    if app != current_app {
        return Err(LoginState::OtherCopy);
    }
    let sibling = app.parent().ok_or(LoginState::Unknown)?.join("ocx");
    let proxy = probe.realpath(&sibling).map_err(unknown)?;
    probe.executable(&app).map_err(unknown)?;
    probe.executable(&proxy).map_err(unknown)?;
    let app_identity = probe.identity(&app).map_err(unknown)?;
    let proxy_identity = probe.identity(&proxy).map_err(unknown)?;
    let disabled = probe
        .run("/bin/launchctl", &["print-disabled", domain])
        .map_err(unknown)?;
    let enabled = enabled(&disabled, plist_disabled);
    // Every path and identity is read again: a registration replaced during the probes is not the
    // registration that was judged.
    let stable = probe.realpath(plist).ok().as_ref() == Some(&registration)
        && probe.identity(plist).ok().as_ref() == Some(&plist_identity)
        && probe.identity(&registration).ok().as_ref() == Some(&target_identity)
        && probe.realpath(registered).ok().as_ref() == Some(&app)
        && probe.realpath(&sibling).ok().as_ref() == Some(&proxy)
        && probe.identity(&app).ok().as_ref() == Some(&app_identity)
        && probe.identity(&proxy).ok().as_ref() == Some(&proxy_identity);
    if !stable {
        return Err(LoginState::Unknown);
    }
    Ok(Capture {
        app,
        proxy,
        registration,
        plist_identity,
        target_identity,
        definition,
        app_identity,
        proxy_identity,
        disabled,
        enabled,
    })
}

/// Judge this copy's Start at Login registration. `current_app` must already be resolved.
pub fn classify(probe: &dyn Probe, home: &Path, uid: u32, current_app: &Path) -> LoginState {
    let plist = home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{SERVICE}.plist"));
    let domain = format!("gui/{uid}");
    let first = match capture(probe, &plist, &domain, current_app) {
        Ok(first) => first,
        Err(state) => return state,
    };
    match first.enabled {
        Enabled::Yes => {}
        Enabled::Disabled => return LoginState::DisabledBySystem,
        Enabled::Unknown => return LoginState::Unknown,
    }
    let target = format!("{domain}/{SERVICE}");
    match probe.run("/bin/launchctl", &["print", &target]) {
        Ok(loaded) => {
            let Some(program) = line_value(&loaded, "program = ") else {
                return LoginState::Unknown;
            };
            match probe.realpath(Path::new(program)) {
                Ok(program) if program == first.app => {}
                Ok(_) => return LoginState::OtherCopy,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    return LoginState::OtherCopy
                }
                Err(_) => return LoginState::Unknown,
            }
            let Some(path) = line_value(&loaded, "path = ") else {
                return LoginState::Unknown;
            };
            // macOS 13+ Background Task Management can resubmit the user LaunchAgent through
            // smd; launchctl then names the submitter instead of the plist (#7019). Credit it like
            // an unloaded job: the whole registration is read again and must not have changed.
            if smd_submitted(path)
                && line_value(&loaded, "managed_by = ") == Some(SERVICE_MANAGEMENT)
            {
                return match capture(probe, &plist, &domain, current_app) {
                    Ok(last) if last == first => LoginState::On,
                    _ => LoginState::Unknown,
                };
            }
            match probe.realpath(Path::new(path)) {
                Ok(path) if path == first.registration => LoginState::On,
                _ => LoginState::Unknown,
            }
        }
        // launchctl's own service-not-found answer is absence; any other failure is unverified.
        Err(RunError::Exit {
            status: 113,
            stderr,
        }) => {
            let missing =
                format!("Could not find service \"{SERVICE}\" in domain for user gui: {uid}");
            let stderr = js_trim(&stderr);
            if stderr != missing && stderr != format!("Bad request.\n{missing}") {
                return LoginState::Unknown;
            }
            // An unloaded job leaves no durable evidence, so the whole registration is read again
            // and must not have changed.
            match capture(probe, &plist, &domain, current_app) {
                Ok(last) if last == first => LoginState::On,
                _ => LoginState::Unknown,
            }
        }
        Err(_) => LoginState::Unknown,
    }
}

/// What the once-per-installation launch-origin migration in `first_run.rs` may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Migration {
    /// No LaunchAgent: nothing to migrate.
    Absent,
    /// This copy's own enabled entry, in the shape auto-launch writes with or without
    /// `--autostart`: rewriting it changes only the arguments.
    Rewrite,
    /// Anything else: another or a missing copy, a `Program` override, a definition that disables
    /// itself, an edited shape or unreadable evidence. Rewriting would change more than arguments.
    Leave,
}

pub fn migration(probe: &dyn Probe, home: &Path, current_app: &Path) -> Migration {
    let plist = home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{SERVICE}.plist"));
    let plist_identity = match probe.identity(&plist) {
        Ok(identity) => identity,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Migration::Absent,
        Err(_) => return Migration::Leave,
    };
    let Ok(registration) = probe.realpath(&plist) else {
        return Migration::Leave;
    };
    let Ok(target_identity) = probe.identity(&registration) else {
        return Migration::Leave;
    };
    let Some(plist_arg) = plist.to_str() else {
        return Migration::Leave;
    };
    let Ok(definition) = probe.run(
        "/usr/bin/plutil",
        &["-convert", "json", "-o", "-", plist_arg],
    ) else {
        return Migration::Leave;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&definition) else {
        return Migration::Leave;
    };
    let Some(args) = parsed.get("ProgramArguments").and_then(Value::as_array) else {
        return Migration::Leave;
    };
    let Some(app) = args.first().and_then(Value::as_str) else {
        return Migration::Leave;
    };
    let arguments = match args.len() {
        1 => true,
        2 => args[1].as_str() == Some(AUTOSTART_ARGUMENT),
        _ => false,
    };
    // The plugin rewrites the whole file with exactly these three keys, so any other key —
    // `Program`, `Disabled`, `KeepAlive`, environment — would be dropped by the rewrite.
    let keys = parsed.as_object().is_some_and(|plist| {
        plist.len() == 3
            && ["Label", "ProgramArguments", "RunAtLoad"]
                .iter()
                .all(|key| plist.contains_key(*key))
    });
    let own_shape = arguments
        && keys
        && parsed.get("Label").and_then(Value::as_str) == Some(SERVICE)
        && parsed.get("RunAtLoad") == Some(&Value::Bool(true))
        && app.ends_with(APP_SUFFIX);
    if !own_shape {
        return Migration::Leave;
    }
    let Ok(resolved) = probe.realpath(Path::new(app)) else {
        return Migration::Leave;
    };
    // As in [`classify`]: a plist replaced while it was read is not the plist that was judged.
    let stable = probe.identity(&plist).ok().as_ref() == Some(&plist_identity)
        && probe.realpath(&plist).ok().as_ref() == Some(&registration)
        && probe.identity(&registration).ok().as_ref() == Some(&target_identity)
        && probe.realpath(Path::new(app)).ok().as_ref() == Some(&resolved);
    if stable && resolved == current_app {
        Migration::Rewrite
    } else {
        Migration::Leave
    }
}

/// Running launchctl and plutil with a deadline, without ever killing a process.
///
/// The shell never kills a process (`tests/clients/desktop-exit-ownership.test.ts`), so a
/// command that outlives its deadline is abandoned: the caller gets [`RunError::Failed`] at the
/// deadline and a detached thread reaps the child and its output readers later. One process-wide
/// slot is held until all three have finished, and no command starts while it is held, so a
/// launchd that never answers costs at most one abandoned command however often the tray asks.
#[cfg(any(target_os = "macos", all(test, unix)))]
mod command {
    use super::{js_trim, RunError};
    use std::io::Read;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Receiver};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    const MAX_OUTPUT: u64 = 128 * 1024;
    static BUSY: AtomicBool = AtomicBool::new(false);

    /// Occupancy of the one command slot; released when dropped.
    struct Slot;

    impl Slot {
        fn take() -> Option<Self> {
            BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .ok()
                .map(|_| Self)
        }
    }

    impl Drop for Slot {
        fn drop(&mut self) {
            BUSY.store(false, Ordering::Release);
        }
    }

    type Reader = (Receiver<Vec<u8>>, JoinHandle<()>);

    fn drain(stream: Option<impl Read + Send + 'static>) -> Reader {
        let (sender, receiver) = channel();
        let handle = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(stream) = stream {
                let _ = stream.take(MAX_OUTPUT + 1).read_to_end(&mut bytes);
            }
            let _ = sender.send(bytes);
        });
        (receiver, handle)
    }

    /// Hand the slot to a thread that waits for the child and both readers, then frees it.
    fn abandon(slot: Slot, mut child: Child, readers: [Reader; 2]) -> RunError {
        std::thread::spawn(move || {
            let _ = child.wait();
            for (_, handle) in readers {
                let _ = handle.join();
            }
            drop(slot);
        });
        RunError::Failed
    }

    pub(super) fn run(program: &str, args: &[&str], timeout: Duration) -> Result<String, RunError> {
        let slot = Slot::take().ok_or(RunError::Failed)?;
        let deadline = Instant::now() + timeout;
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| RunError::Failed)?;
        let readers = [drain(child.stdout.take()), drain(child.stderr.take())];
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                _ => return Err(abandon(slot, child, readers)),
            }
        };
        let mut output = Vec::new();
        for (receiver, _) in &readers {
            let left = deadline.saturating_duration_since(Instant::now());
            match receiver.recv_timeout(left) {
                Ok(bytes) => output.push(bytes),
                Err(_) => return Err(abandon(slot, child, readers)),
            }
        }
        for (_, handle) in readers {
            let _ = handle.join();
        }
        drop(slot);
        let [stdout, stderr] = [&output[0], &output[1]];
        if stdout.len() as u64 > MAX_OUTPUT || stderr.len() as u64 > MAX_OUTPUT {
            return Err(RunError::Failed);
        }
        // Node decodes `encoding: "utf8"` output lossily; so does this.
        if status.success() {
            return Ok(js_trim(&String::from_utf8_lossy(stdout)).to_string());
        }
        match status.code() {
            Some(status) => Err(RunError::Exit {
                status,
                stderr: String::from_utf8_lossy(stderr).into_owned(),
            }),
            None => Err(RunError::Failed),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_command_past_its_deadline_holds_the_only_slot_until_it_ends() {
            let started = Instant::now();
            assert_eq!(
                run("/bin/sleep", &["1"], Duration::from_millis(50)),
                Err(RunError::Failed)
            );
            assert!(started.elapsed() < Duration::from_millis(500));
            // Repeated timeouts cannot add work: nothing runs while the abandoned command lives.
            for _ in 0..20 {
                assert_eq!(
                    run("/bin/echo", &["ready"], Duration::from_secs(5)),
                    Err(RunError::Failed)
                );
            }
            let freed = Instant::now() + Duration::from_secs(10);
            while BUSY.load(Ordering::Acquire) {
                assert!(
                    Instant::now() < freed,
                    "the abandoned command was never reaped"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(
                run("/bin/echo", &["ready"], Duration::from_secs(5)),
                Ok("ready".into())
            );
            assert_eq!(
                run(
                    "/bin/sh",
                    &["-c", "echo nope >&2; exit 113"],
                    Duration::from_secs(5)
                ),
                Err(RunError::Exit {
                    status: 113,
                    stderr: "nope\n".into()
                })
            );
        }
    }
}

#[cfg(target_os = "macos")]
pub use system::{judge, judge_migration};

#[cfg(target_os = "macos")]
mod system {
    use super::*;
    use std::ffi::CString;
    use std::os::raw::c_char;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::time::Duration;

    /// TypeScript's `run` deadline in `desktop-startup.ts`.
    const TIMEOUT: Duration = Duration::from_millis(750);
    const X_OK: i32 = 1;

    unsafe extern "C" {
        fn getuid() -> u32;
        fn access(path: *const c_char, mode: i32) -> i32;
    }

    pub struct SystemProbe;

    impl Probe for SystemProbe {
        fn identity(&self, path: &Path) -> io::Result<String> {
            let meta = std::fs::symlink_metadata(path)?;
            Ok(format!(
                "{}:{}:{}:{}:{}.{}:{}.{}",
                meta.dev(),
                meta.ino(),
                meta.size(),
                meta.mode(),
                meta.mtime(),
                meta.mtime_nsec(),
                meta.ctime(),
                meta.ctime_nsec()
            ))
        }

        fn realpath(&self, path: &Path) -> io::Result<PathBuf> {
            std::fs::canonicalize(path)
        }

        fn executable(&self, path: &Path) -> io::Result<()> {
            let path = CString::new(path.as_os_str().as_bytes())
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
            // SAFETY: `path` is a NUL-terminated string that outlives the call.
            if unsafe { access(path.as_ptr(), X_OK) } == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }

        fn run(&self, program: &str, args: &[&str]) -> Result<String, RunError> {
            command::run(program, args, TIMEOUT)
        }
    }

    fn current_app() -> Option<PathBuf> {
        std::fs::canonicalize(std::env::current_exe().ok()?).ok()
    }

    /// Decide the launch-origin migration against the live LaunchAgent. Blocking.
    pub fn judge_migration(home: &Path) -> Migration {
        match current_app() {
            Some(app) => migration(&SystemProbe, home, &app),
            None => Migration::Leave,
        }
    }

    /// Read the live registration. Blocking: run off the main thread.
    pub fn judge(home: &Path) -> LoginState {
        let Some(app) = current_app() else {
            return LoginState::Unknown;
        };
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { getuid() };
        classify(&SystemProbe, home, uid, &app)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::{BTreeMap, BTreeSet};

    const CASES: &str =
        include_str!("../../../tests/fixtures/desktop-login-registration-cases.json");
    const HOME: &str = "/fixture/home";
    const APP: &str = "/fixture/OpenCodex.app/Contents/MacOS/opencodex-desktop";
    const OTHER_APP: &str = "/fixture/Other/OpenCodex.app/Contents/MacOS/opencodex-desktop";
    const MISSING_APP: &str = "/fixture/Gone/OpenCodex.app/Contents/MacOS/opencodex-desktop";
    const PLIST: &str = "/fixture/home/Library/LaunchAgents/OpenCodex.plist";
    const REAL_PLIST: &str = "/fixture/home/Real.plist";
    const OTHER_PLIST: &str = "/fixture/home/Other.plist";

    fn sibling(app: &str) -> String {
        format!("{}/ocx", app.rsplit_once('/').unwrap().0)
    }

    struct Fake {
        files: BTreeSet<String>,
        links: BTreeMap<String, String>,
        plist: Option<Value>,
        disabled: Option<String>,
        disabled_after: Option<String>,
        loaded: Result<String, RunError>,
        touch: bool,
        disabled_reads: Cell<u32>,
        plutil_calls: Cell<u32>,
    }

    impl Fake {
        fn new(plist: Option<Value>) -> Self {
            let mut files: BTreeSet<String> = [APP, OTHER_APP, OTHER_PLIST]
                .into_iter()
                .map(String::from)
                .collect();
            files.insert(sibling(APP));
            files.insert(sibling(OTHER_APP));
            if plist.is_some() {
                files.insert(PLIST.into());
            }
            Self {
                files,
                links: BTreeMap::new(),
                plist,
                disabled: Some("disabled services = {\n}".into()),
                disabled_after: None,
                loaded: Err(RunError::Failed),
                touch: false,
                disabled_reads: Cell::new(0),
                plutil_calls: Cell::new(0),
            }
        }

        fn known(&self, path: &Path) -> Option<String> {
            let path = path.to_str()?.to_string();
            (self.files.contains(&path) || self.links.contains_key(&path)).then_some(path)
        }
    }

    fn not_found() -> io::Error {
        io::Error::from(io::ErrorKind::NotFound)
    }

    impl Probe for Fake {
        fn identity(&self, path: &Path) -> io::Result<String> {
            let path = self.known(path).ok_or_else(not_found)?;
            let generation = if self.touch && path == PLIST {
                self.plutil_calls.get()
            } else {
                0
            };
            Ok(format!("{path}#{generation}"))
        }

        fn realpath(&self, path: &Path) -> io::Result<PathBuf> {
            let path = self.known(path).ok_or_else(not_found)?;
            Ok(PathBuf::from(
                self.links.get(&path).cloned().unwrap_or(path),
            ))
        }

        fn executable(&self, path: &Path) -> io::Result<()> {
            self.known(path).map(|_| ()).ok_or_else(not_found)
        }

        fn run(&self, program: &str, args: &[&str]) -> Result<String, RunError> {
            match (program, args.first().copied()) {
                ("/usr/bin/plutil", _) => {
                    self.plutil_calls.set(self.plutil_calls.get() + 1);
                    self.plist
                        .as_ref()
                        .map(Value::to_string)
                        .ok_or(RunError::Failed)
                }
                ("/bin/launchctl", Some("print-disabled")) => {
                    let reads = self.disabled_reads.get() + 1;
                    self.disabled_reads.set(reads);
                    let after = self.disabled_after.as_ref().filter(|_| reads > 1);
                    after
                        .or(self.disabled.as_ref())
                        .cloned()
                        .ok_or(RunError::Failed)
                }
                ("/bin/launchctl", Some("print")) => self.loaded.clone(),
                other => panic!("unexpected command {other:?}"),
            }
        }
    }

    fn fill(text: &str) -> String {
        text.replace("{APP}", APP)
            .replace("{OTHER_APP}", OTHER_APP)
            .replace("{MISSING_APP}", MISSING_APP)
            .replace("{PLIST}", PLIST)
            .replace("{OTHER_PLIST}", OTHER_PLIST)
            .replace("{UID}", "501")
    }

    fn fake_for(case: &Value) -> Fake {
        let case: Value = serde_json::from_str(&fill(&case.to_string())).unwrap();
        let plist = case.get("plist").filter(|plist| !plist.is_null()).cloned();
        let present = plist.is_some();
        let mut fake = Fake::new(plist);
        if case.get("plutilFails") == Some(&Value::Bool(true)) {
            fake.plist = None;
        }
        if case.get("proxy") == Some(&Value::Bool(false)) {
            fake.files.remove(&sibling(APP));
        }
        if present && case.get("plistLink") == Some(&Value::Bool(true)) {
            fake.files.remove(PLIST);
            fake.files.insert(REAL_PLIST.into());
            fake.links.insert(PLIST.into(), REAL_PLIST.into());
        }
        fake.touch = case.get("touchPlistOnRead") == Some(&Value::Bool(true));
        fake.disabled = case["disabled"].as_str().map(String::from);
        fake.disabled_after = case
            .get("disabledAfterFirstRead")
            .and_then(Value::as_str)
            .map(String::from);
        let loaded = &case["loaded"];
        fake.loaded = if let Some(stdout) = loaded.get("stdout").and_then(Value::as_str) {
            Ok(stdout.into())
        } else if let (Some(status), None) = (loaded.get("status"), loaded.get("signal")) {
            Err(RunError::Exit {
                status: status.as_i64().unwrap() as i32,
                stderr: loaded["stderr"].as_str().unwrap().into(),
            })
        } else {
            Err(RunError::Failed)
        };
        fake
    }

    fn name(state: LoginState) -> &'static str {
        match state {
            LoginState::On => "on",
            LoginState::Off => "off",
            LoginState::DisabledBySystem => "disabled-by-system",
            LoginState::OtherCopy => "other-copy",
            LoginState::MissingCopy => "missing-copy",
            LoginState::Unknown => "unknown",
        }
    }

    #[test]
    fn shared_fixture_matches_startup_safety() {
        let fixture: Value = serde_json::from_str(CASES).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 40);
        for case in cases {
            let label = case["name"].as_str().unwrap();
            let fake = fake_for(case);
            let state = classify(&fake, Path::new(HOME), 501, Path::new(APP));
            assert_eq!(name(state), case["expect"]["tray"], "{label}");
            assert_eq!(
                Some(state.checked()),
                case["expect"]["loginEnabled"].as_bool(),
                "{label}"
            );
        }
    }

    #[test]
    fn only_a_verified_registration_is_checked_or_rewritable() {
        let table = [
            (LoginState::On, true, ClickAction::Disable, "Start at Login"),
            (
                LoginState::Off,
                false,
                ClickAction::Enable,
                "Start at Login",
            ),
            (
                LoginState::DisabledBySystem,
                false,
                ClickAction::OpenLoginItems,
                "Start at Login (disabled by macOS)",
            ),
            (
                LoginState::OtherCopy,
                false,
                ClickAction::Nothing,
                "Start at Login (another OpenCodex copy)",
            ),
            (
                LoginState::MissingCopy,
                false,
                ClickAction::Nothing,
                "Start at Login (registered app is missing)",
            ),
            (
                LoginState::Unknown,
                false,
                ClickAction::Nothing,
                "Start at Login (status unknown)",
            ),
        ];
        for (state, checked, action, label) in table {
            assert_eq!(state.checked(), checked, "{state:?}");
            assert_eq!(state.click_action(), action, "{state:?}");
            assert_eq!(
                state.clickable(),
                action != ClickAction::Nothing,
                "{state:?}"
            );
            assert_eq!(state.label(), label, "{state:?}");
        }
    }

    #[test]
    fn migration_rewrites_only_this_copys_own_enabled_entry() {
        let entry = |extra: Value| {
            let mut plist = serde_json::json!({
                "Label": "OpenCodex",
                "RunAtLoad": true,
                "ProgramArguments": [APP],
            });
            for (key, value) in extra.as_object().unwrap() {
                plist[key] = value.clone();
            }
            Some(plist)
        };
        let cases = [
            ("absent", None, Migration::Absent),
            (
                "legacy entry",
                entry(serde_json::json!({})),
                Migration::Rewrite,
            ),
            (
                "current arguments",
                entry(serde_json::json!({ "ProgramArguments": [APP, "--autostart"] })),
                Migration::Rewrite,
            ),
            (
                "Program equal",
                entry(serde_json::json!({ "Program": APP })),
                Migration::Leave,
            ),
            (
                "Disabled false",
                entry(serde_json::json!({ "Disabled": false })),
                Migration::Leave,
            ),
            (
                "a key the rewrite would drop",
                entry(serde_json::json!({ "KeepAlive": true })),
                Migration::Leave,
            ),
            (
                "another copy",
                entry(serde_json::json!({ "ProgramArguments": [OTHER_APP] })),
                Migration::Leave,
            ),
            (
                "missing copy",
                entry(serde_json::json!({ "ProgramArguments": [MISSING_APP, "--autostart"] })),
                Migration::Leave,
            ),
            (
                "Program names another copy",
                entry(serde_json::json!({ "Program": OTHER_APP })),
                Migration::Leave,
            ),
            (
                "Program names a missing copy",
                entry(serde_json::json!({ "Program": MISSING_APP })),
                Migration::Leave,
            ),
            (
                "disabled by its own definition",
                entry(serde_json::json!({ "Disabled": true })),
                Migration::Leave,
            ),
            (
                "Disabled is not a boolean",
                entry(serde_json::json!({ "Disabled": "yes" })),
                Migration::Leave,
            ),
            (
                "unknown argument",
                entry(serde_json::json!({ "ProgramArguments": [APP, "--hidden"] })),
                Migration::Leave,
            ),
            (
                "extra argument",
                entry(serde_json::json!({ "ProgramArguments": [APP, "--autostart", "x"] })),
                Migration::Leave,
            ),
            (
                "another label",
                entry(serde_json::json!({ "Label": "com.example.OpenCodex" })),
                Migration::Leave,
            ),
            (
                "RunAtLoad false",
                entry(serde_json::json!({ "RunAtLoad": false })),
                Migration::Leave,
            ),
        ];
        for (label, plist, expected) in cases {
            let fake = Fake::new(plist);
            assert_eq!(
                migration(&fake, Path::new(HOME), Path::new(APP)),
                expected,
                "{label}"
            );
        }
        let mut unreadable = Fake::new(entry(serde_json::json!({})));
        unreadable.plist = None;
        assert_eq!(
            migration(&unreadable, Path::new(HOME), Path::new(APP)),
            Migration::Leave
        );
        // Another copy replacing the plist while it is read leaves it alone.
        let mut replaced = Fake::new(entry(serde_json::json!({})));
        replaced.touch = true;
        assert_eq!(
            migration(&replaced, Path::new(HOME), Path::new(APP)),
            Migration::Leave
        );
    }

    #[test]
    fn javascript_whitespace_and_line_terminators() {
        assert_eq!(js_trim("\u{feff}\u{a0} x \u{3000}"), "x");
        assert_eq!(js_trim("\u{85}x"), "\u{85}x");
        assert_eq!(
            line_value("a\u{2028}program = /x\u{2029}y", "program = "),
            Some("/x")
        );
        assert_eq!(
            line_value("program = \rprogram = /y", "program = "),
            Some("/y")
        );
    }
}
