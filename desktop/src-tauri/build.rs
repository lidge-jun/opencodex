fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_native_tray();
    }
    tauri_build::build();
}

fn build_native_tray() {
    use std::{env, fs, path::PathBuf, process::Command};
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let sources = manifest.join("../../app/Sources/NativeTray");
    println!("cargo:rerun-if-changed={}", sources.display());
    let mut files: Vec<_> = fs::read_dir(&sources)
        .expect("NativeTray source directory is missing")
        .map(|entry| entry.expect("cannot read native tray source").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "swift")
        })
        .collect();
    files.sort();
    assert!(!files.is_empty(), "NativeTray source set is empty");
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        other => panic!("unsupported macOS native tray architecture: {other}"),
    };
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let archive = out.join("libNativeTray.a");
    let status = Command::new("xcrun")
        .args([
            "--sdk",
            "macosx",
            "swiftc",
            "-parse-as-library",
            "-emit-library",
            "-static",
        ])
        .args([
            "-module-name",
            "NativeTray",
            "-target",
            &format!("{arch}-apple-macos13.0"),
        ])
        .arg(if env::var("PROFILE").as_deref() == Ok("release") {
            "-O"
        } else {
            "-Onone"
        })
        .args(&files)
        .arg("-o")
        .arg(&archive)
        .status()
        .expect("cannot run swiftc; install the macOS developer tools");
    assert!(status.success(), "NativeTray Swift compilation failed");
    if env::var("PROFILE").as_deref() == Ok("release") {
        let symbols = Command::new("xcrun")
            .args(["nm", "-u"])
            .arg(&archive)
            .output()
            .expect("cannot inspect NativeTray archive");
        assert!(symbols.status.success() && String::from_utf8_lossy(&symbols.stdout).contains("NSGlassEffectView"),
            "macOS release builds require Xcode 26+ so supported systems receive Apple Liquid Glass");
    }
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=NativeTray");
    // Darwin object autolinking supplies the system frameworks used by SwiftUI/Charts.
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
