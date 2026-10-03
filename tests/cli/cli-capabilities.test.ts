import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { capabilityDataBoundary } from "../helpers/cli-capability-data";
import {
  CAPABILITIES,
  HEAD_CAPABILITIES,
  capabilitiesForRoute,
  capabilityInvocation,
  capabilityRouteKeys,
} from "../../src/cli/capabilities";
import { CLI_COMMANDS, findCommand } from "../../src/cli/registry";
import { runCapabilities } from "../../src/cli/capabilities-command";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

const repoRoot = resolveRepoRoot();

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.log = original; } };
}

describe("capability table is a checked data graph", () => {
  test("capability discovery has only the allowed transitive data/type edges", () => {
    expect(capabilityDataBoundary(join(repoRoot, "src/cli"))).toEqual([]);
  });

  test("every capability renders a non-empty invocation and summary", () => {
    // Guards the degraded-cycle failure mode directly: an empty string here means the
    // table resolved to undefined somewhere rather than throwing.
    const empty = CAPABILITIES.filter(c => capabilityInvocation(c).trim() === "ocx" || c.summary.trim() === "");
    expect(empty).toEqual([]);
    for (const head of HEAD_CAPABILITIES) {
      expect(head.invocations.length).toBeGreaterThan(0);
      expect(head.summary.trim().length).toBeGreaterThan(0);
      expect(head.bannerLine.trim().length).toBeGreaterThan(0);
    }
  });

  test("a capability declaring routes marks mutation consistently", async () => {
    // A capability that drives only reads must not claim to mutate, and one driving a
    // write must not claim otherwise -- the flag is what --mutating-only filters on. The
    // registry's `mutates` decides, so a read-only POST (`POST /api/protocols/plan`, a
    // preview that sends nothing) is a read; an undeclared route falls back to its method.
    const { MANAGEMENT_ROUTES } = await import("../../src/server/management/route-registry");
    const declared = new Map(MANAGEMENT_ROUTES.map(r => [`${r.method} ${r.path}`, r.mutates] as const));
    const wrong: string[] = [];
    for (const cap of CAPABILITIES) {
      if (cap.routes.length === 0) continue;
      const anyWrite = cap.routes.some(r => declared.get(`${r.method} ${r.path}`) ?? r.method !== "GET");
      if (anyWrite !== cap.mutates) wrong.push(capabilityInvocation(cap));
    }
    expect(wrong).toEqual([]);
  });

  test("head-handled surfaces are NOT registry commands", () => {
    // tests/cli/cli-registry.test.ts excludes help/--help/-h as head-handled pseudo-cases,
    // and --version exits in the CLI head before dispatch. Declaring either as a
    // CLI_COMMANDS entry would break the runner-key parity assertion.
    const names = new Set(CLI_COMMANDS.map(e => e.name));
    for (const head of HEAD_CAPABILITIES) {
      for (const invocation of head.invocations) {
        expect(names.has(invocation), `${invocation} must stay head-handled`).toBe(false);
      }
    }
  });

  test("the capabilities verb itself is a registered command", () => {
    expect(findCommand("capabilities")?.name).toBe("capabilities");
    expect(CAPABILITIES.some(c => c.command[0] === "capabilities")).toBe(true);
  });

  test("logs follow does not claim to imply JSONL output", () => {
    const logs = CAPABILITIES.find(c => c.command.length === 1 && c.command[0] === "logs");
    const follow = logs?.flags.find(flag => flag.name === "--follow");
    expect(follow?.summary).toBe("Poll for new rows; add --jsonl to emit JSONL.");
  });

  test("the check-only Codex CLI updater is declared as a local read capability", () => {
    const cap = CAPABILITIES.find(c => c.command.join(" ") === "system codex-cli-update check");
    expect(cap).toBeDefined();
    expect(cap?.routes).toEqual([]);
    expect(cap?.mutates).toBe(false);
    expect(cap?.json).toBe("envelope");
    expect(cap?.flags.some(flag => flag.name === "--json")).toBe(true);
    expect(cap?.summary).toContain("configured Codex CLI candidate");
    expect(cap?.details.join(" ")).toContain("does not attest or admit a selected runtime");
    expect(cap?.details.join(" ")).not.toContain("dry-run");
  });
});

describe("ocx capabilities output", () => {
  test("--json emits a stable envelope with routes and flags", async () => {
    const cap = captureStdout();
    let code: number;
    try { code = await runCapabilities(["--json"]); } finally { cap.restore(); }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.lines.join("\n")) as {
      schemaVersion: number;
      capabilities: { invocation: string; routes: unknown[]; flags: unknown[]; mutates: boolean; json: string }[];
      headCapabilities?: unknown[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.capabilities.length).toBe(CAPABILITIES.length);
    expect(parsed.headCapabilities).toHaveLength(HEAD_CAPABILITIES.length);
    for (const entry of parsed.capabilities) {
      expect(entry.invocation.startsWith("ocx ")).toBe(true);
      expect(Array.isArray(entry.routes)).toBe(true);
      expect(Array.isArray(entry.flags)).toBe(true);
      expect(typeof entry.mutates).toBe("boolean");
      expect(["payload", "envelope", "none"]).toContain(entry.json);
    }
  });

  test("--route resolves to the capabilities driving that route", async () => {
    const target = "/api/codex-auth/accounts";
    expect(capabilitiesForRoute(target).length).toBeGreaterThan(0);
    const cap = captureStdout();
    let code: number;
    try { code = await runCapabilities(["--route", target, "--json"]); } finally { cap.restore(); }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.lines.join("\n")) as { route: string; capabilities: { invocation: string }[] };
    expect(parsed.route).toBe(target);
    expect(parsed.capabilities.map(c => c.invocation)).toContain("ocx account list");
  });

  test("Claude config declares both management methods", () => {
    const claudeConfig = capabilitiesForRoute("/api/claude-code")
      .find(cap => capabilityInvocation(cap) === "ocx claude config");
    expect(claudeConfig?.routes).toEqual([
      { method: "GET", path: "/api/claude-code" },
      { method: "PUT", path: "/api/claude-code" },
    ]);
  });

  test("--route accepts the flag in any argv position", async () => {
    // Order-independence is the point: positional flag reading is why
    // `ocx restore back --json` silently ignored its flag.
    const cap = captureStdout();
    let code: number;
    try { code = await runCapabilities(["--json", "--route", "/api/usage"]); } finally { cap.restore(); }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.lines.join("\n")) as { capabilities: { invocation: string }[] };
    expect(parsed.capabilities.map(c => c.invocation)).toEqual(["ocx usage", "ocx models order set", "ocx combo stats", "ocx observe usage"]);
  });

  test("an unmatched route exits non-zero instead of reporting empty success", async () => {
    // Reporting success for a route no verb drives is the class of dishonesty wp2 fixed
    // in the transport layer; do not reintroduce it here.
    const cap = captureStdout();
    let code: number;
    try { code = await runCapabilities(["--route", "/api/does-not-exist", "--json"]); } finally { cap.restore(); }
    expect(code).toBe(4);
  });

  test("--mutating-only keeps only mutating capabilities", async () => {
    const expected = CAPABILITIES.filter(c => c.mutates);
    const cap = captureStdout();
    try { await runCapabilities(["--mutating-only", "--json"]); } finally { cap.restore(); }
    const parsed = JSON.parse(cap.lines.join("\n")) as { capabilities: { mutates: boolean }[] };
    expect(parsed.capabilities).toHaveLength(expected.length);
    expect(parsed.capabilities.every(c => c.mutates)).toBe(true);
  });

  test("ocx provider list does not claim GET /api/providers", () => {
    const cap = CAPABILITIES.find(c => c.command[0] === "provider" && c.command[1] === "list");
    expect(cap).toBeDefined();
    expect(cap?.routes).toEqual([]);
  });

  test("--route without a path is usage, not a full table dump", async () => {
    const cap = captureStdout();
    let code: number;
    try { code = await runCapabilities(["--route"]); } finally { cap.restore(); }
    expect(code).toBe(64);
  });

  test("every route a capability declares exists in the management registry", async () => {
    // The capability table must not advertise a route the server does not serve.
    const { MANAGEMENT_ROUTES } = await import("../../src/server/management/route-registry");
    const declared = new Set(MANAGEMENT_ROUTES.map(r => `${r.method} ${r.path}`));
    const unknown = [...capabilityRouteKeys()].filter(k => !declared.has(k));
    expect(unknown).toEqual([]);
  });
});
/**
 * The 139 management routes that have neither a CLI capability nor a justified
 * `route.exempt`, as of 2026-08-28. This list is a RATCHET, not an allowlist: the parity
 * test below fails on any route that is not in it, so new drift is blocked while the
 * existing debt is visible, counted and dated.
 *
 * It exists because the forward gate was one-directional. `cli-capabilities.test.ts`
 * asserted every capability's route exists and never the converse, so 139 routes carried no
 * verb and nothing failed. The user-visible consequence is that `ocx capabilities --route
 * /api/keys` -- an agent's discovery entry point -- returns an empty list and exits 4 while
 * `ocx access key` works.
 *
 * Most of these are NOT internal plumbing, which is the important correction: 122 of the 139
 * paths are already referenced from CLI source, and of the remainder only about two are
 * plausibly pure plumbing (`/api/update/badge`, `/api/system/windows-replace-retries`). So
 * the debt is overwhelmingly "a working command exists but declares no capability", not
 * "these routes should never have verbs". Declaring them is wp11's job.
 *
 * Shrinking this list is the point. Adding to it requires the same justification a
 * `route.exempt` needs, and the test prints the exact key to add or remove.
 */
const UNDECLARED_ROUTES_2026_08_28: readonly string[] = [
  "GET /api/codex-auth/quota",
  "GET /api/request-history",
  "GET /api/request-history/{id}",
  "GET /api/system/health",
  "GET /api/system/windows-replace-retries",
  "GET /api/update/badge",
  "PATCH /api/codex-auth/pool-strategy",
  "PATCH /api/oauth/accounts/pool",
  "POST /api/codex-auth/accounts",
  "POST /api/model-discovery/acknowledge",
  "POST /api/stop",
  "POST /api/system/restart",
  "POST /api/windows-tray",
  "PUT /api/codex-auth/failover",
  "PUT /api/disabled-models",
];

describe("capability/route parity is bidirectional", () => {
  test("every management route is capability-covered, exempt, or in the dated ratchet", async () => {
    // The reverse direction. Without it, 139 routes carried no verb and no exemption and the
    // suite stayed green -- which is how `capabilities --route /api/keys` came to return an
    // empty list while `ocx access key` worked.
    const { MANAGEMENT_ROUTES } = await import("../../src/server/management/route-registry");
    const covered = capabilityRouteKeys();
    const ratchet = new Set(UNDECLARED_ROUTES_2026_08_28);
    const unexplained = MANAGEMENT_ROUTES
      .filter(r => {
        const k = `${r.method} ${r.path}`;
        return !covered.has(k) && !r.exempt && !ratchet.has(k);
      })
      .map(r => `${r.method} ${r.path}`);
    expect(unexplained).toEqual([]);
  });

  test("the ratchet only shrinks: every listed route is still unexplained", async () => {
    // A stale entry is as bad as a missing one. Once a route gains a capability or an
    // exemption it must leave this list, or the count stops being evidence of progress.
    const { MANAGEMENT_ROUTES } = await import("../../src/server/management/route-registry");
    const covered = capabilityRouteKeys();
    const byKey = new Map(MANAGEMENT_ROUTES.map(r => [`${r.method} ${r.path}`, r] as const));
    const stale = UNDECLARED_ROUTES_2026_08_28.filter(k => {
      const route = byKey.get(k);
      if (!route) return true;
      return covered.has(k) || Boolean(route.exempt);
    });
    expect(stale).toEqual([]);
  });

  test("desktop snapshot has an explicit internal exemption, not an operator CLI verb", async () => {
    // Only the Tauri shell holds signed-updater state; a CLI verb could only forge it.
    const { MANAGEMENT_ROUTES } = await import("../../src/server/management/route-registry");
    const row = MANAGEMENT_ROUTES.find(r => r.method === "POST"
      && r.path === "/api/update/desktop-snapshot");
    expect(row?.exempt?.reason).toBe("desktop-internal");
    expect(capabilityRouteKeys().has("POST /api/update/desktop-snapshot")).toBe(false);
  });
});
