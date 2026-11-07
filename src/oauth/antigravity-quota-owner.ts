import { createHash } from "node:crypto";
import { getConfigDir } from "../config/paths";
import type { AuthStore } from "./store";

type Selection = { signature: string; root: string };
type Owner = { selection: Selection; generation: string; accountKey: string };
let selection: Selection | undefined;
let owner: Owner | undefined;

/** Observe only stores already loaded or written by the OAuth owner; never perform I/O here. */
export function observeAntigravityReportStore(store: AuthStore): void {
  const set = store["google-antigravity"];
  const account = set?.accounts.find(row => row.id === set.activeAccountId);
  const root = getConfigDir();
  const signature = account ? JSON.stringify([account.id, account.loginId, account.pauseRevision, set?.selectionRevision, account.paused, account.needsReauth]) : "";
  if (!account || !account.credential.access || !account.credential.projectId || account.paused || account.needsReauth) {
    selection = undefined; owner = undefined; return;
  }
  if (!selection || selection.root !== root || selection.signature !== signature) selection = { root, signature };
  const generation = createHash("sha256").update(JSON.stringify([account.credential.refresh, account.credential.access, account.credential.expires, account.credential.projectId])).digest("hex");
  if (!owner || owner.selection !== selection || owner.generation !== generation) {
    // The login incarnation is stable across token refresh; old stores without one use selection revision.
    owner = { selection, generation, accountKey: JSON.stringify(["google-antigravity", account.id, account.loginId ?? set?.selectionRevision ?? null]) };
  }
}

export function captureAntigravityReportSelection(): Selection | undefined { return selection?.root === getConfigDir() ? selection : undefined; }
export function captureAntigravityReportOwner(expected: Selection | undefined): Owner | undefined {
  return expected && selection === expected && owner?.selection === expected && expected.root === getConfigDir() ? owner : undefined;
}
export function antigravityReportOwnerCurrent(captured: Owner): boolean {
  return owner === captured && captured.selection.root === getConfigDir();
}
