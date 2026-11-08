//! Where the macOS traffic lights sit over the overlay title bar.
//!
//! The dashboard's sidebar strip (`gui/src/components/app-titlebar.css`) is a 40pt row with an
//! 80pt lead inset, and the native lights have to sit centered on that row. tao places them by
//! resizing the title-bar container to `close button height + y` and moving each button to
//! `x + i * spacing`; the button keeps its own offset inside the container. So the same `y`
//! lands differently when AppKit's button metrics change, and they did change in macOS 26:
//!
//! | design          | close button | spacing | y=22 centers at | y centering on 20 |
//! |-----------------|--------------|---------|-----------------|-------------------|
//! | macOS 26 Tahoe  | 14 x 14      | 23      | 20              | 22                |
//! | macOS 15 and up | 14 x 16      | 20      | 24 (4pt low)    | 18                |
//!
//! Both rows were measured with an AppKit probe that replays tao 0.37.2's
//! `inset_traffic_lights` on an overlay window: once with the Tahoe design and once with the
//! pre-Tahoe design forced through `UIDesignRequiresCompatibility` (#8280). Horizontally both
//! designs start at x and end inside the strip's 80pt inset (Tahoe at 78pt, pre-Tahoe at 72pt),
//! so only `y` depends on the OS.

/// Lead inset of the close button, in points. `--tl-inset` in app-titlebar.css is this plus
/// 52pt of lights and 10pt of air.
pub const X: f64 = 18.0;
/// macOS 26 (Tahoe) and later: 14pt-tall buttons centered on the 40pt row.
pub const Y_TAHOE: f64 = 22.0;
/// macOS 15 (Sequoia) and earlier: 16pt-tall buttons need 4pt less to land on the same line.
pub const Y_PRE_TAHOE: f64 = 18.0;
/// The first release with the taller title bar metrics. Apple went from 15 straight to 26.
const TAHOE_MAJOR: u32 = 26;

/// The `y` for a given macOS major version. An unknown version keeps the Tahoe value, which is
/// what every build shipped before this distinction existed.
pub fn y_for(macos_major: Option<u32>) -> f64 {
    match macos_major {
        Some(major) if major < TAHOE_MAJOR => Y_PRE_TAHOE,
        _ => Y_TAHOE,
    }
}

/// The major component of a product version such as `15.7.1` or `26.0`.
fn parse_major(version: &str) -> Option<u32> {
    version.trim().split('.').next()?.parse().ok()
}

/// The running macOS major version, from `kern.osproductversion`. Unlike the
/// `SystemVersion.plist` reads behind some version APIs, this sysctl is not redirected by
/// `SYSTEM_VERSION_COMPAT`, so it reports the real release.
#[cfg(target_os = "macos")]
pub fn macos_major() -> Option<u32> {
    use std::ffi::{c_char, c_int, c_void, CStr};
    extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> c_int;
    }
    let mut buffer = [0u8; 32];
    let mut len = buffer.len();
    // SAFETY: the name is NUL-terminated, `buffer` is writable for `len` bytes, and no new
    // value is set.
    let status = unsafe {
        sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return None;
    }
    let version = CStr::from_bytes_until_nul(&buffer[..len.min(buffer.len())]).ok()?;
    parse_major(version.to_str().ok()?)
}

#[cfg(test)]
mod tests {
    use super::{parse_major, y_for, X, Y_PRE_TAHOE, Y_TAHOE};

    #[test]
    fn product_versions_parse_to_their_major() {
        assert_eq!(parse_major("26.6.2"), Some(26));
        assert_eq!(parse_major("15.7.1"), Some(15));
        assert_eq!(parse_major("14.0"), Some(14));
        assert_eq!(parse_major("10.16"), Some(10));
        assert_eq!(parse_major(" 13 "), Some(13));
        assert_eq!(parse_major(""), None);
        assert_eq!(parse_major("abc"), None);
    }

    #[test]
    fn sequoia_and_earlier_lift_the_lights_onto_the_strip() {
        for major in [10, 11, 12, 13, 14, 15] {
            assert_eq!(y_for(Some(major)), Y_PRE_TAHOE, "macOS {major}");
        }
        for major in [26, 27, 30] {
            assert_eq!(y_for(Some(major)), Y_TAHOE, "macOS {major}");
        }
        assert_eq!(y_for(None), Y_TAHOE);
    }

    /// The measured geometry behind the constants: tao sets the container to
    /// `button_height + y`, AppKit keeps the button's default offset from the container's bottom
    /// edge, and the light should be centered on the 40pt strip row.
    #[test]
    fn both_designs_center_on_the_strip_row() {
        // Center of the light, measured from the window's top edge.
        let center = |height: f64, bottom: f64, y: f64| (height + y) - bottom - height / 2.0;
        // Tahoe: a 14pt button whose default frame origin is (9, 9).
        assert_eq!(center(14.0, 9.0, Y_TAHOE), 20.0);
        // Pre-Tahoe: a 16pt button whose default frame origin is (7, 6).
        assert_eq!(center(16.0, 6.0, Y_PRE_TAHOE), 20.0);
        assert_eq!(center(16.0, 6.0, Y_TAHOE), 24.0);
        assert_eq!(X, 18.0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_running_macos_reports_a_major_version() {
        let major = super::macos_major().expect("kern.osproductversion");
        assert!(major >= 10, "{major}");
    }
}
