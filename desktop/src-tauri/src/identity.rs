//! This installation's own identity.
//!
//! The shared service install state records who owns the running proxy, and the claim names the
//! owning *installation* rather than the user or the machine. So the app has to hold a value of its
//! own to compare against, which is this: an opaque id written once into the app's config directory
//! and never rewritten.
//!
//! Two records rather than one is D3, and its cost is recorded there. An id stored only in the
//! shared record would be whoever wrote it last, which gives a reinstalled app no way to tell its
//! own prior consent from another installation's. The price is that a reinstall which keeps this
//! directory keeps its consent, and one that loses it has to ask again.

use std::{
    fs,
    io::{ErrorKind, Write},
    path::Path,
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

/// The file holding this installation's id, in the app's own config directory.
const FILE: &str = "install-id";

pub fn install_id(app: &AppHandle) -> Option<String> {
    let directory = app.path().app_config_dir().ok()?;
    install_id_in(&directory)
}

/// Read this installation's id, minting it the first time.
///
/// The mint is exclusive and the value is read back afterwards, so two launches racing each other
/// both answer to the id that won rather than to two different ones. Two ids would be two
/// installations as far as the recorded claim is concerned, and the second would find a claim that
/// is not its own and ask again for consent the user had already given.
pub fn install_id_in(directory: &Path) -> Option<String> {
    let path = directory.join(FILE);
    if let Some(existing) = read(&path) {
        return Some(existing);
    }
    fs::create_dir_all(directory).ok()?;
    match mint(&path) {
        Ok(()) => {}
        // The file is there and says nothing: a blank or truncated write from an interrupted first
        // run. An empty id matches nothing, so every comparison against the recorded claim would
        // quietly be false and the app would ask for consent it already had. Replace it.
        Err(ErrorKind::AlreadyExists) => {
            if read(&path).is_none() {
                fs::write(&path, Uuid::new_v4().to_string()).ok()?;
            }
        }
        Err(_) => return None,
    }
    read(&path)
}

fn mint(path: &Path) -> Result<(), ErrorKind> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(Uuid::new_v4().to_string().as_bytes()))
        .map_err(|error| error.kind())
}

fn read(path: &Path) -> Option<String> {
    let value = fs::read_to_string(path).ok()?;
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{install_id_in, FILE};
    use std::fs;

    fn scratch(name: &str) -> std::path::PathBuf {
        let directory =
            std::env::temp_dir().join(format!("ocx-identity-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        directory
    }

    #[test]
    fn the_id_is_minted_once_and_then_read_back() {
        let directory = scratch("mint");
        let first = install_id_in(&directory).expect("an id");
        assert!(!first.is_empty());
        assert_eq!(install_id_in(&directory).as_deref(), Some(first.as_str()));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn two_installations_do_not_share_an_id() {
        let one = scratch("one");
        let two = scratch("two");
        assert_ne!(install_id_in(&one), install_id_in(&two));
        let _ = fs::remove_dir_all(&one);
        let _ = fs::remove_dir_all(&two);
    }

    #[test]
    fn a_blank_record_is_replaced_rather_than_answered_with() {
        let directory = scratch("blank");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(FILE), "   \n").unwrap();
        let minted = install_id_in(&directory).expect("an id");
        assert!(!minted.trim().is_empty());
        assert_eq!(install_id_in(&directory).as_deref(), Some(minted.as_str()));
        let _ = fs::remove_dir_all(&directory);
    }
}
