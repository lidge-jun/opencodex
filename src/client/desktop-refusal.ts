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
        return `OpenCodex cannot read safely the Claude Desktop remote state in ${at ?? FOLDER}: state.json or baseline.json is not an owner-only regular file, is not valid, or was written for another OpenCodex home or Claude Desktop library. Nothing was changed. Make both files owner-only (chmod 600) if they are not; if the folder was copied from elsewhere, move it aside instead; then run ocx disconnect again.`;
      case "store_other_connection":
        return `${at} records a Claude Desktop profile applied for a different connection (another Home or an earlier link), so this disconnect cannot restore it. Nothing was changed. Move ${FOLDER} aside, then run ocx disconnect again; that profile stays in Claude Desktop until you remove it there.`;
      case "library_unreadable":
        return `the Claude Desktop profile list in ${at} (_meta.json or the selected profile file) could not be read safely. Nothing was changed. Restore that file to valid JSON from Claude Desktop or a backup, then run ocx disconnect again.`;
      case "profile_missing":
        return `the OpenCodex profile in the Claude Desktop library ${at} was removed or renamed outside OpenCodex, so disconnect cannot restore the profile it replaced. Nothing was changed. Rename it back to "opencodex" in Claude Desktop; if it was deleted, move ${FOLDER} aside instead; then run ocx disconnect again.`;
      case "profile_edited":
        return `the OpenCodex profile ${at} was edited outside OpenCodex after it was applied, and restoring would discard those edits. Nothing was changed. Undo the edits, or move ${FOLDER} aside to give up restoring the profile it replaced, then run ocx disconnect again.`;
      case "profile_ambiguous":
        return `the Claude Desktop library ${at} has more than one profile using this Home's address, or one not named "opencodex", so disconnect cannot tell which is OpenCodex's. Nothing was changed. Remove the extra profiles in Claude Desktop, then run ocx disconnect again.`;
      default:
        return `the Claude Desktop remote profile store could not be verified (${desktop.kind}). Nothing was changed. Check ${FOLDER} and the Claude Desktop profile library, then run ocx disconnect again.`;
    }
  })();
  return `Disconnect refused: ${body} (code desktop_lifecycle_unsafe)`;
}
