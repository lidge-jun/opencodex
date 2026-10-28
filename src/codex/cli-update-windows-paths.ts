/** Archive names only, never filesystem resolution or installation authority. */
export const WINDOWS_CODEX_NATIVE_MEMBER = "vendor/x86_64-pc-windows-msvc/bin/codex.exe";
export const WINDOWS_CODEX_HEADER_BYTES = 4096;

/** ASCII is the supported archive namespace. Refuse unknown Windows case folding. */
export function windowsArchivePathValidator(): (name: string, directory: boolean) => void {
  const seen = new Map<string, { spelling: string; directory: boolean; explicit: boolean }>();
  return (name, directory) => {
    const relative = directory && name.endsWith("/") ? name.slice(0, -1) : name;
    const parts = relative.split("/");
    if (relative.length > 8192 || parts.length > 64 || parts.some(part => !part || part === "." || part === ".."
      || /[^\x20-\x7e]|[<>:"\\|?*]/.test(part) || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)|^(?:conin\$|conout\$)$/i.test(part))) {
      throw new Error("artifact_windows_path_unverified");
    }
    for (let i = 0; i < parts.length; i++) {
      const spelling = parts.slice(0, i + 1).join("/"), key = spelling.toLowerCase();
      const isDirectory = directory || i < parts.length - 1, explicit = i === parts.length - 1;
      const prior = seen.get(key);
      if (prior && (prior.spelling !== spelling || prior.directory !== isDirectory || prior.explicit && explicit)) {
        throw new Error("artifact_windows_path_collision");
      }
      seen.set(key, { spelling, directory: isDirectory, explicit: explicit || !!prior?.explicit });
    }
  };
}
