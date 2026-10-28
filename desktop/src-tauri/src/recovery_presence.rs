//! Read-only, process-lifetime recovery evidence with no persistent discovery record.
//! Consumers must independently identify its executable and the accepted socket's owner.

use std::{
    fs,
    io::{self, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

const DOMAIN: &str = "ocx-desktop-recovery-v1";
const CONNECTION_BUDGET: Duration = Duration::from_secs(3);
const MAX_CONNECTIONS: usize = 4;
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    /// None until the bundled CLI has resolved this shell's configuration home.
    pub home: Option<PathBuf>,
    /// Stop, Quit and update drain revoke this directly from the exit coordinator.
    pub wanted: bool,
}

pub struct Presence {
    stopped: Arc<AtomicBool>,
    address: SocketAddr,
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    bytes
        .iter()
        .flat_map(|b| {
            [
                DIGITS[(b >> 4) as usize] as char,
                DIGITS[(b & 15) as usize] as char,
            ]
        })
        .collect()
}

fn token(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn answer(request: &str, instance: &str, pid: u32, snapshot: Snapshot) -> Option<String> {
    let nonce = request
        .strip_prefix(&format!("{DOMAIN} "))?
        .strip_suffix('\n')?;
    if !token(nonce, 64) {
        return None;
    }
    let home = snapshot
        .home
        .and_then(|path| fs::canonicalize(path).ok())
        .and_then(|path| path.to_str().map(str::to_owned));
    let (state, home) = match home {
        Some(home) if home.len() <= 4096 => (
            if snapshot.wanted {
                "recovering"
            } else {
                "stopped"
            },
            hex(home.as_bytes()),
        ),
        _ => ("unknown", "-".to_owned()),
    };
    Some(format!(
        "{DOMAIN} {nonce} {instance} {pid} {state} {home}\n"
    ))
}

fn serve(mut stream: TcpStream, instance: &str, snapshot: &dyn Fn() -> Snapshot) -> io::Result<()> {
    if !stream.peer_addr()?.ip().is_loopback() {
        return Ok(());
    }
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    let deadline = Instant::now() + CONNECTION_BUDGET;
    // Two fresh challenges let the client bracket its OS observations without releasing the
    // accepted socket. Nothing serves HTTP, mutates state or accepts a reusable credential.
    for _ in 0..2 {
        let mut request = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(());
            }
            stream.set_read_timeout(Some(remaining))?;
            let mut byte = [0_u8; 1];
            if stream.read(&mut byte)? == 0 {
                return Ok(());
            }
            request.push(byte[0]);
            if request.len() > 128 {
                return Ok(());
            }
            if byte[0] == b'\n' {
                break;
            }
        }
        let Some(response) = std::str::from_utf8(&request)
            .ok()
            .and_then(|request| answer(request, instance, std::process::id(), snapshot()))
        else {
            return Ok(());
        };
        stream.write_all(response.as_bytes())?;
    }
    // Retain ownership of the exact accepted socket while the client takes its final snapshot.
    let remaining = deadline.saturating_duration_since(Instant::now());
    if !remaining.is_zero() {
        stream.set_read_timeout(Some(remaining))?;
        let _ = stream.read(&mut [0_u8; 1]);
    }
    Ok(())
}

impl Presence {
    pub fn start(
        instance: String,
        snapshot: Arc<dyn Fn() -> Snapshot + Send + Sync>,
    ) -> io::Result<Self> {
        Self::start_with_accept(instance, snapshot, TcpListener::accept)
    }

    fn start_with_accept(
        instance: String,
        snapshot: Arc<dyn Fn() -> Snapshot + Send + Sync>,
        mut accept: impl FnMut(&TcpListener) -> io::Result<(TcpStream, SocketAddr)> + Send + 'static,
    ) -> io::Result<Self> {
        if !token(&instance, 32) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let address = listener.local_addr()?;
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopped);
        let presence = Self { stopped, address };
        thread::Builder::new()
            .name("desktop-recovery".into())
            .spawn(move || {
                let active = Arc::new(AtomicUsize::new(0));
                while !stop.load(Ordering::Acquire) {
                    match accept(&listener) {
                        Ok((stream, _)) => {
                            if stop.load(Ordering::Acquire) {
                                break;
                            }
                            if active.load(Ordering::Acquire) >= MAX_CONNECTIONS {
                                continue;
                            }
                            active.fetch_add(1, Ordering::AcqRel);
                            let connection_active = Arc::clone(&active);
                            let snapshot = Arc::clone(&snapshot);
                            let instance = instance.clone();
                            if thread::Builder::new()
                                .name("desktop-recovery-read".into())
                                .spawn(move || {
                                    let _ = serve(stream, &instance, snapshot.as_ref());
                                    connection_active.fetch_sub(1, Ordering::AcqRel);
                                })
                                .is_err()
                            {
                                active.fetch_sub(1, Ordering::AcqRel);
                            }
                        }
                        Err(_) => {
                            // Retain the listener after transient aborts or resource exhaustion.
                            // Pace all errors, including interruptions, then recheck stop.
                            thread::sleep(ACCEPT_ERROR_BACKOFF);
                        }
                    }
                }
            })?;
        Ok(presence)
    }
}

impl Drop for Presence {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        // Wake the blocking accept without an idle polling timer or an unbounded shutdown wait.
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        sync::{mpsc, Mutex},
    };

    struct Finished(mpsc::Sender<()>);

    impl Drop for Finished {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }

    fn unresolved_snapshot() -> Snapshot {
        Snapshot {
            home: None,
            wanted: true,
        }
    }

    fn challenge(stream: &mut TcpStream) -> io::Result<String> {
        stream.set_read_timeout(Some(Duration::from_secs(1)))?;
        stream.write_all(format!("{DOMAIN} {}\n", "b".repeat(64)).as_bytes())?;
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response)?;
        Ok(response)
    }

    #[test]
    fn accept_errors_retry_before_a_real_connection() {
        for kind in [
            io::ErrorKind::ConnectionAborted,
            io::ErrorKind::Other,
            io::ErrorKind::Interrupted,
        ] {
            let (injected, observed) = mpsc::channel();
            let (finished, completion) = mpsc::channel();
            let finished = Finished(finished);
            let mut first = true;
            let presence = Presence::start_with_accept(
                "a".repeat(32),
                Arc::new(unresolved_snapshot),
                move |listener| {
                    let _ = &finished;
                    if first {
                        first = false;
                        let _ = injected.send(());
                        return Err(kind.into());
                    }
                    listener.accept()
                },
            )
            .unwrap();
            observed.recv_timeout(Duration::from_secs(1)).unwrap();
            // Only the error is injected; the next connection and response use the real socket.
            let response =
                TcpStream::connect(presence.address).and_then(|mut stream| challenge(&mut stream));
            drop(presence);
            completion.recv_timeout(Duration::from_secs(1)).unwrap();
            let response = response.unwrap_or_else(|error| panic!("{kind:?}: {error}"));
            assert!(response.starts_with(&format!("{DOMAIN} {} ", "b".repeat(64))));
            assert!(response.ends_with(" unknown -\n"));
        }
    }

    fn assert_persistent_accept_error_is_paced_and_stops(kind: io::ErrorKind) {
        let (attempted, attempts) = mpsc::channel();
        let (finished, completion) = mpsc::channel();
        let finished = Finished(finished);
        let mut count = 0;
        let presence =
            Presence::start_with_accept("a".repeat(32), Arc::new(unresolved_snapshot), move |_| {
                let _ = &finished;
                // Do not throttle the loop in the injected operation, even when it spins.
                if count < 3 {
                    let _ = attempted.send(Instant::now());
                }
                count += 1;
                Err(kind.into())
            })
            .unwrap();
        let times: Result<Vec<_>, _> = (0..3)
            .map(|_| attempts.recv_timeout(Duration::from_secs(1)))
            .collect();
        // Join the listener's lifetime signal before checking assertions, including a failed read.
        drop(presence);
        completion.recv_timeout(Duration::from_secs(1)).unwrap();
        let times = times.unwrap_or_else(|error| panic!("{kind:?}: {error}"));
        for pair in times.windows(2) {
            assert!(
                pair[1].duration_since(pair[0]) >= ACCEPT_ERROR_BACKOFF,
                "{kind:?} retried without an error backoff"
            );
        }
    }

    #[test]
    fn persistent_aborted_accept_errors_are_paced_and_stop() {
        assert_persistent_accept_error_is_paced_and_stops(io::ErrorKind::ConnectionAborted);
    }

    #[test]
    fn persistent_resource_accept_errors_are_paced_and_stop() {
        assert_persistent_accept_error_is_paced_and_stops(io::ErrorKind::Other);
    }

    #[test]
    fn persistent_interrupted_accept_errors_are_paced_and_stop() {
        assert_persistent_accept_error_is_paced_and_stops(io::ErrorKind::Interrupted);
    }

    #[test]
    fn a_fifth_reader_is_refused_while_four_challenged_readers_remain_open() {
        let presence = Presence::start("a".repeat(32), Arc::new(unresolved_snapshot)).unwrap();
        let mut readers = Vec::new();
        let result = (|| -> io::Result<usize> {
            for _ in 0..MAX_CONNECTIONS {
                let mut stream = TcpStream::connect(presence.address)?;
                let response = challenge(&mut stream)?;
                assert!(response.ends_with(" unknown -\n"));
                // A completed challenge proves each reader was admitted before trying the fifth.
                readers.push(stream);
            }
            let mut extra = TcpStream::connect(presence.address)?;
            extra.set_read_timeout(Some(Duration::from_secs(1)))?;
            extra.read(&mut [0_u8; 1])
        })();
        drop(readers);
        drop(presence);
        assert_eq!(result.unwrap(), 0);
    }

    #[test]
    fn fresh_challenges_observe_stop_without_replacing_the_listener() {
        let root = std::env::temp_dir().join(format!("ocx-recovery-wire-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let state = Arc::new(Mutex::new(Snapshot {
            home: Some(home),
            wanted: true,
        }));
        let observed = Arc::clone(&state);
        let presence = Presence::start(
            "a".repeat(32),
            Arc::new(move || observed.lock().unwrap().clone()),
        )
        .unwrap();
        let mut stream = TcpStream::connect(presence.address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        for (nonce, wanted) in [('b', true), ('c', false)] {
            state.lock().unwrap().wanted = wanted;
            let nonce = nonce.to_string().repeat(64);
            stream
                .write_all(format!("{DOMAIN} {nonce}\n").as_bytes())
                .unwrap();
            let mut response = String::new();
            BufReader::new(&stream).read_line(&mut response).unwrap();
            assert!(response.starts_with(&format!(
                "{DOMAIN} {nonce} {} {} ",
                "a".repeat(32),
                std::process::id()
            )));
            assert!(response.contains(if wanted { " recovering " } else { " stopped " }));
        }
        drop(stream);
        drop(presence);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn idle_connections_release_every_slot_within_the_connection_budget() {
        let presence = Presence::start(
            "a".repeat(32),
            Arc::new(|| Snapshot {
                home: None,
                wanted: true,
            }),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut idle: Vec<_> = (0..MAX_CONNECTIONS)
            .map(|_| TcpStream::connect(presence.address).unwrap())
            .collect();
        for stream in &mut idle {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "idle connection exhausted the client budget"
            );
            stream.set_read_timeout(Some(remaining)).unwrap();
            assert_eq!(stream.read(&mut [0_u8; 1]).unwrap(), 0);
        }
        assert!(Instant::now() < deadline);
        // A fresh challenge is admitted after the entire idle cohort has expired.
        let mut stream = TcpStream::connect(presence.address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let nonce = "b".repeat(64);
        stream
            .write_all(format!("{DOMAIN} {nonce}\n").as_bytes())
            .unwrap();
        let mut response = String::new();
        BufReader::new(&stream).read_line(&mut response).unwrap();
        assert!(response.starts_with(&format!("{DOMAIN} {nonce} ")));
        assert!(response.ends_with(" unknown -\n"));
    }

    #[test]
    fn unresolved_home_and_invalid_requests_never_assert_recovery() {
        let snapshot = Snapshot {
            home: None,
            wanted: true,
        };
        let request = format!("{DOMAIN} {}\n", "a".repeat(64));
        assert!(answer(&request, &"b".repeat(32), 123, snapshot.clone())
            .unwrap()
            .ends_with(" unknown -\n"));
        for request in [
            "GET / HTTP/1.1\n",
            "ocx-desktop-recovery-v1 short\n",
            "ocx-desktop-recovery-v1 a\r\n",
        ] {
            assert!(answer(request, &"b".repeat(32), 123, snapshot.clone()).is_none());
        }
    }
}
