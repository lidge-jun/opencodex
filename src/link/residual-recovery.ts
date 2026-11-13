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

/**
 * The lightweight agent's detach by the paths it can have: the managed copy (not necessarily on PATH) for the Child's platform,
 * both Windows locations in Command Prompt, and a copy placed by hand through the path command -v (where.exe) prints.
 */
function lightweightDetach(id: string, platform: "posix" | "windows" | undefined): { first: string; rest: string; prompt: boolean } {
  const posix = "~/.cache/opencodex/bin/ocx-child detach --expect-link " + id;
  const windows = "\"%LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe\" detach --expect-link " + id;
  const windowsFallback = "\"%USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe\" detach --expect-link " + id;
  const placed = (lookup: string) => "for a copy placed by hand, the same detach --expect-link " + id + " through the path " + lookup + " prints";
  if (platform === "windows") return { first: windows, rest: " (or " + windowsFallback + " where LOCALAPPDATA is not set; " + placed("where.exe ocx-child") + ")", prompt: true };
  if (platform === "posix") return { first: posix, rest: " (" + placed("command -v ocx-child") + ")", prompt: false };
  return { first: posix, rest: " (on Windows, in Command Prompt, " + windows + ", or " + windowsFallback + " where LOCALAPPDATA is not set; " + placed("command -v ocx-child, or where.exe ocx-child on Windows,") + ")", prompt: false };
}

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
  const light = lightweightDetach(id, platform);
  if (kind === "ephemeral") return (light.prompt ? "In Command Prompt on the Child, run " + light.first + " before retrying" : "Run " + light.first + " on the Child before retrying") + light.rest + ": " + bound(id) + " " + OLDER_LIGHTWEIGHT;
  if (kind === "full") return "Run ocx disconnect --expect-link " + id + " on the Child and, if it disconnected, ocx restart, before retrying: it disconnects only while the Child is connected to this attempt's link (" + id + "). " + olderFull(id);
  return "Run ocx disconnect --expect-link " + id + " and, if it disconnected, ocx restart on a full install, or " + (light.prompt ? "in Command Prompt " : "") + light.first + " on a lightweight Child" + light.rest + ", before retrying: either acts only while the Child belongs to this attempt's link (" + id + "). "
    + "A build older than that flag refuses it before it acts; then leave a lightweight Child as it is, and on a full install run ocx disconnect and ocx restart only if ocx connect status --json shows " + id + ", right after that check, and otherwise leave it as it is.";
}
