use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    },
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    },
    System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
};
#[path = "process.rs"]
mod win;

fn epoch() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
}
fn left(deadline: Instant) -> io::Result<Duration> {
    let value = deadline.saturating_duration_since(Instant::now());
    if value.is_zero() {
        Err(io::ErrorKind::TimedOut.into())
    } else {
        Ok(value)
    }
}
fn stage(error: io::Error, name: &'static str) -> io::Error {
    io::Error::new(error.kind(), name)
}
fn parse_http(bytes: &[u8]) -> io::Result<(u16, Value)> {
    let split = bytes
        .windows(4)
        .position(|v| v == b"\r\n\r\n")
        .ok_or(io::ErrorKind::InvalidData)?;
    let status = std::str::from_utf8(&bytes[..split])
        .ok()
        .and_then(|s| s.lines().next())
        .and_then(|s| s.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or(io::ErrorKind::InvalidData)?;
    Ok((status, serde_json::from_slice(&bytes[split + 4..])?))
}
fn get(port: u16, path: &str, timeout: Duration) -> io::Result<(u16, Value)> {
    let deadline = Instant::now() + timeout;
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut socket = TcpStream::connect_timeout(
        &addr,
        left(deadline).map_err(|e| stage(e, "connect-deadline"))?,
    )
    .map_err(|e| stage(e, "connect"))?;
    socket
        .set_write_timeout(Some(
            left(deadline).map_err(|e| stage(e, "write-deadline"))?,
        ))
        .map_err(|e| stage(e, "set-write-timeout"))?;
    write!(
        socket,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer version-fixture-data\r\nX-Opencodex-Api-Key: version-fixture-admin\r\nConnection: close\r\n\r\n"
    ).map_err(|error| stage(error, "write"))?;
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        socket
            .set_read_timeout(Some(left(deadline).map_err(|e| stage(e, "read-deadline"))?))
            .map_err(|e| stage(e, "set-read-timeout"))?;
        let n = socket.read(&mut chunk).map_err(|e| stage(e, "read"))?;
        if n == 0 {
            break;
        }
        if bytes.len() + n > 4 * 1024 * 1024 {
            return Err(stage(io::ErrorKind::InvalidData.into(), "body-size"));
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
    parse_http(&bytes).map_err(|e| stage(e, "decode"))
}
fn matched(status: u16, v: &Value, pid: u32, port: u16) -> bool {
    status == 200
        && v["pid"] == pid
        && v["port"] == port
        && v["service"] == "opencodex"
        && v["status"] == "ok"
}
fn model_ids(value: &Value) -> io::Result<Vec<String>> {
    let mut ids = value["data"]
        .as_array()
        .ok_or(io::ErrorKind::InvalidData)?
        .iter()
        .map(|row| {
            row["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .ok_or(io::ErrorKind::InvalidData)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if ids.is_empty() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    ids.sort();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(ids)
}
struct Owned {
    child: Child,
    job: HANDLE,
}
impl Owned {
    fn new(mut child: Child) -> io::Result<Self> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                let error = io::Error::last_os_error();
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0
            {
                let error = io::Error::last_os_error();
                let _ = child.kill();
                let _ = child.wait();
                CloseHandle(job);
                return Err(error);
            }
            let owned = Self { child, job };
            resume_owned_primary_thread(owned.child.id())?;
            Ok(owned)
        }
    }
}
fn resume_owned_primary_thread(pid: u32) -> io::Result<()> {
    // The root was created suspended; descendants cannot escape job assignment.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut found = Vec::new();
        let mut more = Thread32First(snapshot, &mut entry);
        while more != 0 {
            if entry.th32OwnerProcessID == pid {
                found.push(entry.th32ThreadID);
            }
            more = Thread32Next(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        if found.len() != 1 {
            return Err(io::Error::other(
                "suspended root must have one primary thread",
            ));
        }
        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, found[0]);
        if thread.is_null() {
            return Err(io::Error::last_os_error());
        }
        let previous = ResumeThread(thread);
        let result = if previous == u32::MAX {
            Err(io::Error::last_os_error())
        } else if previous != 1 {
            Err(io::Error::other("unexpected root suspend count"))
        } else {
            Ok(())
        };
        CloseHandle(thread);
        result
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.job);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn fake(role: u8) -> io::Result<()> {
    let home = PathBuf::from(env::var_os("OPENCODEX_HOME").ok_or(io::ErrorKind::InvalidInput)?);
    let args: Vec<_> = env::args().skip(1).collect();
    if args == ["--hold-stdout"] {
        thread::sleep(Duration::from_secs(25));
        return Ok(());
    }
    let version = args == ["--version"];
    let catalog = args == ["debug", "models", "--bundled"];
    if !version && !catalog {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mode = fs::read_to_string(home.join("arm")).unwrap_or_default();
    let armed = !mode.is_empty();
    let mut log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("fake-events.jsonl"))?;
    writeln!(
        log,
        "{}",
        json!({"event":"start","at_ms":epoch(),"pid":std::process::id(),"role":role,"version":version,"armed":armed})
    )?;
    if version && mode == "cumulative" {
        thread::sleep(Duration::from_millis(7500));
    }
    if version {
        if mode == "cumulative" && role < 2 {
            println!("synthetic invalid version");
        } else {
            println!("codex-cli 0.160.0");
        }
        io::stdout().flush()?;
        if mode == "pipe" {
            let child = Command::new(env::current_exe()?)
                .arg("--hold-stdout")
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::null())
                .spawn()?;
            writeln!(
                log,
                "{}",
                json!({"event":"inherited-writer","at_ms":epoch(),"pid":child.id(),"role":role})
            )?;
            // Leave the finite-lived writer to the containing Windows Job.
        }
    } else {
        if mode == "catalog-invalid" {
            println!("synthetic invalid catalog");
            return Ok(());
        }
        if mode == "catalog-delay" {
            thread::sleep(Duration::from_millis(500));
        }
        let instructions = if mode == "catalog-large" {
            "synthetic".repeat(262144)
        } else {
            "synthetic".to_string()
        };
        println!(
            "{}",
            json!({"models":[{"slug":"gpt-5.5","display_name":"fixture","base_instructions":instructions,"context_window":128000,"supported_reasoning_levels":[{"effort":"medium","description":"fixture"}],"default_reasoning_level":"medium"}]})
        );
    }
    writeln!(
        log,
        "{}",
        json!({"event":"end","at_ms":epoch(),"pid":std::process::id(),"role":role,"version":version})
    )?;
    Ok(())
}
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let exe = env::current_exe()?;
    match exe.file_name().and_then(|s| s.to_str()) {
        Some("probe-env.exe") => return Ok(fake(0)?),
        Some("probe-persist.exe") => return Ok(fake(1)?),
        Some("codex.exe") => return Ok(fake(2)?),
        _ => {}
    }
    let args: Vec<_> = env::args().skip(1).collect();
    if !(4..=7).contains(&args.len()) {
        return Err(
            "BUN REPO NEW_ROOT NODE_MODULES [cumulative|pipe] [--expect-responsive] [--pin-change]"
                .into(),
        );
    }
    let mode = args.get(4).map(String::as_str).unwrap_or("cumulative");
    if !["cumulative", "pipe"].contains(&mode) {
        return Err("invalid mode".into());
    }
    if args
        .iter()
        .skip(5)
        .any(|arg| !["--expect-responsive", "--pin-change"].contains(&arg.as_str()))
    {
        return Err("invalid assertion flag".into());
    }
    let pin_change = args.iter().skip(5).any(|arg| arg == "--pin-change");
    let responsive = pin_change || args.iter().skip(5).any(|arg| arg == "--expect-responsive");
    let root = PathBuf::from(&args[2]);
    let repo = PathBuf::from(&args[1]);
    if !root.is_absolute()
        || !repo.is_absolute()
        || !Path::new(&args[0]).is_absolute()
        || !Path::new(&args[3]).is_absolute()
    {
        return Err("all paths must be absolute".into());
    }
    fs::create_dir(&root)?;
    let home = root.join("opencodex");
    let codex = root.join("codex");
    let bin = root.join("bin");
    for directory in [&home, &codex, &bin] {
        fs::create_dir(directory)?;
    }
    fs::write(
        codex.join("config.toml"),
        "cli_auth_credentials_store = \"file\"\n",
    )?;
    for name in ["probe-env.exe", "probe-persist.exe", "codex.exe"] {
        fs::copy(&exe, bin.join(name))?;
    }
    fs::write(
        home.join("codex-runtime.json"),
        serde_json::to_vec(
            &json!({"version":1,"command":bin.join("probe-persist.exe"),"source":"configured","selectedVersion":"0.160.0","origin":"pinned","updatedAt":"2026-10-08T00:00:00Z"}),
        )?,
    )?;
    fs::write(
        home.join("codex-shim.json"),
        serde_json::to_vec(
            &json!({"wrappers":[{"backupPath":bin.join("probe-persist.exe")},{"backupPath":bin.join("codex.exe")}]}),
        )?,
    )?;
    fs::write(
        home.join("config.json"),
        serde_json::to_vec(
            &json!({"port":0,"hostname":"127.0.0.1","defaultProvider":"probe-local","providers":{"probe-local":{"adapter":"openai-chat","baseUrl":"http://127.0.0.1:1/v1","authMode":"local","allowPrivateNetwork":true,"models":["fixture-model"]}},"codexAccounts":[],"autoSwitchThreshold":0}),
        )?,
    )?;
    let system = env::var_os("SystemRoot").ok_or("missing SystemRoot")?;
    let path = env::join_paths([bin.clone(), Path::new(&system).join("System32")])?;
    let child = Command::new(&args[0])
        .env_clear()
        .env("SystemRoot", &system)
        .env("WINDIR", &system)
        .env("PATH", path)
        .env("TEMP", &root)
        .env("TMP", &root)
        .env("HOME", &root)
        .env("USERPROFILE", &root)
        .env("APPDATA", root.join("appdata"))
        .env("LOCALAPPDATA", root.join("localappdata"))
        .env("CODEX_HOME", &codex)
        .env("OPENCODEX_HOME", &home)
        .env("CODEX_CLI_PATH", bin.join("probe-env.exe"))
        .env("NODE_PATH", &args[3])
        .env("NATIVE_OWNER_CODEX_HOME", &codex)
        .env("NATIVE_OWNER_CONFIG_DIR", &home)
        .env(
            "NATIVE_OWNER_KEY",
            "XFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFw=",
        )
        .env("OPENCODEX_ADMIN_AUTH_TOKEN", "version-fixture-admin")
        .env("OPENCODEX_API_AUTH_TOKEN", "version-fixture-data")
        .env("CODEX_CI", "1")
        .args(["--no-env-file", "--no-orphans", "--cpu-prof"])
        .arg(format!("--cpu-prof-dir={}", root.display()))
        .arg("--cpu-prof-name=version.cpuprofile")
        .arg(repo.join("tests/helpers/native-main-owner-child.ts"))
        .current_dir(&repo)
        .creation_flags(0x08000000 | 0x00000004)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(fs::File::create(
            root.join("synthetic-child.stderr.txt"),
        )?))
        .spawn()?;
    let mut owned = Owned::new(child)?;
    let process = win::Process::open(owned.child.id())?;
    let out = owned.child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(out);
        loop {
            let mut bytes = Vec::new();
            match reader.by_ref().take(16385).read_until(b'\n', &mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if bytes.len() > 16384 {
                break;
            }
            if let Ok(line) = std::str::from_utf8(&bytes)
                && let Some(v) = line
                    .strip_prefix("@@native-owner@@")
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                && tx.send(v).is_err()
            {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(45);
    let (pid, port) = loop {
        let v = rx.recv_timeout(left(deadline)?)?;
        if v["event"] == "listening" {
            break (
                v["pid"].as_u64().ok_or("missing pid")? as u32,
                v["port"].as_u64().ok_or("missing port")? as u16,
            );
        }
    };
    if pid != owned.child.id() || port == 0 {
        return Err("child identity mismatch".into());
    }
    let initial = get(port, "/healthz", Duration::from_secs(3))?;
    if !matched(initial.0, &initial.1, pid, port) {
        return Err("health identity mismatch".into());
    }
    let warm = get(port, "/v1/models", Duration::from_secs(45))?;
    if warm.0 != 200 {
        return Err("model warmup failed".into());
    }
    let warm_ids = model_ids(&warm.1)?;
    // Expire both the 15s runtime memo and 60s bundled memo in assertion mode.
    thread::sleep(Duration::from_secs(if responsive { 61 } else { 16 }));
    let before = get(port, "/healthz", Duration::from_secs(3))?;
    if !matched(before.0, &before.1, pid, port) {
        return Err("pre-arm health identity mismatch".into());
    }
    fs::write(home.join("arm"), mode)?;
    let mut samples = fs::File::create(root.join("health-samples.jsonl"))?;
    let (started_tx, started_rx) = mpsc::channel();
    let trigger = thread::spawn(move || {
        let at = epoch();
        let _ = started_tx.send(at);
        let begin = Instant::now();
        let result = get(port, "/v1/models", Duration::from_secs(45));
        json!({"at_ms":at,"elapsed_ms":begin.elapsed().as_millis(),"status":result.as_ref().ok().map(|v|v.0),"model_ids":result.as_ref().ok().and_then(|v|model_ids(&v.1).ok()),"error_stage":result.as_ref().err().map(|e|e.to_string()),"error":result.err().map(|e|format!("{:?}",e.kind()))})
    });
    let trigger_at = started_rx.recv_timeout(Duration::from_secs(2))?;
    thread::sleep(Duration::from_millis(200));
    let observation_end = Instant::now() + Duration::from_secs(45);
    let mut count = 0;
    let mut responsive_health = true;
    let mut max_health_ms = 0;
    let mut pin_guard_bytes = None;
    loop {
        let at = epoch();
        let start = Instant::now();
        let result = get(
            port,
            "/healthz",
            Duration::from_millis(if responsive { 1500 } else { 20000 }),
        );
        let alive = process.live();
        let elapsed = start.elapsed().as_millis();
        let health_matches = result
            .as_ref()
            .is_ok_and(|(s, v)| matched(*s, v, pid, port));
        max_health_ms = max_health_ms.max(elapsed);
        responsive_health &= alive && health_matches;
        writeln!(
            samples,
            "{}",
            json!({"index":count,"at_ms":at,"elapsed_ms":elapsed,"pid":pid,"born":process.born,"alive":alive,"matched":health_matches,"status":result.as_ref().ok().map(|v|v.0),"error_stage":result.as_ref().err().map(|e|e.to_string()),"error":result.err().map(|e|format!("{:?}",e.kind())),"metrics":process.metrics()})
        )?;
        count += 1;
        if pin_change
            && pin_guard_bytes.is_none()
            && fs::read_to_string(home.join("fake-events.jsonl"))?
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .any(|event| {
                    event["event"] == "start" && event["version"] == true && event["armed"] == true
                })
        {
            let bytes = serde_json::to_vec(&json!({"version":1,"command":bin.join("codex.exe"),
                "source":"configured","selectedVersion":"0.170.0","origin":"pinned","updatedAt":"2026-10-08T01:00:00Z"}))?;
            fs::write(home.join("codex-runtime.json"), &bytes)?;
            pin_guard_bytes = Some(bytes);
        }
        if (!responsive && count >= 2) || (responsive && Instant::now() >= observation_end) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let trigger_result = trigger.join().map_err(|_| "trigger panic")?;
    let armed_versions = fs::read_to_string(home.join("fake-events.jsonl"))?
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| {
            event["event"] == "start" && event["version"] == true && event["armed"] == true
        })
        .count();
    let pin_preserved = pin_guard_bytes.as_ref().is_some_and(|expected| {
        fs::read(home.join("codex-runtime.json")).is_ok_and(|actual| actual == *expected)
    });
    let assertion_passed = responsive_health
        && count >= 20
        && armed_versions > 0
        && trigger_result["status"] == 200
        && trigger_result["elapsed_ms"]
            .as_u64()
            .is_some_and(|ms| ms < 1500)
        && trigger_result["model_ids"] == serde_json::to_value(&warm_ids)?
        && (!pin_change || pin_preserved);
    let recovered = get(port, "/healthz", Duration::from_secs(3))?;
    let post_matched = matched(recovered.0, &recovered.1, pid, port);
    if !post_matched {
        return Err("post-control health mismatch".into());
    }
    writeln!(
        owned.child.stdin.as_mut().unwrap(),
        "{}",
        json!({"id":"stop","op":"stop"})
    )?;
    let stop_deadline = Instant::now() + Duration::from_secs(20);
    let child_exit = loop {
        if let Some(exit) = owned.child.try_wait()? {
            if !exit.success() {
                return Err("fixture exit failure".into());
            }
            break exit.code();
        }
        if Instant::now() >= stop_deadline {
            return Err("fixture stop deadline".into());
        }
        thread::sleep(Duration::from_millis(100));
    };
    reader.join().map_err(|_| "reader panic")?;
    let result = json!({"pid":pid,"born":process.born,"port":port,"mode":mode,"trigger_at_ms":trigger_at,"trigger":trigger_result,"warm_models_count":warm.1["data"].as_array().map(Vec::len),"post_health_matched":post_matched,"child_exit":child_exit,
        "responsive_assertion":responsive,"assertion_passed":responsive.then_some(assertion_passed),"health_samples":count,"max_health_ms":max_health_ms,"armed_versions":armed_versions,"pin_change":pin_change,"pin_preserved":pin_change.then_some(pin_preserved)});
    fs::write(
        root.join("result.json"),
        serde_json::to_vec_pretty(&result)?,
    )?;
    println!("{result}");
    if responsive && !assertion_passed {
        return Err("liveness/model-identity/stale-pin assertion failed; see scalar result".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn health_rejects_wrong_process_or_error_status() {
        let v = json!({"pid":123,"port":4321,"service":"opencodex","status":"ok"});
        assert!(matched(200, &v, 123, 4321));
        assert!(!matched(200, &v, 124, 4321));
        assert!(!matched(500, &v, 123, 4321));
        assert!(!matched(200, &v, 123, 4322));
    }
    #[test]
    fn expired_io_deadline_is_an_error() {
        assert_eq!(
            left(Instant::now() - Duration::from_secs(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
    }
    #[test]
    fn truncated_or_malformed_http_is_rejected() {
        assert!(parse_http(b"HTTP/1.1 200 OK\r\n").is_err());
        assert!(parse_http(b"HTTP/1.1 invalid OK\r\n\r\n{}").is_err());
        assert!(parse_http(b"HTTP/1.1 200 OK\r\n\r\n{\"pid\":").is_err());
    }
    #[test]
    fn model_identity_rejects_missing_empty_and_duplicate_rows() {
        assert!(model_ids(&json!({})).is_err());
        assert!(model_ids(&json!({"data":[]})).is_err());
        assert!(model_ids(&json!({"data":[{"id":"a"},{"id":"a"}]})).is_err());
        assert!(model_ids(&json!({"data":[{}]})).is_err());
        assert_eq!(
            model_ids(&json!({"data":[{"id":"b"},{"id":"a"}]})).unwrap(),
            vec!["a", "b"]
        );
    }
}
