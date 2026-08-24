import type {
  ForkSyncCoordinator,
  ForkSyncNotifier,
} from "./types";

const notifiers = new Map<string, ForkSyncNotifier>();
const coordinators = new Map<string, ForkSyncCoordinator>();

export function registerNotifier(notifier: ForkSyncNotifier): void {
  if (!notifier.id.trim()) throw new Error("fork sync notifier ID is required");
  notifiers.set(notifier.id, notifier);
}

export function registerCoordinator(coordinator: ForkSyncCoordinator): void {
  if (!coordinator.id.trim()) throw new Error("fork sync coordinator ID is required");
  coordinators.set(coordinator.id, coordinator);
}

function selectedIds(
  value: string | undefined,
  kind: "notifier" | "coordinator",
): string[] {
  const ids = (value ?? "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);
  return ids.map(id => {
    const collection = kind === "notifier" ? notifiers : coordinators;
    if (!collection.has(id)) throw new Error(`unknown fork sync ${kind}: ${id}`);
    return id;
  });
}

export function enabledNotifiers(
  env: Record<string, string | undefined> = process.env,
): ForkSyncNotifier[] {
  return selectedIds(env.FORK_SYNC_NOTIFIERS, "notifier")
    .map(id => notifiers.get(id)!);
}

export function enabledCoordinators(
  env: Record<string, string | undefined> = process.env,
): ForkSyncCoordinator[] {
  return selectedIds(env.FORK_SYNC_COORDINATORS, "coordinator")
    .map(id => coordinators.get(id)!);
}
