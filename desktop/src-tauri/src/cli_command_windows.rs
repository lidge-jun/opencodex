#[cfg(any(windows, test))]
use crate::cli_command_record::Windows;
#[cfg(windows)]
use crate::cli_command_record::{Bundle, Record};
use crate::cli_command_record::{Change, Result};
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
pub(crate) mod private_acl {
    use super::*;
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};
    type Ptr = *mut c_void;
    const UNSAFE: &str = "private-acl-unsafe";
    const ACL_REVISION: u32 = 2;
    const FULL_CONTROL: u32 = 0x1f01ff;
    const OBJECT_INHERIT_ACE: u32 = 0x1;
    const CONTAINER_INHERIT_ACE: u32 = 0x2;
    const SE_FILE_OBJECT: u32 = 1;
    const DACL_SECURITY_INFORMATION: u32 = 4;
    const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x80000000;
    #[repr(C)]
    struct Acl {
        revision: u8,
        reserved: u8,
        size: u16,
        count: u16,
        reserved2: u16,
    }
    #[repr(C)]
    struct AceHeader {
        kind: u8,
        flags: u8,
        size: u16,
    }
    #[repr(C)]
    struct Sid {
        revision: u8,
        count: u8,
        authority: [u8; 6],
        sub: [u32; 2],
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: Ptr, access: u32, token: *mut Ptr) -> i32;
        fn GetTokenInformation(
            token: Ptr,
            class: u32,
            info: Ptr,
            size: u32,
            needed: *mut u32,
        ) -> i32;
        fn CreateWellKnownSid(kind: u32, domain: Ptr, sid: Ptr, size: *mut u32) -> i32;
        fn InitializeAcl(acl: *mut Acl, size: u32, revision: u32) -> i32;
        fn AddAccessAllowedAceEx(
            acl: *mut Acl,
            revision: u32,
            flags: u32,
            mask: u32,
            sid: Ptr,
        ) -> i32;
        fn SetNamedSecurityInfoW(
            name: *mut u16,
            kind: u32,
            info: u32,
            owner: Ptr,
            group: Ptr,
            dacl: *mut Acl,
            sacl: *mut Acl,
        ) -> u32;
        fn GetNamedSecurityInfoW(
            name: *const u16,
            kind: u32,
            info: u32,
            owner: *mut Ptr,
            group: *mut Ptr,
            dacl: *mut *mut Acl,
            sacl: *mut *mut Acl,
            descriptor: *mut Ptr,
        ) -> u32;
        fn GetSecurityDescriptorControl(
            descriptor: Ptr,
            control: *mut u16,
            revision: *mut u32,
        ) -> i32;
        fn GetSecurityDescriptorDacl(
            descriptor: Ptr,
            present: *mut i32,
            dacl: *mut *mut Acl,
            defaulted: *mut i32,
        ) -> i32;
        fn EqualSid(a: Ptr, b: Ptr) -> i32;
        fn IsValidSid(sid: Ptr) -> i32;
        fn IsValidAcl(acl: *mut Acl) -> i32;
        fn GetAce(acl: *mut Acl, index: u32, ace: *mut Ptr) -> i32;
        fn GetLengthSid(sid: Ptr) -> u32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> Ptr;
        fn CloseHandle(handle: Ptr) -> i32;
        fn LocalFree(memory: Ptr) -> Ptr;
    }
    struct Local(Ptr);
    impl Drop for Local {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
    }
    struct Token(Ptr);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn user() -> Result<Vec<usize>> {
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), 0x8, &mut token) } == 0 {
            return Err(UNSAFE.into());
        }
        let token = Token(token);
        let mut needed = 0;
        unsafe {
            GetTokenInformation(token.0, 1, ptr::null_mut(), 0, &mut needed);
        }
        if needed < std::mem::size_of::<usize>() as u32 || needed > 65536 {
            return Err(UNSAFE.into());
        }
        let mut bytes = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            GetTokenInformation(token.0, 1, bytes.as_mut_ptr().cast(), needed, &mut needed)
        } == 0
        {
            return Err(UNSAFE.into());
        }
        if unsafe { IsValidSid(bytes[0] as Ptr) } == 0 {
            return Err(UNSAFE.into());
        }
        Ok(bytes)
    }
    fn wide(path: &Path) -> Result<Vec<u16>> {
        let out: Vec<_> = path.as_os_str().encode_wide().collect();
        if out.contains(&0) {
            return Err(UNSAFE.into());
        }
        Ok(out.into_iter().chain(Some(0)).collect())
    }
    pub fn verify(path: &Path, root: bool) -> Result<()> {
        let user = user()?;
        let name = wide(path)?;
        let mut owner = ptr::null_mut();
        let mut dacl = ptr::null_mut();
        let mut descriptor = ptr::null_mut();
        let code = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                1,
                1 | 4,
                &mut owner,
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        // Owner and DACL point inside this allocation; only the descriptor is freed.
        let descriptor = Local(descriptor);
        if code != 0 || descriptor.0.is_null() || owner.is_null() || dacl.is_null() {
            return Err(UNSAFE.into());
        }
        let mut control = 0;
        let mut revision = 0;
        let mut present = 0;
        let mut defaulted = 0;
        if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0
            || unsafe {
                GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted)
            } == 0
            || present == 0
            || dacl.is_null()
            || unsafe { IsValidAcl(dacl) } == 0
            || unsafe { IsValidSid(owner) } == 0
            || unsafe { EqualSid(owner, user[0] as Ptr) } == 0
            || root && control & 0x1000 == 0
        {
            return Err(UNSAFE.into());
        }
        let mut system = Sid {
            revision: 1,
            count: 1,
            authority: [0, 0, 0, 0, 0, 5],
            sub: [18, 0],
        };
        let mut admins = Sid {
            revision: 1,
            count: 2,
            authority: [0, 0, 0, 0, 0, 5],
            sub: [32, 544],
        };
        let mut full_control = false;
        for i in 0..unsafe { (*dacl).count } as u32 {
            let mut ace = ptr::null_mut();
            if unsafe { GetAce(dacl, i, &mut ace) } == 0 || ace.is_null() {
                return Err(UNSAFE.into());
            }
            let header = unsafe { &*ace.cast::<AceHeader>() };
            if header.kind != 0 || header.size < 16 || root && header.flags & 0x10 != 0 {
                return Err(UNSAFE.into());
            }
            let mask = unsafe { *ace.cast::<u8>().add(4).cast::<u32>() };
            let sid = unsafe { ace.cast::<u8>().add(8).cast::<c_void>() };
            if unsafe { IsValidSid(sid) } == 0
                || unsafe { GetLengthSid(sid) } + 8 > header.size as u32
            {
                return Err(UNSAFE.into());
            }
            let is_user = unsafe { EqualSid(sid, user[0] as Ptr) } != 0;
            if !is_user
                && unsafe { EqualSid(sid, (&mut system as *mut Sid).cast()) } == 0
                && unsafe { EqualSid(sid, (&mut admins as *mut Sid).cast()) } == 0
            {
                return Err(UNSAFE.into());
            }
            // INHERIT_ONLY_ACE does not grant this object access.
            full_control |= is_user
                && header.flags & 0x8 == 0
                && (mask & 0x1f01ff == 0x1f01ff || mask & 0x10000000 != 0);
        }
        if !full_control {
            return Err(UNSAFE.into());
        }
        Ok(())
    }
    fn well_known_sid(kind: u32) -> Result<[u32; 17]> {
        // SECURITY_MAX_SID_SIZE is 68 bytes. Caller-owned, DWORD-aligned storage
        // needs no LocalFree/FreeSid and remains alive while building the ACL.
        let mut sid = [0u32; 17];
        let mut size = std::mem::size_of_val(&sid) as u32;
        if unsafe { CreateWellKnownSid(kind, ptr::null_mut(), sid.as_mut_ptr().cast(), &mut size) }
            == 0
        {
            return Err(UNSAFE.into());
        }
        Ok(sid)
    }
    fn allowed_acl(sids: &[Ptr], flags: u32) -> Result<Vec<u32>> {
        let size = std::mem::size_of::<Acl>() as u32
            + sids
                .iter()
                .map(|sid| 8 + unsafe { GetLengthSid(*sid) })
                .sum::<u32>();
        let mut buffer = vec![0u32; (size as usize).div_ceil(std::mem::size_of::<u32>())];
        let acl = buffer.as_mut_ptr().cast::<Acl>();
        if unsafe { InitializeAcl(acl, size, ACL_REVISION) } == 0 {
            return Err(UNSAFE.into());
        }
        for sid in sids {
            if unsafe { AddAccessAllowedAceEx(acl, ACL_REVISION, flags, FULL_CONTROL, *sid) } == 0 {
                return Err(UNSAFE.into());
            }
        }
        Ok(buffer)
    }
    pub fn harden(path: &Path, directory: bool) -> Result<()> {
        let user = user()?;
        let mut system = well_known_sid(22)?; // WinLocalSystemSid
        let mut admins = well_known_sid(26)?; // WinBuiltinAdministratorsSid
        let mut acl = allowed_acl(
            &[
                user[0] as Ptr,
                system.as_mut_ptr().cast(),
                admins.as_mut_ptr().cast(),
            ],
            if directory {
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
            } else {
                0
            },
        )?;
        let mut name = wide(path)?;
        if unsafe {
            SetNamedSecurityInfoW(
                name.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                acl.as_mut_ptr().cast(),
                ptr::null_mut(),
            )
        } != 0
        {
            return Err(UNSAFE.into());
        }
        verify(path, directory)
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::cli_command_record::{self as record, tests::Temp, Store};
        #[link(name = "advapi32")]
        unsafe extern "system" {
            fn AddAccessAllowedAce(acl: *mut Acl, revision: u32, mask: u32, sid: Ptr) -> i32;
        }
        #[test]
        fn harden_sets_only_three_full_control_aces_with_directory_inheritance() {
            let t = Temp::new();
            let root = t.0.join("root");
            record::private_dir(&root).unwrap();
            let file = root.join("file");
            std::fs::write(&file, b"test").unwrap();
            harden(&file, false).unwrap();
            let user = user().unwrap();
            let mut system = well_known_sid(22).unwrap();
            let mut admins = well_known_sid(26).unwrap();
            let sids = [
                user[0] as Ptr,
                system.as_mut_ptr().cast(),
                admins.as_mut_ptr().cast(),
            ];
            for (path, flags) in [(&root, 0x3), (&file, 0)] {
                let name = wide(path).unwrap();
                let mut dacl = ptr::null_mut();
                let mut descriptor = ptr::null_mut();
                assert_eq!(
                    unsafe {
                        GetNamedSecurityInfoW(
                            name.as_ptr(),
                            SE_FILE_OBJECT,
                            DACL_SECURITY_INFORMATION,
                            ptr::null_mut(),
                            ptr::null_mut(),
                            &mut dacl,
                            ptr::null_mut(),
                            &mut descriptor,
                        )
                    },
                    0
                );
                let descriptor = Local(descriptor);
                assert!(!dacl.is_null());
                let mut control = 0;
                let mut revision = 0;
                assert_ne!(
                    unsafe {
                        GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision)
                    },
                    0
                );
                assert_ne!(control & 0x1000, 0);
                assert_eq!(unsafe { (*dacl).count }, 3);
                for (index, sid) in sids.iter().enumerate() {
                    let mut ace = ptr::null_mut();
                    assert_ne!(unsafe { GetAce(dacl, index as u32, &mut ace) }, 0);
                    let header = unsafe { &*ace.cast::<AceHeader>() };
                    assert_eq!(header.kind, 0);
                    assert_eq!(header.flags, flags);
                    assert_eq!(
                        unsafe { *ace.cast::<u8>().add(4).cast::<u32>() },
                        FULL_CONTROL
                    );
                    assert_ne!(unsafe { EqualSid(ace.cast::<u8>().add(8).cast(), *sid) }, 0);
                }
            }
        }
        #[test]
        fn hardened_root_and_inherited_child_are_valid_after_store_reopen() {
            let t = Temp::new();
            let s = t.store();
            verify(&s.root, true).unwrap();
            let child = s.root.join("backups/child");
            std::fs::write(&child, b"test").unwrap();
            verify(&child, false).unwrap();
            let root = s.root.clone();
            drop(s);
            let s = Store::open(root, vec![]).unwrap();
            verify(&s.root, true).unwrap();
            verify(&child, false).unwrap();
        }
        #[test]
        fn root_without_protection_is_refused_even_without_inherited_aces() {
            let t = Temp::new();
            // Replace the temporary parent's whole DACL with one non-inheritable user ACE.
            let user = user().unwrap();
            let size =
                std::mem::size_of::<Acl>() as u32 + 8 + unsafe { GetLengthSid(user[0] as Ptr) };
            let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
            let parent_acl = buffer.as_mut_ptr().cast::<Acl>();
            assert_ne!(unsafe { InitializeAcl(parent_acl, size, 2) }, 0);
            assert_ne!(
                unsafe { AddAccessAllowedAce(parent_acl, 2, 0x1f01ff, user[0] as Ptr) },
                0
            );
            let mut parent_name = wide(&t.0).unwrap();
            assert_eq!(
                unsafe {
                    SetNamedSecurityInfoW(
                        parent_name.as_mut_ptr(),
                        1,
                        4 | 0x80000000,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        parent_acl,
                        ptr::null_mut(),
                    )
                },
                0
            );
            verify(&t.0, true).unwrap();
            let mut dacl = ptr::null_mut();
            let mut descriptor = ptr::null_mut();
            assert_eq!(
                unsafe {
                    GetNamedSecurityInfoW(
                        parent_name.as_ptr(),
                        1,
                        4,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        &mut dacl,
                        ptr::null_mut(),
                        &mut descriptor,
                    )
                },
                0
            );
            let descriptor = Local(descriptor);
            assert!(!dacl.is_null());
            assert_eq!(unsafe { (*dacl).count }, 1);
            let mut ace = ptr::null_mut();
            assert_ne!(unsafe { GetAce(dacl, 0, &mut ace) }, 0);
            assert_eq!(unsafe { (*ace.cast::<AceHeader>()).flags } & 0x3, 0);
            drop(descriptor);

            let root = t.0.join("root");
            record::private_dir(&root).unwrap();
            let mut name = wide(&root).unwrap();
            let mut dacl = ptr::null_mut();
            let mut descriptor = ptr::null_mut();
            assert_eq!(
                unsafe {
                    GetNamedSecurityInfoW(
                        name.as_ptr(),
                        1,
                        4,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        &mut dacl,
                        ptr::null_mut(),
                        &mut descriptor,
                    )
                },
                0
            );
            let descriptor = Local(descriptor);
            assert!(!dacl.is_null());
            // Preserve the explicit, full-control root ACL and only remove its protection.
            assert_eq!(
                unsafe {
                    SetNamedSecurityInfoW(
                        name.as_mut_ptr(),
                        1,
                        4 | 0x20000000,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        dacl,
                        ptr::null_mut(),
                    )
                },
                0
            );
            drop(descriptor);
            let mut checked = ptr::null_mut();
            let mut descriptor = ptr::null_mut();
            assert_eq!(
                unsafe {
                    GetNamedSecurityInfoW(
                        name.as_ptr(),
                        1,
                        4,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        &mut checked,
                        ptr::null_mut(),
                        &mut descriptor,
                    )
                },
                0
            );
            let descriptor = Local(descriptor);
            let mut control = 0;
            let mut revision = 0;
            assert_ne!(
                unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) },
                0
            );
            assert_eq!(control & 0x1000, 0);
            assert!(!checked.is_null());
            for i in 0..unsafe { (*checked).count } as u32 {
                let mut ace = ptr::null_mut();
                assert_ne!(unsafe { GetAce(checked, i, &mut ace) }, 0);
                assert_eq!(unsafe { (*ace.cast::<AceHeader>()).flags } & 0x10, 0);
            }
            // All other child ACL rules pass; the root fails specifically on SE_DACL_PROTECTED.
            verify(&root, false).unwrap();
            assert_eq!(verify(&root, true).unwrap_err(), UNSAFE);
        }
        #[test]
        fn explicit_everyone_ace_is_refused_on_root_and_child() {
            let t = Temp::new();
            let s = t.store();
            let child = s.root.join("backups/child");
            std::fs::write(&child, b"test").unwrap();
            for (path, root) in [(&s.root, true), (&child, false)] {
                let user = user().unwrap();
                let mut everyone = well_known_sid(1).unwrap(); // WinWorldSid
                let mut acl =
                    allowed_acl(&[user[0] as Ptr, everyone.as_mut_ptr().cast()], 0).unwrap();
                let mut name = wide(path).unwrap();
                assert_eq!(
                    unsafe {
                        SetNamedSecurityInfoW(
                            name.as_mut_ptr(),
                            SE_FILE_OBJECT,
                            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                            ptr::null_mut(),
                            ptr::null_mut(),
                            acl.as_mut_ptr().cast(),
                            ptr::null_mut(),
                        )
                    },
                    0
                );
                assert_eq!(verify(path, root).unwrap_err(), UNSAFE);
            }
        }
        #[test]
        fn protected_owned_root_with_null_dacl_is_refused() {
            let t = Temp::new();
            let root = t.0.join("root");
            record::private_dir(&root).unwrap();
            let mut name = wide(&root).unwrap();
            assert_eq!(
                unsafe {
                    SetNamedSecurityInfoW(
                        name.as_mut_ptr(),
                        1,
                        4 | 0x80000000,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                    )
                },
                0
            );
            assert_eq!(verify(&root, true).unwrap_err(), UNSAFE);
            harden(&root, true).unwrap();
        }
    }
}
#[cfg(any(windows, test))]
fn normalized(s: &str) -> String {
    s.replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}
#[cfg(any(windows, test))]
fn parts(s: &str) -> Vec<String> {
    if s.is_empty() {
        Vec::new()
    } else {
        s.split(';').map(str::to_owned).collect()
    }
}
#[cfg(any(windows, test))]
fn index(v: &[String], entry: &str) -> Result<Option<usize>> {
    let hits: Vec<_> = v
        .iter()
        .enumerate()
        .filter(|(_, s)| normalized(s) == normalized(entry))
        .map(|(i, _)| i)
        .collect();
    if hits.len() > 1 {
        Err("path-entry-ambiguous".into())
    } else {
        Ok(hits.first().copied())
    }
}
#[cfg(any(windows, test))]
fn entry_ok(s: &str) -> bool {
    !s.is_empty() && !s.contains([';', '\0', '\r', '\n'])
}
#[cfg(any(windows, test))]
pub fn prepend(raw: &str, entry: &str, ty: &str) -> Result<(String, Windows)> {
    if !entry_ok(entry) || !matches!(ty, "REG_SZ" | "REG_EXPAND_SZ") {
        return Err("path-invalid".into());
    }
    let mut v = parts(raw);
    let found = index(&v, entry)?;
    let before = found.and_then(|i| i.checked_sub(1)).map(|i| v[i].clone());
    let after = found.and_then(|i| v.get(i + 1)).cloned();
    let actual = found.map(|i| v.remove(i)).unwrap_or_else(|| entry.into());
    v.insert(0, actual);
    let result = v.join(";");
    if result.encode_utf16().count() + 1 > 32_767 {
        return Err("path-too-long".into());
    }
    Ok((
        result,
        Windows {
            key: "HKCU\\Environment".into(),
            value: "Path".into(),
            entry: entry.into(),
            value_type: ty.into(),
            action: if found.is_some() {
                "moved-existing"
            } else {
                "inserted"
            }
            .into(),
            previous_before: before,
            previous_after: after,
        },
    ))
}
#[cfg(any(windows, test))]
pub fn remove(raw: &str, owned: &Windows) -> Result<String> {
    let mut v = parts(raw);
    let Some(i) = index(&v, &owned.entry)? else {
        return Ok(raw.into());
    };
    if owned.action == "inserted" {
        v.remove(i);
        return Ok(v.join(";"));
    }
    let actual = v.remove(i);
    let before = owned
        .previous_before
        .as_deref()
        .map(|s| index(&v, s))
        .transpose()?
        .flatten();
    let after = owned
        .previous_after
        .as_deref()
        .map(|s| index(&v, s))
        .transpose()?
        .flatten();
    let position = match (
        before,
        after,
        owned.previous_before.is_none(),
        owned.previous_after.is_none(),
    ) {
        (Some(b), Some(a), _, _) if b + 1 == a => a,
        (Some(b), None, _, true) if b + 1 == v.len() => v.len(),
        (None, Some(0), true, _) => 0,
        (None, None, true, true) if v.is_empty() => 0,
        _ => return Err("path-restore-ambiguous".into()),
    };
    v.insert(position, actual);
    Ok(v.join(";"))
}
#[cfg(any(windows, test))]
pub fn replace_owned_entry(
    raw: &str,
    owned: Option<&Windows>,
    entry: &str,
    ty: &str,
) -> Result<(String, Windows)> {
    if let Some(old) = owned {
        if normalized(&old.entry) == normalized(entry) {
            if index(&parts(raw), entry)?.is_none() {
                return prepend(raw, entry, ty);
            }
            let (out, _) = prepend(raw, entry, ty)?;
            let mut retained = old.clone();
            retained.value_type = ty.into();
            return Ok((out, retained));
        }
        prepend(&remove(raw, old)?, entry, ty)
    } else {
        prepend(raw, entry, ty)
    }
}
#[cfg(windows)]
pub fn stable_bundle(exe: &Path, debug: bool, version: &str) -> Result<Bundle> {
    if debug {
        return Err("development-launch".into());
    }
    let real = std::fs::canonicalize(exe).map_err(|_| "bundle-unavailable")?;
    let parent = real.parent().ok_or("unpackaged-launch")?;
    // current_exe is already absolute. Do not persist canonical Windows \\?\ extended syntax.
    let app = exe.to_str().ok_or("path-not-utf8")?;
    let cli = exe.parent().ok_or("unpackaged-launch")?.join("ocx.exe");
    let raw = cli.to_str().ok_or("path-not-utf8")?;
    let canonical = real
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('/', "\\");
    let lower = app.to_ascii_lowercase().replace('/', "\\");
    if lower.contains("\\target\\")
        || lower.contains("\\temp\\")
        || lower.contains("\\tmp\\")
        || canonical.contains("\\target\\")
        || canonical.contains("\\temp\\")
        || canonical.contains("\\tmp\\")
        || !std::fs::symlink_metadata(parent.join("ocx.exe"))
            .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
    {
        return Err("unpackaged-launch".into());
    }
    if !entry_ok(raw) || !exe.is_absolute() {
        return Err("path-invalid".into());
    }
    Ok(Bundle {
        platform: "win32".into(),
        kind: "windows-install".into(),
        app_executable: app.into(),
        cli_executable: raw.into(),
        version: version.into(),
    })
}
#[cfg(windows)]
mod os {
    use super::*;
    use winreg::{
        enums::{
            HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ,
        },
        RegKey, RegValue,
    };
    pub fn raw() -> Result<Option<RegValue>> {
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", KEY_READ)
            .map_err(|_| "registry-read-failed")?;
        match key.get_raw_value("Path") {
            Ok(v) if matches!(v.vtype, REG_SZ | REG_EXPAND_SZ) => Ok(Some(v)),
            Ok(_) => Err("path-type-unsupported".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("registry-read-failed".into()),
        }
    }
    pub fn decode(b: &[u8]) -> Result<String> {
        if !b.len().is_multiple_of(2) {
            return Err("path-invalid-utf16".into());
        }
        let mut words: Vec<u16> = b
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        if words.pop() != Some(0) || words.contains(&0) {
            return Err("path-invalid-utf16".into());
        }
        String::from_utf16(&words).map_err(|_| "path-invalid-utf16".into())
    }
    pub fn encode(s: &str) -> Vec<u8> {
        s.encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect()
    }
    pub fn type_name(v: &RegValue) -> &'static str {
        if v.vtype == REG_EXPAND_SZ {
            "REG_EXPAND_SZ"
        } else {
            "REG_SZ"
        }
    }
    pub fn write(c: &Change) -> Result<()> {
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", KEY_SET_VALUE)
            .map_err(|_| "registry-write-failed")?;
        match &c.after {
            Some(b) => {
                decode(b)?;
                key.set_raw_value(
                    "Path",
                    &RegValue {
                        bytes: b.clone(),
                        vtype: if c.kind == "registry-expand" {
                            REG_EXPAND_SZ
                        } else {
                            REG_SZ
                        },
                    },
                )
                .map_err(|_| "registry-write-failed".into())
            }
            None => match key.delete_value("Path") {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("registry-write-failed".into()),
            },
        }
    }
    pub fn machine_conflict() -> Result<bool> {
        let k = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(
                "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
                KEY_READ,
            )
            .map_err(|_| "machine-path-unobserved")?;
        let v = match k.get_raw_value("Path") {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("machine-path-unobserved".into()),
        };
        let raw = decode(&v.bytes)?;
        // Preserve raw text in storage; expansion below is observe-only for conflict detection.
        for p in parts(&raw) {
            let expanded = expand(&p)?;
            for name in ["ocx.exe", "ocx.com", "ocx.cmd", "ocx.bat"] {
                if Path::new(expanded.trim_matches('"')).join(name).is_file() {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    fn expand(s: &str) -> Result<String> {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn ExpandEnvironmentStringsW(src: *const u16, dst: *mut u16, size: u32) -> u32;
        }
        let src: Vec<u16> = s.encode_utf16().chain(Some(0)).collect();
        let mut dst = vec![0u16; 32_767];
        let n =
            unsafe { ExpandEnvironmentStringsW(src.as_ptr(), dst.as_mut_ptr(), dst.len() as u32) };
        if n == 0 || n as usize > dst.len() {
            return Err("machine-path-unobserved".into());
        }
        let out =
            String::from_utf16(&dst[..n as usize - 1]).map_err(|_| "machine-path-unobserved")?;
        if out.contains('%') {
            return Err("machine-path-unobserved".into());
        }
        Ok(out)
    }
    pub fn broadcast() -> Result<()> {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn SendMessageTimeoutW(
                hwnd: *mut std::ffi::c_void,
                msg: u32,
                wparam: usize,
                lparam: isize,
                flags: u32,
                timeout: u32,
                result: *mut usize,
            ) -> isize;
        }
        let environment: Vec<u16> = "Environment".encode_utf16().chain(Some(0)).collect();
        let mut result = 0usize;
        // HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG; bounded per recipient.
        if unsafe {
            SendMessageTimeoutW(
                0xffffusize as *mut _,
                0x001a,
                0,
                environment.as_ptr() as isize,
                0x0002,
                1000,
                &mut result,
            )
        } == 0
        {
            Err("environment-broadcast-failed".into())
        } else {
            Ok(())
        }
    }
}
#[cfg(windows)]
pub fn read_change(c: &Change) -> Result<Option<Vec<u8>>> {
    let found = os::raw()?;
    if let Some(v) = &found {
        if (c.kind == "registry-expand") != (os::type_name(v) == "REG_EXPAND_SZ") {
            return Err("path-type-changed".into());
        }
    }
    Ok(found.map(|v| v.bytes))
}
#[cfg(not(windows))]
pub fn read_change(_: &Change) -> Result<Option<Vec<u8>>> {
    Err("registry-unsupported".into())
}
#[cfg(windows)]
pub fn apply_change(c: &Change) -> Result<()> {
    if read_change(c)? != c.before {
        return Err("concurrent-edit".into());
    }
    os::write(c)
}
#[cfg(not(windows))]
pub fn apply_change(_: &Change) -> Result<()> {
    Err("registry-unsupported".into())
}
#[cfg(windows)]
pub fn plan(
    current: &Record,
    bundle: Bundle,
    remove_owned: bool,
) -> Result<(Record, Vec<Change>, Vec<String>)> {
    let old = os::raw()?;
    let ty = old.as_ref().map(os::type_name).unwrap_or("REG_EXPAND_SZ");
    let raw = old
        .as_ref()
        .map(|v| os::decode(&v.bytes))
        .transpose()?
        .unwrap_or_default();
    let mut next = current.clone();
    let mut issues = Vec::new();
    let result = if remove_owned {
        if let Some(owned) = &current.windows {
            remove(&raw, owned)?
        } else {
            return Ok((next, Vec::new(), issues));
        }
    } else {
        let entry = Path::new(&bundle.cli_executable)
            .parent()
            .and_then(|p| p.to_str())
            .ok_or("path-invalid")?;
        let (s, owned) = replace_owned_entry(&raw, current.windows.as_ref(), entry, ty)?;
        next.bundle = Some(bundle);
        next.windows = Some(owned);
        s
    };
    if remove_owned {
        next.windows = None;
    }
    next.posix = None;
    let after = if old.is_none() && result.is_empty() {
        None
    } else {
        Some(os::encode(&result))
    };
    let before = old.map(|v| v.bytes);
    let changes = if before == after {
        Vec::new()
    } else {
        vec![Change {
            kind: if ty == "REG_EXPAND_SZ" {
                "registry-expand"
            } else {
                "registry-sz"
            }
            .into(),
            path: "HKCU\\Environment\\Path".into(),
            before,
            after,
            mode: 0,
            backup_path: None,
        }]
    };
    if !remove_owned {
        match os::machine_conflict() {
            Ok(true) => issues.push("machine-path-conflict".into()),
            Ok(false) => {}
            Err(e) => issues.push(e),
        }
    }
    Ok((next, changes, issues))
}
#[cfg(windows)]
pub fn notify() -> Result<()> {
    os::broadcast()
}
#[cfg(not(windows))]
pub fn notify() -> Result<()> {
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepend_preserves_raw_expansions_type_and_empty_entries() {
        let raw = r"%APPDATA%\npm;;C:\Tools;";
        for ty in ["REG_SZ", "REG_EXPAND_SZ"] {
            let (out, owned) = prepend(raw, r"C:\Program Files\OpenCodex", ty).unwrap();
            assert_eq!(out, format!(r"C:\Program Files\OpenCodex;{raw}"));
            assert_eq!(owned.value_type, ty);
            assert_eq!(owned.action, "inserted");
            assert_eq!(remove(&out, &owned).unwrap(), raw);
        }
    }
    #[test]
    fn moved_existing_entry_is_restored_and_same_entry_repair_keeps_ownership() {
        let raw = r"A;C:\Desktop;B";
        let (out, owned) = prepend(raw, r"c:/desktop/", "REG_SZ").unwrap();
        assert_eq!(owned.action, "moved-existing");
        let (twice, retained) =
            replace_owned_entry(&out, Some(&owned), r"C:\Desktop", "REG_SZ").unwrap();
        assert_eq!(twice, out);
        assert_eq!(retained, owned);
        assert_eq!(remove(&out, &owned).unwrap(), raw);
    }
    #[test]
    fn removal_preserves_concurrent_unrelated_entries_and_ambiguity() {
        let (out, owned) = prepend(r"A;B", r"C:\Desktop", "REG_EXPAND_SZ").unwrap();
        assert_eq!(remove(&format!("{out};NEW"), &owned).unwrap(), "A;B;NEW");
        let (out, moved) = prepend(r"A;C:\Desktop;B", r"C:\Desktop", "REG_SZ").unwrap();
        assert_eq!(
            remove(&out.replace("A;B", "A;NEW;B"), &moved).unwrap_err(),
            "path-restore-ambiguous"
        );
    }
    #[test]
    fn replacing_owned_entry_removes_only_the_previous_insertion() {
        let (out, old) = prepend("A;B", r"C:\Old", "REG_SZ").unwrap();
        let (new, owned) = replace_owned_entry(&out, Some(&old), r"C:\New", "REG_SZ").unwrap();
        assert_eq!(new, r"C:\New;A;B");
        assert_eq!(remove(&new, &owned).unwrap(), "A;B");
        assert_eq!(remove("A;B", &old).unwrap(), "A;B");
        let (_, moved) = prepend(r"A;C:\Old;B", r"C:\Old", "REG_SZ").unwrap();
        let (repaired, inserted) =
            replace_owned_entry("A;B", Some(&moved), r"C:\Old", "REG_SZ").unwrap();
        assert_eq!(inserted.action, "inserted");
        assert_eq!(remove(&repaired, &inserted).unwrap(), "A;B");
    }
    #[test]
    fn duplicate_invalid_and_oversize_entries_are_refused() {
        assert!(prepend(r"C:\Desktop;c:/desktop/", r"C:\Desktop", "REG_SZ").is_err());
        assert!(prepend("A", "bad;entry", "REG_SZ").is_err());
        assert!(prepend("A", r"C:\Desktop", "REG_BINARY").is_err());
        assert!(prepend(&"X".repeat(32_767), r"C:\Desktop", "REG_SZ").is_err());
    }
}
