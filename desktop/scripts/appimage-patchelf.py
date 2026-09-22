#!/usr/bin/env python3
"""Keep the compiled Bun sidecar intact while linuxdeploy patches the host/libs."""
import os
from pathlib import Path
import sys


def main(args):
    root = Path(__file__).resolve().parents[2]
    triple = "x86_64-unknown-linux-gnu"
    original = root / "desktop/src-tauri/binaries" / f"ocx-{triple}"
    sidecar = root / "desktop/src-tauri/target" / triple / "release/bundle/appimage/OpenCodex.AppDir/usr/bin/ocx"
    if len(args) == 3 and args[:2] == ["--set-rpath", "$ORIGIN/../lib"] and Path(args[2]).resolve() == sidecar.resolve():
        # linuxdeploy's nested GTK pass runs ldd again after patching. Its
        # patchelf rewrite breaks the compiled Bun ELF. This sidecar depends
        # only on host glibc libraries; it needs no AppDir library search path.
        # Never bless an already-modified binary or a different executable.
        if sidecar.is_symlink() or original.read_bytes() != sidecar.read_bytes():
            raise RuntimeError("AppImage sidecar differs from the prepared CLI")
        print("Preserving compiled ocx bytes (no AppDir RPATH required)", file=sys.stderr)
        return
    os.execv("/usr/bin/patchelf", ["/usr/bin/patchelf", *args])


if __name__ == "__main__":
    main(sys.argv[1:])
