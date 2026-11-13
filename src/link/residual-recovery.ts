/**
 * What to run on a Child that a failed enrollment may have left connected. Every step is bound to the attempt's link id
 * (--expect-link), so it acts only while the Child's records name that link or nothing at all, and leaves a Child that
 * another link, a hub or another Home owns: a plain disconnect or detach read long after the attempt could remove a link
 * the machine joined since. A build older than the flag refuses it before it acts; then a full install falls back to a
 * check of that link id, and a lightweight Child is left (its status cannot show an interrupted attach of another link,
 * which a plain detach would restore and then remove). Without a valid id nothing can be bound, so the Child is left.
 * One source for the live apply answer, the journal's replay and the CLI.
 */
export type ResidualChild = "plant" | "ephemeral" | "full" | "enrollment";

const LINK_ID = /^lnk_[0-9a-f]{16}$/;

export const RESIDUAL_NO_LINK = "This answer does not name the attempt's link id, so no step on the Child can be bound to it: leave the Child as it is.";

const OLDER_LIGHTWEIGHT = "An ocx-child older than that flag refuses it before it acts; then leave the Child as it is: its status cannot show an interrupted attach of another link, which a plain detach would restore and then remove.";

const olderFull = (id: string): string => "An OpenCodex older than that flag refuses it before it acts on the link; then run ocx disconnect and ocx restart only if ocx connect status --json shows " + id
  + ", right after that check (an enrollment that lands between the two commands would be removed), and otherwise leave the Child as it is.";

const bound = (id: string): string => "it acts only when the Child's records name this attempt's link (" + id + ") or nothing at all, and leaves a Child that another link, a hub or another Home owns.";

export function residualRecovery(kind: ResidualChild, linkId: string | undefined, platform?: "posix" | "windows"): string {
  if (linkId === undefined || !LINK_ID.test(linkId)) return RESIDUAL_NO_LINK;
  const id = linkId;
  if (kind === "plant") {
    // The Home planted this build itself, so it knows the flag. Both places the plant uses on Windows.
    const posix = "~/.cache/opencodex/bin/ocx-child detach --purge --expect-link " + id;
    const windows = "\"%LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe\" detach --purge --expect-link " + id;
    const windowsFallback = "\"%USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe\" detach --purge --expect-link " + id;
    if (platform === "windows") return "In Command Prompt on the Child, run " + windows + " (or " + windowsFallback + " where LOCALAPPDATA is not set) before retrying: " + bound(id);
    if (platform === "posix") return "Run " + posix + " on the Child before retrying: " + bound(id);
    return "Run " + posix + " on the Child before retrying (on Windows, in Command Prompt, " + windows + ", or " + windowsFallback + " where LOCALAPPDATA is not set): " + bound(id);
  }
  if (kind === "ephemeral") return "Run ocx-child detach --expect-link " + id + " on the Child (the planted copy is ~/.cache/opencodex/bin/ocx-child) before retrying: " + bound(id) + " " + OLDER_LIGHTWEIGHT;
  if (kind === "full") return "Run ocx disconnect --expect-link " + id + " on the Child and, if it disconnected, ocx restart, before retrying: it disconnects only while the Child is connected to this attempt's link (" + id + "). " + olderFull(id);
  return "Run ocx disconnect --expect-link " + id + " and, if it disconnected, ocx restart on a full install, or ocx-child detach --expect-link " + id + " on a lightweight Child, before retrying: either acts only while the Child belongs to this attempt's link (" + id + "). "
    + "A build older than that flag refuses it before it acts; then leave a lightweight Child as it is, and on a full install run ocx disconnect and ocx restart only if ocx connect status --json shows " + id + ", right after that check, and otherwise leave it as it is.";
}
