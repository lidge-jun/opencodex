/** Resolve Expressive Code UI language from content files, including encoded Windows URLs. */
export function codeBlockLocale(file: { path?: string; url?: URL }): string {
  for (const candidate of [file.path, file.url?.pathname]) {
    if (!candidate) continue;
    let path = candidate.replaceAll("\\", "/");
    try { path = decodeURIComponent(path); } catch { /* Keep a malformed escape literal. */ }
    const relative = path.split("/src/content/docs/").at(1) ?? path.replace(/^\//, "");
    const locale = /^([a-z]{2}(?:-[a-z]{2})?)\//.exec(relative)?.[1];
    if (locale) return locale.replace(/-([a-z]{2})$/, (_, region: string) => `-${region.toUpperCase()}`);
  }
  return "en";
}
