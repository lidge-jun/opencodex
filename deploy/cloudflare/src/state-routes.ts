import { BOOT_ID_PATTERN } from "./lease";

// Kept free of Workers-only imports so tests/service/cloudflare-deploy.test.ts can drive it.
export interface StateHub {
  acquireLease(bootId: string): Promise<{ granted: boolean; retryAfterSeconds?: number }>;
  renewLease(bootId: string): Promise<boolean>;
  holdsLease(bootId: string): Promise<boolean>;
  releaseLease(bootId: string): Promise<void>;
  currentSnapshot(): Promise<string | undefined>;
  commitSnapshot(bootId: string, key: string): Promise<{ replaced: string | undefined } | null>;
}

export interface StateBucket {
  get(key: string): Promise<ReadableStream | null>;
  put(key: string, body: ReadableStream, length: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix`, at most `limit` of them. */
  list(prefix: string, limit: number): Promise<string[]>;
}

const SNAPSHOT_PREFIX = "snapshots/";
const SWEEP_LIMIT = 1000;

/** Where this hub's uploads go. Keys from before namespacing (`snapshots/<bootId>/…`) sit outside it. */
export function snapshotPrefix(namespace: string): string {
  return `${SNAPSHOT_PREFIX}${namespace}/`;
}

/**
 * Deletes every object in this hub's namespace except the committed one. Safe only right after a boot
 * acquires the lease: nobody else can commit from then on, so any other object is an orphan from an
 * upload that died between put and commit, or from a failed delete of a replaced snapshot. Another
 * deployment sharing the bucket has its own namespace, and a committed key in the old layout is
 * outside every namespace, so neither is touched.
 */
export async function sweepOrphans(hub: Pick<StateHub, "currentSnapshot">, bucket: StateBucket, namespace: string): Promise<number> {
  const keep = await hub.currentSnapshot();
  const orphans = (await bucket.list(snapshotPrefix(namespace), SWEEP_LIMIT)).filter(key => key !== keep);
  for (const key of orphans) await bucket.delete(key);
  return orphans.length;
}

export async function handleStateRequest(req: Request, hub: StateHub, bucket: StateBucket, namespace: string): Promise<Response> {
  const path = new URL(req.url).pathname;
  const bootId = req.headers.get("x-ocx-boot-id") ?? "";
  if (!BOOT_ID_PATTERN.test(bootId)) return new Response("missing boot id", { status: 400 });

  if (path === "/lease" && req.method === "POST") {
    const result = await hub.acquireLease(bootId);
    if (!result.granted) {
      return new Response("lease held", { status: 409, headers: { "retry-after": String(result.retryAfterSeconds) } });
    }
    try {
      await sweepOrphans(hub, bucket, namespace);
    } catch (error) {
      // Cleanup only; never let it block a boot.
      console.error(`Snapshot orphan sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new Response(null, { status: 204 });
  }
  if (path === "/lease" && req.method === "PUT") {
    return (await hub.renewLease(bootId)) ? new Response(null, { status: 204 }) : new Response("lease lost", { status: 409 });
  }
  if (path === "/lease" && req.method === "DELETE") {
    await hub.releaseLease(bootId);
    return new Response(null, { status: 204 });
  }
  if (path === "/snapshot" && req.method === "GET") {
    // Only the lease holder restores; any other process in the container gets nothing.
    if (!(await hub.holdsLease(bootId))) return new Response("lease required", { status: 409 });
    const key = await hub.currentSnapshot();
    if (!key) return new Response("no snapshot", { status: 404 });
    const body = await bucket.get(key);
    // A committed pointer to a missing object must not read as "first boot": that would seed a
    // fresh home and upload it over the lost state.
    return body ? new Response(body) : new Response("snapshot object missing", { status: 500 });
  }
  if (path === "/snapshot" && req.method === "PUT") {
    const length = Number(req.headers.get("content-length"));
    if (!req.body || !Number.isSafeInteger(length) || length <= 0) return new Response("length required", { status: 411 });
    if (!(await hub.holdsLease(bootId))) return new Response("lease lost", { status: 409 });
    // A key per upload, never per boot: a fenced container's late upload must not overwrite the
    // object the current holder restored from, and its cleanup must delete only its own object.
    const key = `${snapshotPrefix(namespace)}${bootId}/${crypto.randomUUID()}.tar.gz`;
    await bucket.put(key, req.body, length);
    const commit = await hub.commitSnapshot(bootId, key);
    if (!commit) {
      await bucket.delete(key);
      return new Response("lease lost", { status: 409 });
    }
    if (commit.replaced) await bucket.delete(commit.replaced);
    return new Response(null, { status: 204 });
  }
  return new Response("not found", { status: 404 });
}
