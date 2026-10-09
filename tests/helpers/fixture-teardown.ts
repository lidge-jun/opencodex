import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import { flushConfigDirHardening } from "../../src/config/paths";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "./remove-tree";

export interface FixtureRoot { path: string; remove?: (path: string) => void }
export interface FixtureTeardownPlan { roots: FixtureRoot[]; restoreEnvironment: () => void }
export interface FixtureTeardownDeps {
  settleProducers(): Promise<void>;
  settleConfigFlights(root: string): Promise<void>;
  closeHistory(): void;
  drainAcl(root: string): Promise<void>;
  remove(path: string): void;
}
export const defaultFixtureTeardownDeps: Readonly<FixtureTeardownDeps> = {
  settleProducers: flushNativeMainStartupReleases,
  settleConfigFlights: flushConfigDirHardening,
  closeHistory: closeRequestHistoryIndex,
  drainAcl: flushWindowsSecretAclReapsBeforeRemoval,
  remove: removeTreeWithRetry,
};

/** Remove only roots whose owners settled; restoration cannot mask the first failure. */
export async function drainAndRemoveFixtureRoots(
  plan: FixtureTeardownPlan,
  overrides: Partial<FixtureTeardownDeps> = {},
): Promise<void> {
  const deps = { ...defaultFixtureTeardownDeps, ...overrides };
  const failures: unknown[] = [];
  const attempt = async (action: () => void | Promise<void>): Promise<boolean> => {
    try { await action(); return true; }
    catch (error) { failures.push(error); return false; }
  };
  try {
    const producersSettled = await attempt(() => deps.settleProducers());
    const ready: boolean[] = [];
    for (const root of plan.roots) ready.push(await attempt(() => deps.settleConfigFlights(root.path)));
    const historyClosed = await attempt(() => deps.closeHistory());
    for (const [index, root] of plan.roots.entries()) {
      const drained = await attempt(() => deps.drainAcl(root.path));
      ready[index] = ready[index] && drained;
    }
    if (producersSettled && historyClosed) {
      for (const [index, root] of plan.roots.entries()) {
        if (ready[index]) await attempt(() => (root.remove ?? deps.remove)(root.path));
      }
    }
  } finally {
    await attempt(() => plan.restoreEnvironment());
  }
  if (failures.length) throw failures[0];
}
