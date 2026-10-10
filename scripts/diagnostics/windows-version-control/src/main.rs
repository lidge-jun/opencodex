#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod control;

fn main() {
    #[cfg(windows)]
    if let Err(error) = control::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        eprintln!("This optional diagnostic requires Windows.");
        std::process::exit(2);
    }
}
