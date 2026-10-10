use crate::cli_command_record::{
    self as record, Bundle, Change, OwnedFile, Posix, RcFile, Record, Result, Store,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const START: &str = "# >>> OpenCodex Desktop ocx PATH v1 >>>";
pub const END: &str = "# <<< OpenCodex Desktop ocx PATH v1 <<<";
const SHIM: &str = r#"#!/bin/sh
# OpenCodex Desktop ocx shim v1
# owner-id: @OWNER@
_ocx_cli=@CLI@
if [ ! -f "$_ocx_cli" ] || [ ! -x "$_ocx_cli" ]; then
  printf '%s\n' 'OpenCodex Desktop CLI is unavailable. Repair or remove the terminal command in Desktop.' >&2
  exit 127
fi
unset OCX_NODE_LAUNCH_CONTEXT OCX_PRE_BUN_ANTHROPIC_ENV
_ocx_proof=
if [ -r /dev/urandom ] && [ -x /usr/bin/od ] && [ -x /usr/bin/awk ]; then
  _ocx_proof=$(/usr/bin/od -An -tu1 -N32 /dev/urandom 2>/dev/null | /usr/bin/awk '
    BEGIN { a="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"; n=0; bits=0; count=0; out="" }
    { for (i=1; i<=NF; i++) {
        if ($i !~ /^[0-9]+$/ || $i < 0 || $i > 255) exit 1
        count++; n=n*256+$i; bits+=8
        while (bits>=6) { bits-=6; q=int(n/(2^bits)); out=out substr(a,q+1,1); n=n-q*(2^bits) }
    } }
    END { if (count!=32) exit 1; if (bits) out=out substr(a,n*(2^(6-bits))+1,1); print out }
  ') || _ocx_proof=
fi
case "$_ocx_proof" in
  *[!A-Za-z0-9_-]*) _ocx_proof= ;;
esac
if [ "${#_ocx_proof}" -eq 43 ]; then
  _ocx_slots=
  _ocx_sep=
  if [ -n "${ANTHROPIC_API_KEY-}" ]; then
    _ocx_slots='"ANTHROPIC_API_KEY"'; _ocx_sep=,
  fi
  if [ -n "${ANTHROPIC_AUTH_TOKEN-}" ]; then
    _ocx_slots=$_ocx_slots$_ocx_sep'"ANTHROPIC_AUTH_TOKEN"'; _ocx_sep=,
  fi
  if [ -n "${ANTHROPIC_BASE_URL-}" ]; then
    _ocx_slots=$_ocx_slots$_ocx_sep'"ANTHROPIC_BASE_URL"'
  fi
  OCX_NODE_LAUNCH_CONTEXT='{"version":1,"proof":"'$_ocx_proof'","anthropicEnvSlots":['$_ocx_slots'],"codexCliInspectionEnv":null}'
  export OCX_NODE_LAUNCH_CONTEXT
  exec "$_ocx_cli" "--ocx-internal-launch-proof=$_ocx_proof" "$@"
fi
exec "$_ocx_cli" "$@"
"#;
const HELPER: &str = r#"# OpenCodex Desktop ocx PATH helper v1
_ocx_desktop_path_v1() (
  _ocx_bin=@BIN@
  _ocx_new=$_ocx_bin
  _ocx_rest=${PATH-}
  if [ "${PATH+x}" = x ]; then
    while :; do
      case "$_ocx_rest" in
        *:*) _ocx_part=${_ocx_rest%%:*}; _ocx_rest=${_ocx_rest#*:}; _ocx_last=0 ;;
        *) _ocx_part=$_ocx_rest; _ocx_last=1 ;;
      esac
      if [ "$_ocx_part" != "$_ocx_bin" ]; then _ocx_new=$_ocx_new:$_ocx_part; fi
      [ "$_ocx_last" = 1 ] && break
    done
  fi
  printf '%s' "$_ocx_new"
)
PATH=$(_ocx_desktop_path_v1)
export PATH
unset -f _ocx_desktop_path_v1
"#;
fn text(p: &Path) -> Result<String> {
    let s = p.to_str().ok_or("path-not-utf8")?;
    if !p.is_absolute()
        || p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || s.contains(['\0', '\n', '\r', ':'])
    {
        return Err("path-unrepresentable".into());
    }
    Ok(s.into())
}
fn quote(p: &Path) -> Result<String> {
    Ok(format!("'{}'", text(p)?.replace('\'', "'\"'\"'")))
}
pub fn render_shim(cli: &Path, owner: &str) -> Result<String> {
    // Replace the owner before substituting paths so a literal placeholder in a path stays literal.
    Ok(SHIM
        .replace("@OWNER@", owner)
        .replace("@CLI@", &quote(cli)?))
}
pub fn render_helper(bin: &Path) -> Result<String> {
    Ok(HELPER.replace("@BIN@", &quote(bin)?))
}
pub fn block(shell: &str, root: &Path) -> Result<String> {
    let body = if shell == "fish" {
        format!(
            "if status is-interactive\n    fish_add_path --path --prepend --move {}\nend\n",
            quote(&root.join("bin"))?
        )
    } else {
        let helper = quote(&root.join("path.sh"))?;
        format!("if [ -r {helper} ]; then\n  . {helper}\nfi\n")
    };
    Ok(format!("{START}\n{body}{END}\n"))
}
pub fn targets(home: &Path) -> Result<Vec<(String, PathBuf)>> {
    targets_in(
        home,
        std::env::var_os("ZDOTDIR").map(PathBuf::from),
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
    )
}
fn targets_in(
    home: &Path,
    zdotdir: Option<PathBuf>,
    xdg: Option<PathBuf>,
) -> Result<Vec<(String, PathBuf)>> {
    let z = zdotdir
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.into());
    let fish = xdg
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".config"))
        .join("fish/config.fish");
    let mut out = vec![
        ("zsh".into(), z.join(".zshrc")),
        ("zsh".into(), z.join(".zlogin")),
        ("bash".into(), home.join(".bashrc")),
        ("fish".into(), fish),
    ];
    // Exists, including an unsafe symlink: it is the active candidate and must be refused, not skipped.
    if let Some(p) = [".bash_profile", ".bash_login", ".profile"]
        .into_iter()
        .map(|n| home.join(n))
        .find(|p| fs::symlink_metadata(p).is_ok())
    {
        out.push(("bash".into(), p));
    }
    for (_, p) in &out {
        text(p)?;
    }
    Ok(out)
}
pub fn stable_bundle(exe: &Path, debug: bool, version: &str) -> Result<Bundle> {
    if debug {
        return Err("development-launch".into());
    }
    let raw = text(exe)?;
    if raw.starts_with("/Volumes/")
        || raw.starts_with("/private/var/folders/") && raw.contains("/AppTranslocation/")
        || raw.contains("/tmp/.mount_")
        || std::env::var_os("APPIMAGE").is_some()
        || std::env::var_os("APPDIR").is_some()
    {
        return Err("temporary-bundle".into());
    }
    let real = fs::canonicalize(exe).map_err(|_| "bundle-unavailable")?;
    let s = text(&real)?;
    if s.starts_with("/Volumes/") || s.contains("/AppTranslocation/") || s.contains("/tmp/.mount_")
    {
        return Err("temporary-bundle".into());
    }
    let parent = real.parent().ok_or("unpackaged-launch")?;
    let (platform, kind, cli) = if cfg!(target_os = "macos") {
        if parent.file_name().and_then(|s| s.to_str()) != Some("MacOS")
            || parent
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str())
                != Some("Contents")
            || parent
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.extension())
                .and_then(|s| s.to_str())
                != Some("app")
        {
            return Err("unpackaged-launch".into());
        }
        ("darwin", "macos-app", parent.join("ocx"))
    } else {
        if parent != Path::new("/usr/bin") {
            return Err("unpackaged-launch".into());
        }
        ("linux", "linux-deb", PathBuf::from("/usr/bin/ocx"))
    };
    let m = fs::symlink_metadata(&cli).map_err(|_| "bundle-cli-missing")?;
    if !m.is_file() || m.file_type().is_symlink() {
        return Err("bundle-cli-missing".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if m.permissions().mode() & 0o111 == 0 {
            return Err("bundle-cli-not-executable".into());
        }
    }
    Ok(Bundle {
        platform: platform.into(),
        kind: kind.into(),
        app_executable: s,
        cli_executable: text(&cli)?,
        version: version.into(),
    })
}
// Return exact block range, including its line terminator. Reject malformed or changed markers.
fn range(bytes: &[u8], expected: &str) -> Result<Option<std::ops::Range<usize>>> {
    let s = std::str::from_utf8(bytes).map_err(|_| "rc-not-utf8")?;
    let begins: Vec<_> = s.match_indices(START).map(|(n, _)| n).collect();
    let ends: Vec<_> = s.match_indices(END).map(|(n, _)| n).collect();
    if s.lines().any(|line| {
        (line.contains("OpenCodex Desktop ocx PATH")
            && (line.contains(">>>") || line.contains("<<<")))
            && line != START
            && line != END
    }) {
        return Err("rc-markers-invalid".into());
    }
    if begins.is_empty() && ends.is_empty() {
        return Ok(None);
    }
    if begins.len() != 1
        || ends.len() != 1
        || ends[0] < begins[0]
        || begins[0] > 0 && bytes[begins[0] - 1] != b'\n'
    {
        return Err("rc-markers-invalid".into());
    }
    let finish = ends[0] + END.len();
    let finish = if s[finish..].starts_with("\r\n") {
        finish + 2
    } else if s[finish..].starts_with('\n') {
        finish + 1
    } else if finish == s.len() {
        finish
    } else {
        return Err("rc-markers-invalid".into());
    };
    let candidate = &s[begins[0]..finish];
    if candidate != expected
        && candidate.trim_end_matches(['\r', '\n']) != expected.trim_end_matches(['\r', '\n'])
    {
        return Err("rc-block-modified".into());
    }
    Ok(Some(begins[0]..finish))
}
fn newline(bytes: &[u8]) -> Result<&'static str> {
    let s = std::str::from_utf8(bytes).map_err(|_| "rc-not-utf8")?;
    if s.contains('\r') && (!s.contains("\r\n") || s.replace("\r\n", "").contains(['\r', '\n'])) {
        return Err("rc-mixed-newlines".into());
    }
    Ok(if s.contains("\r\n") { "\r\n" } else { "\n" })
}
pub fn edit_rc(bytes: &[u8], managed: &str, remove: bool) -> Result<Vec<u8>> {
    let nl = newline(bytes)?;
    let expected = managed.replace('\n', nl);
    let found = range(bytes, &expected)?;
    if let Some(r) = &found {
        if !remove && bytes[r.end..].iter().all(u8::is_ascii_whitespace) {
            return Ok(bytes.to_vec());
        }
    }
    let mut out = bytes.to_vec();
    if let Some(r) = found {
        out.drain(r);
    }
    if remove {
        return Ok(out);
    }
    // Outside bytes and trailing whitespace stay in the same order; block is last nonblank content.
    if !out.is_empty() && !out.ends_with(b"\n") {
        out.extend_from_slice(nl.as_bytes());
    }
    out.extend_from_slice(expected.as_bytes());
    Ok(out)
}
fn mode(path: &Path) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o777)
            .unwrap_or(0o600)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        0o600
    }
}
fn change(
    store: &Store,
    p: &Path,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
    mode: u32,
) -> Change {
    let backup = before.as_ref().map(|_| {
        store
            .root
            .join("backups")
            .join(uuid::Uuid::new_v4().to_string())
            .to_string_lossy()
            .into_owned()
    });
    Change {
        kind: "file".into(),
        path: p.to_string_lossy().into_owned(),
        before,
        after,
        mode,
        backup_path: backup,
    }
}
fn ensure_rc_parent(p: &Path, home: &Path) -> Result<()> {
    let parent = p.parent().ok_or("unsafe-file")?;
    if parent == home.join(".config/fish") {
        for directory in [home.join(".config"), home.join(".config/fish")] {
            match fs::symlink_metadata(&directory) {
                Ok(_) => record::check(&directory, true)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    record::private_dir(&directory)?
                }
                Err(_) => return Err("io-failed".into()),
            }
        }
    }
    record::check(parent, true)
}
pub(crate) fn plan(
    store: &Store,
    current: &Record,
    bundle: Bundle,
    home: &Path,
    selected: Vec<(String, PathBuf)>,
) -> Result<(Record, Vec<Change>, Vec<String>)> {
    let mut next = current.clone();
    next.bundle = Some(bundle.clone());
    let mut changes = Vec::new();
    let mut issues = Vec::new();
    let mut owned = Posix {
        bin_directory: text(&store.root.join("bin"))?,
        files: Vec::new(),
        rc_files: Vec::new(),
    };
    for (kind, p, rendered, permissions) in [
        (
            "shim",
            store.root.join("bin/ocx"),
            render_shim(Path::new(&bundle.cli_executable), &current.owner_id)?,
            0o700,
        ),
        (
            "path-helper",
            store.root.join("path.sh"),
            render_helper(&store.root.join("bin"))?,
            0o600,
        ),
    ] {
        let old = record::read_bytes(&p)?;
        let previous = current
            .posix
            .as_ref()
            .and_then(|v| v.files.iter().find(|f| f.path == p.to_string_lossy()));
        if let Some(b) = &old {
            if previous.is_none_or(|f| record::hash(b) != f.sha256) {
                return Err("owned-file-conflict".into());
            }
            if mode(&p) != permissions {
                return Err("owned-file-permissions".into());
            }
        }
        if old.as_deref() != Some(rendered.as_bytes()) {
            changes.push(change(
                store,
                &p,
                old.clone(),
                Some(rendered.as_bytes().to_vec()),
                permissions,
            ));
        }
        owned.files.push(OwnedFile {
            kind: kind.into(),
            path: text(&p)?,
            sha256: record::hash(rendered.as_bytes()),
            created: previous.map_or(old.is_none(), |f| f.created),
        });
    }
    if selected.iter().filter(|(s, _)| s == "bash").count() == 1 {
        issues.push("login-file-absent".into());
    }
    for (shell, p) in &selected {
        // Never create an arbitrary external ZDOTDIR/XDG directory tree; absent parents are reported.
        let attempt: Result<RcFile> = (|| {
            ensure_rc_parent(p, home)?;
            record::rc_acl_check(p)?;
            let old = record::read_bytes(p)?;
            let previous = current
                .posix
                .as_ref()
                .and_then(|v| v.rc_files.iter().find(|f| f.path == p.to_string_lossy()));
            let managed = block(shell, &store.root)?;
            let nl = newline(old.as_deref().unwrap_or_default())?;
            let rendered = managed.replace('\n', nl);
            let found = range(old.as_deref().unwrap_or_default(), &rendered).map_err(|e| {
                if previous.is_some() && e == "rc-block-modified" {
                    "owned-block-modified".into()
                } else {
                    e
                }
            })?;
            if found.is_some()
                && previous.is_none_or(|f| f.block_sha256 != record::hash(rendered.as_bytes()))
            {
                return Err(if previous.is_some() {
                    "owned-block-modified"
                } else {
                    "rc-block-unowned"
                }
                .into());
            }
            let after = edit_rc(old.as_deref().unwrap_or_default(), &managed, false)?;
            let mut backup = previous.and_then(|f| f.backup_path.clone());
            if old.as_deref() != Some(after.as_slice()) {
                record::rc_acl_check(p)?;
                let c = change(store, p, old.clone(), Some(after), mode(p));
                if backup.is_none() {
                    backup = c.backup_path.clone();
                }
                changes.push(c);
            }
            Ok(RcFile {
                shell: shell.clone(),
                path: text(p)?,
                block_sha256: record::hash(rendered.as_bytes()),
                created: previous.map_or(old.is_none(), |f| f.created),
                backup_path: backup,
                result: "installed".into(),
            })
        })();
        match attempt {
            Ok(f) => owned.rc_files.push(f),
            Err(e) => {
                issues.push(e);
                // Retain old ownership so a refused file stays recoverable/removable after user repair.
                if let Some(f) = current
                    .posix
                    .as_ref()
                    .and_then(|v| v.rc_files.iter().find(|f| f.path == p.to_string_lossy()))
                {
                    owned.rc_files.push(f.clone());
                }
            }
        }
    }
    // Ownership is independent of today's ZDOTDIR, XDG_CONFIG_HOME and bash login choice.
    if let Some(previous) = &current.posix {
        for f in &previous.rc_files {
            if selected.iter().any(|(_, p)| p == Path::new(&f.path)) {
                continue;
            }
            if let Err(e) = remove_rc(store, f, &mut changes) {
                issues.push(e);
                owned.rc_files.push(f.clone());
            }
        }
    }
    next.posix = Some(owned);
    next.windows = None;
    Ok((next, changes, issues))
}
fn remove_rc(store: &Store, f: &RcFile, changes: &mut Vec<Change>) -> Result<()> {
    let p = Path::new(&f.path);
    record::rc_acl_check(p)?;
    let Some(old) = record::read_bytes(p)? else {
        return Ok(());
    };
    let managed = block(&f.shell, &store.root)?;
    let expected = managed.replace('\n', newline(&old)?);
    let found = range(&old, &expected).map_err(|e| {
        if e == "rc-block-modified" {
            "owned-block-modified".into()
        } else {
            e
        }
    })?;
    if let Some(r) = found {
        if record::hash(&old[r]) != f.block_sha256 {
            return Err("owned-block-modified".into());
        }
    } else {
        return Ok(());
    }
    let after = edit_rc(&old, &managed, true)?;
    let result = if f.created && after.iter().all(u8::is_ascii_whitespace) {
        None
    } else {
        Some(after)
    };
    if result.as_deref() != Some(old.as_slice()) {
        record::rc_acl_check(p)?;
        changes.push(change(store, p, Some(old), result, mode(p)));
    }
    Ok(())
}
pub fn remove_plan(store: &Store, current: &Record) -> Result<(Record, Vec<Change>, Vec<String>)> {
    let mut next = current.clone();
    let mut changes = Vec::new();
    let mut issues = Vec::new();
    let Some(mut owned) = current.posix.clone() else {
        return Ok((next, changes, issues));
    };
    owned.rc_files.retain(|f| {
        let attempt = remove_rc(store, f, &mut changes);
        if let Err(e) = attempt {
            issues.push(e);
            true
        } else {
            false
        }
    });
    // If a refused rc still references helper/bin, keep both until repair/removal can finish.
    if owned.rc_files.is_empty() {
        owned.files.retain(|f| {
            let attempt: Result<()> = (|| {
                let p = Path::new(&f.path);
                let Some(old) = record::read_bytes(p)? else {
                    return Ok(());
                };
                if record::hash(&old) != f.sha256 {
                    return Err("owned-file-conflict".into());
                }
                if mode(p) != if f.kind == "shim" { 0o700 } else { 0o600 } {
                    return Err("owned-file-permissions".into());
                }
                changes.push(change(store, p, Some(old), None, mode(p)));
                Ok(())
            })();
            if let Err(e) = attempt {
                issues.push(e);
                true
            } else {
                false
            }
        });
    }
    next.posix = (!owned.files.is_empty() || !owned.rc_files.is_empty()).then_some(owned);
    Ok((next, changes, issues))
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use record::tests::{bundle, Temp};
    #[cfg(target_os = "macos")]
    fn rc_acl(path: &Path, add: bool) {
        let mut command = std::process::Command::new("/bin/chmod");
        if add {
            command.args(["+a", "nobody deny read"]);
        } else {
            command.arg("-N");
        }
        assert!(
            command
                .arg(path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success(),
            "acl-command-failed"
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn rc_acl_refuses_install_reposition_remove_and_keeps_owned_artifacts() {
        let t = Temp::new();
        let s = t.store();
        let p = t.0.join(".zshrc");
        record::atomic(&p, None, b"# user\n", 0o600).unwrap();
        rc_acl(&p, true);
        let mut r = Record::fresh(bundle());
        let selected = vec![("zsh".into(), p.clone())];
        let (next, changes, issues) = plan(&s, &r, bundle(), &t.0, selected.clone()).unwrap();
        assert_eq!(issues, ["rc-acl-present"]);
        assert!(changes.iter().all(|c| c.path != p.to_string_lossy()));
        assert_eq!(fs::read(&p).unwrap(), b"# user\n");
        assert!(record::rc_acl_check(&p).is_err());
        s.transact(&mut r, next, changes, "install").unwrap();
        rc_acl(&p, false);
        let (next, changes, _) = plan(&s, &r, bundle(), &t.0, selected.clone()).unwrap();
        s.transact(&mut r, next, changes, "install").unwrap();
        let mut bytes = fs::read(&p).unwrap();
        bytes.extend_from_slice(b"# later\n");
        fs::write(&p, &bytes).unwrap();
        rc_acl(&p, true);
        let (next, changes, issues) = plan(&s, &r, bundle(), &t.0, selected).unwrap();
        assert_eq!(issues, ["rc-acl-present"]);
        assert!(changes.is_empty());
        assert_eq!(next.posix.as_ref().unwrap().rc_files.len(), 1);
        r.enabled = false;
        s.save(&r).unwrap();
        let (next, changes, issues) = remove_plan(&s, &r).unwrap();
        assert_eq!(issues, ["rc-acl-present"]);
        assert!(changes.is_empty());
        s.transact(&mut r, next, changes, "remove").unwrap();
        assert!(r.posix.as_ref().unwrap().rc_files.len() == 1);
        assert!(s.root.join("bin/ocx").is_file());
        assert!(s.root.join("path.sh").is_file());
        assert!(fs::read(&p).unwrap() == bytes);
        assert!(record::rc_acl_check(&p).is_err());
        rc_acl(&p, false);
        let (next, changes, issues) = remove_plan(&s, &r).unwrap();
        assert!(issues.is_empty());
        s.transact(&mut r, next, changes, "remove").unwrap();
        assert_eq!(fs::read(p).unwrap(), b"# user\n# later\n");
        assert!(r.posix.is_none());
    }
    fn root() -> PathBuf {
        fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ocx-posix-{}", uuid::Uuid::new_v4()))
    }
    #[test]
    fn rc_edit_is_idempotent_and_repositions_after_later_npm_prepend() {
        let t = root();
        record::private_dir(&t).unwrap();
        let p = t.join(".zshrc");
        let b = block("zsh", &t).unwrap();
        let first = edit_rc(b"export PATH=/npm:$PATH\n", &b, false).unwrap();
        record::atomic(&p, None, &first, 0o600).unwrap();
        assert_eq!(edit_rc(&first, &b, false).unwrap(), first);
        let later = [first.as_slice(), b"export PATH=/later:$PATH\n"].concat();
        let repaired = edit_rc(&later, &b, false).unwrap();
        assert!(repaired.ends_with(b.as_bytes()));
        assert_eq!(
            edit_rc(&repaired, &b, true).unwrap(),
            b"export PATH=/npm:$PATH\nexport PATH=/later:$PATH\n"
        );
        fs::remove_dir_all(t).unwrap();
    }
    #[test]
    fn broken_duplicate_nested_or_modified_blocks_are_refused() {
        let b = block("bash", Path::new("/example/record")).unwrap();
        for bytes in [
            START.to_owned(),
            END.to_owned(),
            format!("{b}{b}"),
            format!("{START}\n{START}\n{END}\n{END}\n"),
            b.replace("if [ -r", "if [ -w"),
        ] {
            assert!(edit_rc(bytes.as_bytes(), &b, false).is_err());
            assert!(edit_rc(bytes.as_bytes(), &b, true).is_err());
        }
    }
    #[test]
    fn rc_newlines_and_outside_bytes_survive_removal() {
        let b = block("zsh", Path::new("/example/record")).unwrap();
        let original = b"# user's config\r\nexport PATH=\"/npm:$PATH\"\r\n";
        let installed = edit_rc(original, &b, false).unwrap();
        assert_eq!(edit_rc(&installed, &b, true).unwrap(), original);
        assert!(edit_rc(b"a\r\nb\n", &b, false).is_err());
        assert!(edit_rc(&[0xff], &b, false).is_err());
    }
    #[test]
    fn quoting_and_invalid_path_contract_is_exact() {
        assert_eq!(
            quote(Path::new("/example/a'b")).unwrap(),
            "'/example/a'\"'\"'b'"
        );
        for s in ["relative", "/example/a:b", "/example/a\nb"] {
            assert!(quote(Path::new(s)).is_err());
        }
    }
    #[test]
    fn development_and_temporary_launches_are_refused_before_installation() {
        assert_eq!(
            stable_bundle(Path::new("/example/app"), true, "1").unwrap_err(),
            "development-launch"
        );
        for p in [
            "/Volumes/DMG/App.app/Contents/MacOS/app",
            "/private/var/folders/a/AppTranslocation/b/App.app/Contents/MacOS/app",
            "/tmp/.mount_example/usr/bin/app",
        ] {
            assert_eq!(
                stable_bundle(Path::new(p), false, "1").unwrap_err(),
                "temporary-bundle"
            );
        }
    }
    #[test]
    fn owned_and_desired_rc_paths_reconcile_without_losing_modified_ownership() {
        let t = Temp::new();
        let old = t.0.join("old");
        let new = t.0.join("new");
        record::private_dir(&old).unwrap();
        record::private_dir(&new).unwrap();
        let s = Store::open(t.0.join("record"), vec![new.join(".zshrc")]).unwrap();
        let mut r = Record::fresh(bundle());
        let (next, changes, issues) = plan(
            &s,
            &r,
            bundle(),
            &t.0,
            vec![("zsh".into(), old.join(".zshrc"))],
        )
        .unwrap();
        assert!(issues.is_empty());
        s.transact(&mut r, next, changes, "install").unwrap();
        let old_rc = old.join(".zshrc");
        fs::write(
            &old_rc,
            fs::read_to_string(&old_rc)
                .unwrap()
                .replace("if [ -r", "if [ -w"),
        )
        .unwrap();
        let modified = fs::read(&old_rc).unwrap();
        let (next, changes, issues) = plan(
            &s,
            &r,
            bundle(),
            &t.0,
            vec![("zsh".into(), new.join(".zshrc"))],
        )
        .unwrap();
        assert_eq!(issues, ["owned-block-modified"]);
        assert_eq!(next.posix.as_ref().unwrap().rc_files.len(), 2);
        s.transact(&mut r, next, changes, "install").unwrap();
        assert_eq!(fs::read(&old_rc).unwrap(), modified);
        // Repair the old block, then retire it although today's target selector no longer lists it.
        fs::write(&old_rc, block("zsh", &s.root).unwrap()).unwrap();
        let (next, changes, issues) = plan(
            &s,
            &r,
            bundle(),
            &t.0,
            vec![("zsh".into(), new.join(".zshrc"))],
        )
        .unwrap();
        assert!(issues.is_empty());
        s.transact(&mut r, next, changes, "install").unwrap();
        assert!(!old_rc.exists());
        assert_eq!(r.posix.as_ref().unwrap().rc_files.len(), 1);
    }
    #[test]
    fn modified_rc_keeps_helper_until_cleanup_and_preserves_user_content() {
        let t = Temp::new();
        let s = t.store();
        let p = t.0.join(".zshrc");
        record::atomic(&p, None, b"# user\n", 0o600).unwrap();
        let mut r = Record::fresh(bundle());
        let (next, changes, _) =
            plan(&s, &r, bundle(), &t.0, vec![("zsh".into(), p.clone())]).unwrap();
        s.transact(&mut r, next, changes, "install").unwrap();
        fs::write(
            &p,
            fs::read_to_string(&p)
                .unwrap()
                .replace("if [ -r", "if [ -w"),
        )
        .unwrap();
        let (_, changes, issues) = remove_plan(&s, &r).unwrap();
        assert_eq!(issues, ["owned-block-modified"]);
        assert!(changes.is_empty());
        assert!(s.root.join("path.sh").exists());
        fs::write(
            &p,
            format!("# user\n{}# later\n", block("zsh", &s.root).unwrap()),
        )
        .unwrap();
        r.enabled = false;
        s.save(&r).unwrap();
        let (next, changes, issues) = remove_plan(&s, &r).unwrap();
        assert!(issues.is_empty());
        s.transact(&mut r, next, changes, "remove").unwrap();
        assert_eq!(fs::read(p).unwrap(), b"# user\n# later\n");
        assert!(!s.root.join("path.sh").exists());
        assert!(r.posix.is_none());
    }
    #[test]
    fn unrecorded_block_and_generated_file_are_not_adopted() {
        let t = Temp::new();
        let s = t.store();
        let p = t.0.join(".zshrc");
        let r = Record::fresh(bundle());
        record::atomic(&p, None, block("zsh", &s.root).unwrap().as_bytes(), 0o600).unwrap();
        let (next, _, issues) = plan(&s, &r, bundle(), &t.0, vec![("zsh".into(), p)]).unwrap();
        assert_eq!(issues, ["rc-block-unowned"]);
        assert!(next.posix.unwrap().rc_files.is_empty());
        record::atomic(&s.root.join("bin/ocx"), None, b"user", 0o700).unwrap();
        assert_eq!(
            plan(&s, &r, bundle(), &t.0, vec![]).unwrap_err(),
            "owned-file-conflict"
        );
    }
    #[test]
    fn zdotdir_xdg_and_bash_login_selection_are_injected() {
        let t = Temp::new();
        let chosen = targets_in(&t.0, Some(t.0.join("zdot")), Some(t.0.join("xdg"))).unwrap();
        assert_eq!(chosen[0].1, t.0.join("zdot/.zshrc"));
        assert_eq!(chosen[3].1, t.0.join("xdg/fish/config.fish"));
        assert_eq!(chosen.len(), 4);
        record::atomic(&t.0.join(".profile"), None, b"# fallback", 0o600).unwrap();
        record::atomic(&t.0.join(".bash_login"), None, b"# active", 0o600).unwrap();
        let chosen = targets_in(&t.0, Some("relative".into()), None).unwrap();
        assert_eq!(chosen[0].1, t.0.join(".zshrc"));
        assert_eq!(chosen[4].1, t.0.join(".bash_login"));
    }
    #[test]
    fn path_helper_preserves_empty_entries_and_prepends_once() {
        let bin = Path::new("/example/desktop/bin");
        let helper = render_helper(bin).unwrap();
        for (path, expected) in [
            (None, "/example/desktop/bin"),
            (Some(""), "/example/desktop/bin:"),
            (
                Some(":/npm::/example/desktop/bin:/other:"),
                "/example/desktop/bin::/npm::/other:",
            ),
        ] {
            let mut command = std::process::Command::new("/bin/sh");
            let unset = if path.is_none() { "unset PATH\n" } else { "" };
            command
                .env_clear()
                .arg("-c")
                .arg(format!("{unset}{helper}\nprintf '%s' \"$PATH\""));
            if let Some(path) = path {
                command.env("PATH", path);
            }
            let output = command.output().unwrap();
            assert!(output.status.success());
            assert_eq!(String::from_utf8(output.stdout).unwrap(), expected);
        }
    }
    #[test]
    fn shim_generates_argv_bound_proof_and_fails_closed_when_bundle_is_missing() {
        let t = Temp::new();
        let cli = t.0.join("cli");
        let shim = t.0.join("shim");
        let inspect = b"#!/bin/sh\nprintf '%s\\n' \"$OCX_NODE_LAUNCH_CONTEXT\" \"$@\"\n";
        record::atomic(&cli, None, inspect, 0o700).unwrap();
        record::atomic(
            &shim,
            None,
            render_shim(&cli, "owner").unwrap().as_bytes(),
            0o700,
        )
        .unwrap();
        let out = std::process::Command::new(&shim)
            .env_clear()
            .env("ANTHROPIC_AUTH_TOKEN", "dummy")
            .env("ANTHROPIC_API_KEY", "")
            .env("OCX_NODE_LAUNCH_CONTEXT", "untrusted")
            .arg("status")
            .output()
            .unwrap();
        assert!(out.status.success());
        let text = String::from_utf8(out.stdout).unwrap();
        let lines: Vec<_> = text.lines().collect();
        let context: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        let proof = context["proof"].as_str().unwrap();
        assert_eq!(proof.len(), 43);
        assert_eq!(lines[1], format!("--ocx-internal-launch-proof={proof}"));
        assert_eq!(
            context["anthropicEnvSlots"],
            serde_json::json!(["ANTHROPIC_AUTH_TOKEN"])
        );
        assert!(context["codexCliInspectionEnv"].is_null());
        assert!(!text.contains("dummy"));
        fs::remove_file(cli).unwrap();
        assert_eq!(
            std::process::Command::new(&shim)
                .env_clear()
                .output()
                .unwrap()
                .status
                .code(),
            Some(127)
        );
        // Exercise unavailable/malformed utility fallback without changing the machine's utilities.
        for rendered in [
            render_shim(&t.0.join("cli"), "owner")
                .unwrap()
                .replace("/usr/bin/od", "/no-such-od"),
            render_shim(&t.0.join("cli"), "owner")
                .unwrap()
                .replace("/usr/bin/awk", "/no-such-awk"),
            render_shim(&t.0.join("cli"), "owner")
                .unwrap()
                .replace("/dev/urandom", "/no-such-urandom"),
            render_shim(&t.0.join("cli"), "owner")
                .unwrap()
                .replace("-N32", "-N1"),
        ] {
            record::atomic(&t.0.join("cli"), None, inspect, 0o700).unwrap();
            fs::write(&shim, rendered).unwrap();
            let out = std::process::Command::new(&shim)
                .env_clear()
                .env("OCX_NODE_LAUNCH_CONTEXT", "inherited")
                .arg("status")
                .output()
                .unwrap();
            assert!(out.status.success());
            assert_eq!(out.stdout, b"\nstatus\n");
            fs::remove_file(t.0.join("cli")).unwrap();
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn stable_macos_bundle_requires_an_executable_sibling_and_checks_canonical_location() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let t = Temp::new();
        let app = t.0.join("App.app/Contents/MacOS");
        fs::create_dir_all(&app).unwrap();
        let exe = app.join("app");
        let cli = app.join("ocx");
        record::atomic(&exe, None, b"app", 0o700).unwrap();
        assert_eq!(
            stable_bundle(&exe, false, "1").unwrap_err(),
            "bundle-cli-missing"
        );
        record::atomic(&cli, None, b"cli", 0o600).unwrap();
        assert_eq!(
            stable_bundle(&exe, false, "1").unwrap_err(),
            "bundle-cli-not-executable"
        );
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            stable_bundle(&exe, false, "1").unwrap().cli_executable,
            cli.to_str().unwrap()
        );
        let translocated = t.0.join("AppTranslocation");
        record::private_dir(&translocated).unwrap();
        fs::rename(t.0.join("App.app"), translocated.join("App.app")).unwrap();
        symlink(translocated.join("App.app"), t.0.join("App.app")).unwrap();
        assert_eq!(
            stable_bundle(&exe, false, "1").unwrap_err(),
            "temporary-bundle"
        );
    }
    #[test]
    fn missing_external_rc_parent_is_partial_and_default_fish_parents_are_created() {
        let t = Temp::new();
        let s = t.store();
        let r = Record::fresh(bundle());
        let external = t.0.join("missing/config.fish");
        let (_, _, issues) = plan(&s, &r, bundle(), &t.0, vec![("fish".into(), external)]).unwrap();
        assert!(!issues.is_empty() && !t.0.join("missing").exists());
        let (next, changes, issues) = plan(
            &s,
            &r,
            bundle(),
            &t.0,
            vec![("fish".into(), t.0.join(".config/fish/config.fish"))],
        )
        .unwrap();
        assert!(issues.is_empty());
        let mut r = r;
        s.transact(&mut r, next, changes, "install").unwrap();
        assert!(t.0.join(".config/fish/config.fish").exists());
    }
    #[test]
    #[ignore = "explicit wp3 compiled CLI target/output paths only"]
    fn render_shim_for_compiled_cli() {
        let cli = PathBuf::from(std::env::var_os("OCX_TEST_SHIM_TARGET").expect("target required"));
        let output =
            PathBuf::from(std::env::var_os("OCX_TEST_SHIM_OUTPUT").expect("output required"));
        record::atomic(
            &output,
            None,
            render_shim(&cli, "test-owner").unwrap().as_bytes(),
            0o700,
        )
        .unwrap();
    }
    #[test]
    #[ignore = "explicit real-shell evidence using an isolated temporary HOME"]
    fn real_shell_selects_desktop_shim_on_temp_home() {
        use std::{io::Write, process::Command};

        let t = Temp::new();
        let npm = t.0.join("npm-bin");
        record::private_dir(&npm).unwrap();
        record::atomic(&npm.join("ocx"), None, b"#!/bin/sh\necho npm-ocx\n", 0o700).unwrap();
        let app = if cfg!(target_os = "macos") {
            t.0.join("Applications/OpenCodex.app/Contents/MacOS")
        } else {
            t.0.join("usr/bin")
        };
        fs::create_dir_all(&app).unwrap();
        let exe = app.join("OpenCodex");
        let cli = app.join("ocx");
        record::atomic(&exe, None, b"#!/bin/sh\nexit 0\n", 0o700).unwrap();
        // The real CLI consumes the shim's private proof argument before dispatch.
        record::atomic(
            &cli,
            None,
            b"#!/bin/sh\ncase ${1-} in --ocx-internal-launch-proof=*) shift ;; esac\necho desktop-ocx \"$@\"\n",
            0o700,
        )
        .unwrap();
        #[cfg(target_os = "macos")]
        let installed_bundle = stable_bundle(&exe, false, "1").unwrap();
        #[cfg(not(target_os = "macos"))]
        let installed_bundle = Bundle {
            app_executable: text(&exe).unwrap(),
            cli_executable: text(&cli).unwrap(),
            ..bundle()
        };

        let prepend = format!("export PATH=\"{}:$PATH\"\n", npm.display());
        let bash_profile = format!("{prepend}. \"$HOME/.bashrc\"\n");
        for (name, contents) in [
            (".zshrc", prepend.as_str()),
            (".bashrc", prepend.as_str()),
            (".bash_profile", bash_profile.as_str()),
        ] {
            record::atomic(&t.0.join(name), None, contents.as_bytes(), 0o600).unwrap();
        }
        // Inject selectors instead of consulting the developer's ZDOTDIR/XDG settings.
        let selected = targets_in(&t.0, None, None).unwrap();
        let s = Store::open(
            t.0.join("record"),
            selected.iter().map(|(_, path)| path.clone()).collect(),
        )
        .unwrap();
        let mut r = Record::fresh(installed_bundle.clone());
        let shim = s.root.join("bin/ocx");
        let shells: Vec<_> = ["zsh", "bash"]
            .into_iter()
            .filter_map(|shell| {
                let executable = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
                    .into_iter()
                    .map(|directory| Path::new(directory).join(shell))
                    .find(|path| path.is_file());
                if executable.is_none() {
                    eprintln!("{shell}: skipped (shell unavailable)");
                }
                executable.map(|executable| (shell, executable))
            })
            .collect();
        let check_shells = |expected_path: &Path, expected_output: &str| {
            for (shell, executable) in &shells {
                let mut command = Command::new(executable);
                command
                    .env_clear()
                    .env("HOME", &t.0)
                    .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                    .env("TERM", "dumb")
                    .current_dir(&t.0);
                if *shell == "bash" {
                    command.arg("-l");
                }
                // System rc files may print to stdout (Ubuntu's /etc/bash.bashrc sudo hint), so only
                // the marked result lines count; a failed lookup or CLI run still fails the shell, and
                // the end marker makes any extra CLI output line fail the comparison.
                let output = command
                    .args([
                        "-i",
                        "-c",
                        "p=$(command -v ocx) || exit 11; o=$(ocx hello) || exit 12; \
                         printf 'OCX-PATH:%s\\nOCX-OUT:%s:OCX-END\\n' \"$p\" \"$o\"",
                    ])
                    .output()
                    .expect("cannot start real shell");
                assert!(output.status.success(), "{shell}: command failed");
                let stdout = String::from_utf8(output.stdout).expect("shell stdout is not UTF-8");
                let marked = |tag: &str| {
                    stdout
                        .lines()
                        .filter_map(|line| line.strip_prefix(tag))
                        .collect::<Vec<_>>()
                };
                let (paths, outputs) = (marked("OCX-PATH:"), marked("OCX-OUT:"));
                // Keep captured system-rc output and temporary HOME paths out of failure logs.
                assert!(
                    paths.len() == 1 && outputs.len() == 1,
                    "{shell}: expected exactly one marked path and one marked output line"
                );
                assert!(
                    paths[0] == expected_path.to_str().unwrap(),
                    "{shell}: command resolution selected the wrong executable"
                );
                assert!(
                    outputs[0] == format!("{expected_output}:OCX-END"),
                    "{shell}: wrong CLI output"
                );
            }
        };
        check_shells(&npm.join("ocx"), "npm-ocx");
        for reconcile in [false, true] {
            if reconcile {
                for name in [".zshrc", ".bashrc"] {
                    let p = t.0.join(name);
                    assert!(fs::read_to_string(&p)
                        .unwrap()
                        .ends_with(&format!("{END}\n")));
                    fs::OpenOptions::new()
                        .append(true)
                        .open(&p)
                        .unwrap()
                        .write_all(prepend.as_bytes())
                        .unwrap();
                    assert!(fs::read_to_string(&p).unwrap().ends_with(&prepend));
                }
            }
            let (next, changes, issues) =
                plan(&s, &r, installed_bundle.clone(), &t.0, selected.clone()).unwrap();
            assert!(issues.is_empty(), "installation reported issues");
            s.transact(&mut r, next, changes, "install").unwrap();
            assert!(shim.is_file() && s.root.join("path.sh").is_file());
            for name in [".zshrc", ".bashrc", ".bash_profile"] {
                let contents = fs::read_to_string(t.0.join(name)).unwrap();
                assert!(contents.ends_with(&format!("{END}\n")));
                assert_eq!(contents.matches(START).count(), 1);
            }
            check_shells(&shim, "desktop-ocx hello");
        }
        r.enabled = false;
        s.save(&r).unwrap();
        let (next, changes, issues) = remove_plan(&s, &r).unwrap();
        assert!(issues.is_empty(), "removal reported issues");
        s.transact(&mut r, next, changes, "remove").unwrap();
        assert!(r.posix.is_none());
        assert!(!shim.exists() && !s.root.join("path.sh").exists());
        for (name, expected) in [
            (".zshrc", prepend.repeat(2)),
            (".bashrc", prepend.repeat(2)),
            (".bash_profile", bash_profile),
        ] {
            assert!(
                fs::read_to_string(t.0.join(name)).unwrap() == expected,
                "user rc contents were changed during removal"
            );
        }
        check_shells(&npm.join("ocx"), "npm-ocx");
    }
}
