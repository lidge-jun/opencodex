use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

pub fn log_once(scope: &str, message: &str) {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let logged = LOGGED.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(mut logged) = logged.lock() {
        if logged.insert(format!("{scope}: {message}")) {
            eprintln!("{scope}: {message}");
        }
    }
}
