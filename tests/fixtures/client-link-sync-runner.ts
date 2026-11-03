/** A separate CLI-like sync process; never initializes or overwrites the running fixture. */
import { mock } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const options = JSON.parse(readFileSync(0, "utf8")) as { hold: "catalog" | "home" | "lock" | false; name: "held" | "fresh" };
const home = process.env.OPENCODEX_HOME!;
if (options.hold === "lock") {
  const { Database } = await import("bun:sqlite");
  const database = new Database(join(home, "config-mutation.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    writeFileSync(join(home, "held-requested"), "ready");
    while (!existsSync(join(home, "catalog-release"))) await Bun.sleep(10);
    database.exec("ROLLBACK");
  } finally { database.close(); }
  writeFileSync(join(home, "held-sync-result.json"), JSON.stringify({ ok: true, lockHeld: true }));
  process.exit(0);
}
const lifecycle = await import("../../src/client/lifecycle-lock");
const lock = lifecycle.withClientLifecycleSync;
mock.module("../../src/client/lifecycle-lock", () => ({ ...lifecycle,
  withClientLifecycleSync: (work: Parameters<typeof lock>[0]) => lock(work, { lockPath: join(home, "lifecycle.sqlite") }),
}));
const { syncConnectedClient } = await import("../../src/client/connect");
let fetched = false;
let result: unknown;
const pause = async (phase: "catalog" | "home") => {
  if (options.hold !== phase) return;
  writeFileSync(join(home, `${options.name}-requested`), "ready");
  while (!existsSync(join(home, "catalog-release"))) await Bun.sleep(10);
};
try {
  const synced = await syncConnectedClient({}, {
    fetchImpl: (async () => {
      fetched = true;
      // A deterministic transport seam: test ordering, not a production network deadline.
      await pause("catalog");
      return Response.json({ models: [{ slug: "fixture/late-sync" }] });
    }) as typeof fetch,
    now: () => new Date("2026-10-31T01:00:00.000Z"),
    catalogCompatibility: { supportedEfforts: () => new Set(["low", "medium", "high"]) },
    linkHome: { fetchImpl: (async () => { await pause("home"); return Response.json({}, { status: 404 }); }) as typeof fetch },
  });
  result = { ok: true, fetched, catalogWritten: synced.catalogWritten, injected: synced.injected };
} catch (error) {
  result = { ok: false, fetched, error: error instanceof Error ? error.message : "unknown" };
}
writeFileSync(join(home, `${options.name}-sync-result.json`), JSON.stringify(result));
