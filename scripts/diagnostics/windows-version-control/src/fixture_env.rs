use std::{io, path::Path, process::Command};

/// Preserve the guard's protected home across fixture environment replacement.
pub fn arm_test_home_guard(command: &mut Command, original_home: &Path) -> io::Result<()> {
    if !original_home.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the original home must be absolute",
        ));
    }
    command
        .env("OCX_TEST_HOME_GUARD", "1")
        .env("OCX_REAL_HOME", original_home);
    Ok(())
}
