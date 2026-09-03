import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITIES,
  HEAD_CAPABILITIES,
  capabilitiesForRoute,
  capabilityInvocation,
  capabilityRouteKeys,
} from "../src/cli/capabilities";
import { CLI_COMMANDS, findCommand } from "../src/cli/registry";
import { runCapabilities } from "../src/cli/capabilities-command";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.log = original; } };
}

describe("capability table is a leaf data module", () => {
  test("capabilities.ts imports nothing from src/cli", () => {
    // Each command module declares `const USAGE` at top level, evaluated at import time.
    // A cycle back into this table resolves to `undefined` under ESM instead of throwing,
    // which would silently empty the usage text that rejectArgs hands CliUsageError --
    // a degraded failure in the exact surface these issues are about.
    const src = readFileSync(join(repoRoot, "src/cli/capabilities.ts"), "utf8");
    const relative = src.match(/from\s+["']\.[^"']*["']/g) ?? [];
    expect(relative).toEqual([]);
    expect(/\bimport\s*\(/.test(src)).toBe(false);
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

  test("a capability declaring routes marks mutation consistently", () => {
    // A capability that drives only GETs must not claim to mutate, and one driving a
    // write must not claim otherwise -- the flag is what --mutating-only filters on.
    const wrong: string[] = [];
    for (const cap of CAPABILITIES) {
      if (cap.routes.length === 0) continue;
      const anyWrite = cap.routes.some(r => r.method !== "GET");
      if (anyWrite !== cap.mutates) wrong.push(capabilityInvocation(cap));
    }
    expect(wrong).toEqual([]);
  });

  test("head-handled surfaces are NOT registry commands", () => {
    // tests/cli-registry.test.ts excludes help/--help/-h as head-handled pseudo-cases,
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

  test("--route accepts the flag in any argv position", async () => {
    // Order-independence is the point: positional flag reading is why
    // `ocx restore back --json` silently ignored its flag.
    const cap = captureStdout();
    let code: number;
    try { code = await runCapabilities(["--json", "--route", "/api/usage"]); } finally { cap.restore(); }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.lines.join("\n")) as { capabilities: { invocation: string }[] };
    expect(parsed.capabilities.map(c => c.invocation)).toEqual(["ocx usage"]);
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
    const { MANAGEMENT_ROUTES } = await import("../src/server/management/route-registry");
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
  "DELETE /api/codex-auth/accounts",
  "DELETE /api/combos",
  "DELETE /api/custom-models/{id}",
  "DELETE /api/keys",
  "DELETE /api/oauth/accounts",
  "DELETE /api/providers",
  "DELETE /api/providers/keys",
  "DELETE /api/routing-profiles",
  "GET /api/aliases",
  "GET /api/claude-code",
  "GET /api/claude-desktop",
  "GET /api/claude/inbound-debug",
  "GET /api/client-integrations",
  "GET /api/client-integrations/journal",
  "GET /api/client-integrations/{clientId}",
  "GET /api/codex-auth/login-status",
  "GET /api/codex-auth/quota",
  "GET /api/codex-auth/reset-credits",
  "GET /api/combos",
  "GET /api/custom-models",
  "GET /api/debug",
  "GET /api/debug/injection-logs",
  "GET /api/debug/logs",
  "GET /api/debug/usage-logs",
  "GET /api/diagnostics/project-config",
  "GET /api/effort-caps",
  "GET /api/grok",
  "GET /api/injection-model",
  "GET /api/keys",
  "GET /api/model-discovery",
  "GET /api/model-presets",
  "GET /api/models",
  "GET /api/native-main-profiles",
  "GET /api/native-main-profiles/doctor",
  "GET /api/oauth/accounts",
  "GET /api/oauth/providers",
  "GET /api/oauth/status",
  "GET /api/provider-context-caps",
  "GET /api/provider-presets",
  "GET /api/provider-quotas",
  "GET /api/providers",
  "GET /api/providers/keys",
  "GET /api/request-history",
  "GET /api/request-history/{id}",
  "GET /api/request-history/{id}/route-decision",
  "GET /api/routing-profiles",
  "GET /api/selected-models",
  "GET /api/settings",
  "GET /api/shadow-call-settings",
  "GET /api/sidecar-settings",
  "GET /api/startup-health",
  "GET /api/storage/codex-logs",
  "GET /api/subagent-model-fallback",
  "GET /api/subagent-models",
  "GET /api/system/health",
  "GET /api/system/memory",
  "GET /api/system/windows-replace-retries",
  "GET /api/update/badge",
  "GET /api/update/check",
  "GET /api/update/status",
  "GET /api/v2",
  "PATCH /api/codex-auth/pool-strategy",
  "PATCH /api/keys",
  "PATCH /api/oauth/accounts/pool",
  "PATCH /api/providers",
  "POST /api/claude-desktop/apply",
  "POST /api/client-integrations/restore",
  "POST /api/codex-auth/accounts",
  "POST /api/codex-auth/accounts/clear-cooldown",
  "POST /api/codex-auth/login",
  "POST /api/codex-auth/login/cancel",
  "POST /api/codex-auth/login/code",
  "POST /api/codex-auth/reset-credits/consume",
  "POST /api/custom-models",
  "POST /api/grok/apply",
  "POST /api/keys",
  "POST /api/model-discovery/acknowledge",
  "POST /api/native-main-profiles/recover",
  "POST /api/native-main-profiles/register",
  "POST /api/native-main-profiles/stage",
  "POST /api/native-main-profiles/stage/cancel",
  "POST /api/native-main-profiles/stage/finish",
  "POST /api/native-main-profiles/stage/heartbeat",
  "POST /api/native-main-profiles/switch",
  "POST /api/oauth/accounts/clear-cooldown",
  "POST /api/oauth/accounts/import",
  "POST /api/oauth/login",
  "POST /api/oauth/login/cancel",
  "POST /api/oauth/login/code",
  "POST /api/oauth/logout",
  "POST /api/providers",
  "POST /api/providers/keys",
  "POST /api/providers/test",
  "POST /api/routing-profiles/dry-run",
  "POST /api/startup-action",
  "POST /api/stop",
  "POST /api/storage/codex-logs/compact",
  "POST /api/storage/codex-logs/protect",
  "POST /api/storage/codex-logs/repair",
  "POST /api/storage/codex-logs/unprotect",
  "POST /api/sync",
  "POST /api/system/restart",
  "POST /api/update/run",
  "POST /api/windows-tray",
  "PUT /api/claude-code",
  "PUT /api/claude-desktop",
  "PUT /api/client-integrations/{clientId}",
  "PUT /api/codex-auth/accounts/alias",
  "PUT /api/codex-auth/accounts/priority",
  "PUT /api/codex-auth/active",
  "PUT /api/codex-auth/auto-switch",
  "PUT /api/codex-auth/failover",
  "PUT /api/combos",
  "PUT /api/custom-models/{id}",
  "PUT /api/debug",
  "PUT /api/default-aliases",
  "PUT /api/disabled-models",
  "PUT /api/effort-caps",
  "PUT /api/grok/selection",
  "PUT /api/injection-model",
  "PUT /api/model-discovery",
  "PUT /api/model-presets",
  "PUT /api/model-visibility",
  "PUT /api/oauth/accounts/active",
  "PUT /api/oauth/accounts/alias",
  "PUT /api/provider-context-caps",
  "PUT /api/providers/keys/active",
  "PUT /api/providers/keys/alias",
  "PUT /api/providers/{provider}/alias",
  "PUT /api/providers/{provider}/model-aliases",
  "PUT /api/routing-profiles",
  "PUT /api/selected-models",
  "PUT /api/settings",
  "PUT /api/shadow-call-settings",
  "PUT /api/sidecar-settings",
  "PUT /api/subagent-model-fallback",
  "PUT /api/subagent-models",
  "PUT /api/v2",
];

describe("capability/route parity is bidirectional", () => {
  test("every management route is capability-covered, exempt, or in the dated ratchet", async () => {
    // The reverse direction. Without it, 139 routes carried no verb and no exemption and the
    // suite stayed green -- which is how `capabilities --route /api/keys` came to return an
    // empty list while `ocx access key` worked.
    const { MANAGEMENT_ROUTES } = await import("../src/server/management/route-registry");
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
    const { MANAGEMENT_ROUTES } = await import("../src/server/management/route-registry");
    const covered = capabilityRouteKeys();
    const byKey = new Map(MANAGEMENT_ROUTES.map(r => [`${r.method} ${r.path}`, r] as const));
    const stale = UNDECLARED_ROUTES_2026_08_28.filter(k => {
      const route = byKey.get(k);
      if (!route) return true;
      return covered.has(k) || Boolean(route.exempt);
    });
    expect(stale).toEqual([]);
  });
});
