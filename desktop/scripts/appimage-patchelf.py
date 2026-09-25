#!/usr/bin/env python3
"""Keep the compiled Bun sidecar intact while linuxdeploy patches the host/libs."""
import os
from pathlib import Path
import sys


APPDIR_SIDECAR_TAIL = (
    "release",
    "bundle",
    "appimage",
    "OpenCodex.AppDir",
    "usr",
    "bin",
    "ocx",
)


def prepared_sidecar(root, candidate, target_root):
    """Return the one prepared Linux CLI that the AppDir sidecar exactly mirrors."""
    try:
        relative = candidate.resolve().relative_to(target_root.resolve())
    except ValueError:
        return None
    if tuple(relative.parts[-len(APPDIR_SIDECAR_TAIL):]) != APPDIR_SIDECAR_TAIL:
        return None
    prefix = relative.parts[:-len(APPDIR_SIDECAR_TAIL)]
    if len(prefix) > 1:
        return None

    binaries = root / "desktop/src-tauri/binaries"
    candidates = sorted(path for path in binaries.glob("ocx-*-linux-gnu") if path.is_file())
    if prefix:
        candidates = [path for path in candidates if path.name == f"ocx-{prefix[0]}"]
    matches = [path for path in candidates if path.read_bytes() == candidate.read_bytes()]
    return matches[0] if len(matches) == 1 else None


def main(args):
    root = Path(__file__).resolve().parents[2]
    target_root = Path(os.environ.get("CARGO_TARGET_DIR", root / "desktop/src-tauri/target"))
    sidecar = Path(args[2]) if len(args) == 3 else None
    if (
        sidecar is not None
        and args[:2] == ["--set-rpath", "$ORIGIN/../lib"]
        and prepared_sidecar(root, sidecar, target_root) is not None
    ):
        # linuxdeploy's nested GTK pass runs ldd again after patching. Its
        # patchelf rewrite breaks the compiled Bun ELF. This sidecar depends
        # only on host glibc libraries; it needs no AppDir library search path.
        # Never bless an already-modified binary or a different executable.
        if sidecar.is_symlink():
            raise RuntimeError("AppImage sidecar differs from the prepared CLI")
        print("Preserving compiled ocx bytes (no AppDir RPATH required)", file=sys.stderr)
        return
    os.execv("/usr/bin/patchelf", ["/usr/bin/patchelf", *args])


if __name__ == "__main__":
    main(sys.argv[1:])
