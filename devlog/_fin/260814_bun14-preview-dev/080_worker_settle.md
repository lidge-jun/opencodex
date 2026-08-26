# 080 — Skip 1.3.14 OS join settles on qualified Bun 1.4

## Files

### MODIFY: src/storage/worker-lifecycle.ts
```diff
-export function storageWorkerOsJoinSettleMs(platform = process.platform): number {
+export function storageWorkerOsJoinSettleMs(
+  platform = process.platform,
+  runtime = currentBunQualification(),
+): number {
+  if (runtime.workerCloseIsPostJoin) return 0;
   if (platform === "win32") return 1_500;
   if (platform === "darwin" || platform === "linux") return 250;
   return 0;
 }
```

### MODIFY: src/storage/worker-lifecycle.ts (terminateStorageWorker)
Wire terminate() thenable when available:
```ts
const result = worker.terminate() as unknown;
if (result && typeof result === "object" && typeof (result as any).then === "function") {
  await result;
}
```

### NEW or MODIFY: src/lib/bun-qualification.ts
```ts
export type BunQualification = {
  workerCloseIsPostJoin: boolean;
};
export function currentBunQualification(): BunQualification { ... }
```

