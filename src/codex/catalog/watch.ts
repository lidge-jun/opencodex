import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { loadConfig } from "../../config";
import { activeCodexModelsCachePath } from "./parsing";
import { codexDesktopNativeModelsNeedSync } from "./metadata";

/** Watch Desktop's model cache and reconcile newly observed account-native models. */
export function startCodexDesktopModelCacheWatcher(
  sync: () => Promise<unknown>,
  log: Pick<Console, "error"> = console,
): { stop: () => void } | null {
  const cachePath = activeCodexModelsCachePath();
  let watcher: FSWatcher;
  try {
    watcher = watch(dirname(cachePath), (_event, filename) => {
      if (filename !== null && filename.toString() !== basename(cachePath)) return;
      scheduleSync();
    });
  } catch {
    log.error("⚠️  Could not watch Codex Desktop model cache; automatic model refresh is disabled.");
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let syncing = false;
  let pending = false;

  /** Reconcile only once Desktop has published a genuinely new model row. */
  const runSync = async () => {
    if (stopped || syncing || !codexDesktopNativeModelsNeedSync(loadConfig())) return;
    syncing = true;
    try {
      await sync();
    } catch (error) {
      log.error(`⚠️  Codex Desktop model catalog sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      syncing = false;
      if (pending) {
        pending = false;
        void runSync();
      }
    }
  };

  /** Debounce atomic replacement and multi-event writes from Codex Desktop. */
  function scheduleSync(): void {
    if (stopped) return;
    if (syncing) {
      pending = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runSync();
    }, 500);
    timer.unref();
  }

  watcher.on("error", () => {
    log.error("⚠️  Codex Desktop model cache watcher stopped; automatic model refresh is disabled.");
  });
  watcher.unref();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
