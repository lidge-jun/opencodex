import type { DesktopStoreInspectReason } from "../claude/desktop-remote-store";

const FOLDER = "the desktop-remote folder in the OpenCodex home";

/**
 * The `ocx disconnect` refusal for a Claude Desktop remote store it cannot verify: what was found,
 * where, and the step that clears it, with the machine-readable code last. Each fix leaves the next
 * inspection able to decide; none is run for the person, because each gives up or rewrites
 * something in Claude Desktop that only they can judge.
 */
export function desktopLifecycleRefusal(desktop: { kind: string; reason?: DesktopStoreInspectReason; path?: string }): string {
  const at = desktop.path;
  const body = (() => {
    switch (desktop.reason) {
      case "root_without_state":
        return `${at} exists but holds no Claude Desktop remote state or disconnect receipt (a leftover or renamed file), so disconnect cannot tell what it would restore. Nothing was changed. Move that folder aside, then run ocx disconnect again.`;
      case "store_unreadable":
        return `OpenCodex cannot read safely the Claude Desktop remote state in ${at ?? FOLDER}: state.json or baseline.json is not an owner-only regular file, is not valid, or was written for another OpenCodex home or Claude Desktop library. Nothing was changed. If either file is not owner-only, make it so (chmod 600) and retry. Otherwise move that folder aside and keep it (its baseline.json holds the Claude Desktop profile OpenCodex replaced); disconnect then gives Claude Desktop's OpenCodex profile its standard settings. In either case, then run ocx disconnect again.`;
      case "store_other_connection":
        return `${at} records a Claude Desktop profile applied for a different connection (another Home or an earlier link), so this disconnect cannot restore it. Nothing was changed. In Claude Desktop, remove that connection's OpenCodex profile; then move ${FOLDER} aside, then run ocx disconnect again.`;
      case "library_unreadable":
        return `the Claude Desktop profile list in ${at} (_meta.json or the selected profile file) could not be read safely. Nothing was changed. Restore that file to valid JSON from Claude Desktop or a backup, then run ocx disconnect again.`;
      case "profile_missing":
        return `the OpenCodex profile in the Claude Desktop library ${at} was removed or renamed outside OpenCodex, so disconnect cannot restore the profile it replaced. Nothing was changed. Rename it back to "opencodex" in Claude Desktop; if it was deleted, move ${FOLDER} aside instead; then run ocx disconnect again.`;
      case "profile_edited":
        return `the OpenCodex profile ${at} was edited outside OpenCodex after it was applied. Nothing was changed. Disconnect restores the profile OpenCodex replaced, which discards those edits: copy anything you want to keep from that file, undo the edits, then run ocx disconnect again.`;
      case "profile_ambiguous":
        return `a profile in the Claude Desktop library ${at} reaches this Home, but disconnect cannot identify it as OpenCodex's current profile (it has another name, an older key, or is a second copy). Nothing was changed. In Claude Desktop, remove every profile that reaches this Home except one named "opencodex" that uses this connection's current key; if the only one left uses an older key, remove that one too, then run ocx disconnect again.`;
      case "token_unreadable":
        return `the service token or its rotation backup (${at}) is not a safe regular file, so disconnect cannot tell which keys belong to this connection. Nothing was changed. Make both files owner-only regular files (move a directory or link at that path aside), then run ocx disconnect again.`;
      case "connection_changed":
        return `the saved connection changed while disconnect was checking Claude Desktop. Nothing was changed. Check ocx connect status, then run ocx disconnect again.`;
      default:
        return `the Claude Desktop remote profile store could not be verified (${desktop.kind}). Nothing was changed. Check ${FOLDER} and the Claude Desktop profile library, then run ocx disconnect again.`;
    }
  })();
  return `Disconnect refused: ${body} (code desktop_lifecycle_unsafe)`;
}
