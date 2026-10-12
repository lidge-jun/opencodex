/// Build the Run value without letting spaces split the executable path.
pub fn command(executable: &str, argument: &str) -> Result<String, &'static str> {
    if executable.is_empty() || executable.contains(['"', '\0']) {
        return Err("invalid executable path for Windows autostart");
    }
    Ok(format!("\"{executable}\" {argument}"))
}

#[cfg(test)]
mod tests {
    use super::command;

    #[test]
    fn quotes_program_files_path_and_keeps_launch_origin() {
        assert_eq!(
            command(
                r"C:\Program Files\OpenCodex\opencodex-desktop.exe",
                "--autostart"
            )
            .unwrap(),
            r#""C:\Program Files\OpenCodex\opencodex-desktop.exe" --autostart"#
        );
    }

    #[test]
    fn quotes_paths_without_spaces_and_preserves_unicode() {
        for path in [r"C:\OpenCodex\app.exe", r"C:\用户\OpenCodex\app.exe"] {
            assert_eq!(
                command(path, "--autostart").unwrap(),
                format!("\"{path}\" --autostart")
            );
        }
    }

    #[test]
    fn rejects_paths_that_cannot_be_represented_in_a_run_command() {
        for path in ["", "bad\"path.exe", "bad\0path.exe"] {
            assert!(command(path, "--autostart").is_err());
        }
    }
}
