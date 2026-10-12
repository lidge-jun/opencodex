import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * Where `handleStart` runs the Codex routing healer (`src/codex/routing-healer.ts`).
 *
 * A source oracle, like the exit-teardown checks in `cli-dispatch.test.ts`: a real owner would
 * need 20 s of a dead port before the healer acts, and the order asserted here is what matters.
 * The healer starts only after the startup sync settled, never in a sibling (whose routing is the
 * live owner's) and never once cleanup began; the exit cleanup stops it before anything restores
 * native Codex, so it can never re-point routing a stop teardown just put back.
 */
const cliSource = readFileSync(repoPath("src/cli/index.ts"), "utf8");

function slice(from: string, to: string): string {
  const at = cliSource.indexOf(from);
  const end = cliSource.indexOf(to, at);
  expect(at).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(at);
  return cliSource.slice(at, end);
}

describe("handleStart routing-healer wiring", () => {
  const start = slice("async function handleStart(", "function detachedStartEnvironment(");

  test("an unmarked owner starts the healer after the startup sync settled", () => {
    const load = 'const routingHealerModule = siblingStart ? null : await import("../codex/routing-healer");';
    const call = "if (routingHealerModule && !cleaned) routingHealer = routingHealerModule.startCodexRoutingHealer({ port, config });";
    const loadAt = start.indexOf(load);
    const startAt = start.indexOf(call);
    expect(loadAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(-1);
    expect(start.indexOf(call, startAt + 1)).toBe(-1);
    // `cleaned` is read after the import settled: a signal during that await ran the cleanup, which
    // found no healer to stop, so none may start afterwards.
    expect(startAt).toBeGreaterThan(loadAt);
    expect(start.slice(loadAt + load.length, startAt).trim()).toBe("");
    expect(startAt).toBeGreaterThan(start.indexOf("const startupSync = await reconcileClientStartupBeforeReady("));
    // The connected-client runtime returned long before this point.
    expect(startAt).toBeGreaterThan(start.indexOf('await import("../client/runtime")'));
  });

  test("the exit cleanup stops the healer before any shared teardown", () => {
    const cleanup = slice("const syncCleanup = () => {", "let shuttingDown = false;");
    const stopAt = cleanup.indexOf("try { routingHealer?.stop(); } catch { /* best-effort */ }");
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(cleanup.indexOf("revertSystemEnv()"));
    expect(stopAt).toBeLessThan(cleanup.indexOf("restoreNativeCodex()"));
    expect(stopAt).toBeLessThan(cleanup.indexOf("stripGrokConfig()"));
    expect(stopAt).toBeGreaterThan(cleanup.indexOf("cleaned = true;"));
  });
});
