/**
 * OCX-6 on the CLI side of a Remote Link Child:
 *
 * - `ocx sync` restarts the client runtime only when it started before the recorded apply, and
 *   never starts one that was not running (apply -> restart -> recorded timestamps);
 * - `ocx restart` asks a client runtime only while its rollback still fits inside the CLI's
 *   observation window, and reports a supervised refusal as "not performed, runtime kept";
 * - the shape of the `ocx status --json` fields a peer compares.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRestartMessage, restartRuntimeAfterApply, type ApplyRestartDeps } from "../../src/cli/link-apply-restart";
import { requestBoundSystemRestart } from "../../src/cli/system-restart-client";
import { reportRestartFailure } from "../../src/cli/restart-failure";
import { collectAppliedCodexSettingsStatus } from "../../src/cli/status-codex-settings";
import { recordHomeCodexSettings, type HomeCodexSettingsRecord } from "../../src/client/link-home";
import type { HomeCodexSettingsDocument } from "../../src/link/codex-settings";
import {
  createLocalAttestationProof,
  createLocalAttestationSecret,
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
} from "../../src/lib/local-management-attestation";
import { CLIENT_RESTART_REQUEST_MIN_REMAINING_MS, SYSTEM_RESTART_PATH } from "../../src/lib/system-restart-contract";
import type { LiveProxy } from "../../src/server/proxy-liveness";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINK_ID = `lnk_${"e".repeat(16)}`;
const child: LiveProxy = { pid: 5151, port: 10100, hostname: "127.0.0.1", source: "runtime", role: "client" };
const document: HomeCodexSettingsDocument = {
  version: 1,
  home: { name: "home-box", version: "2.91.0" },
  settings: { fastMode: true, multiAgentMode: "v1", webSearchSidecarEnabled: false, subagentDefaults: null },
};
const APPLIED = "2026-10-21T01:00:00.000Z";
const record: HomeCodexSettingsRecord = { linkId: LINK_ID, fetchedAt: APPLIED, appliedAt: APPLIED, document };

let root = "";
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-apply-restart-"));
  process.env.OPENCODEX_HOME = root;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

function deps(startedAt: number | null, overrides: Partial<ApplyRestartDeps> = {}) {
  const calls: string[] = [];
  const value: ApplyRestartDeps = {
    findLive: async () => child,
    readStartedAt: async () => startedAt,
    restart: async startWhenStopped => {
      calls.push("restart");
      // The callback starts nothing on a first observation and recovers a vanished runtime.
      calls.push(`first:${(await startWhenStopped(false)).status}`);
      calls.push(`recovering:${(await startWhenStopped(true)).status}`);
      return true;
    },
    recoveryStart: async recovering => { calls.push(`recoveryStart:${recovering}`); return { status: "started" }; },
    connectionUnchanged: () => true,
    ...overrides,
  };
  return { value, calls };
}

describe("ocx sync restarts the runtime after an apply", () => {
  test("apply -> restart -> the restarted runtime reads as current, so the next sync does nothing", async () => {
    const appliedAt = Date.parse(APPLIED);
    const stale = deps(appliedAt - 60_000);
    expect(await restartRuntimeAfterApply(record, stale.value)).toEqual({ kind: "restarted" });
    expect(stale.calls).toEqual(["restart", "first:skipped", "recoveryStart:true", "recovering:started"]);

    const fresh = deps(appliedAt + 5_000);
    expect(await restartRuntimeAfterApply(record, fresh.value)).toEqual({ kind: "current" });
    expect(fresh.calls).toEqual([]);
  });

  test("a runtime that reports no start time cannot prove it is current and is restarted", async () => {
    const { value, calls } = deps(null);
    expect(await restartRuntimeAfterApply(record, value)).toEqual({ kind: "restarted" });
    expect(calls[0]).toBe("restart");
  });

  test("nothing running, or a standalone proxy answering, starts nothing", async () => {
    for (const live of [null, { ...child, role: undefined }]) {
      const { value, calls } = deps(0, { findLive: async () => live });
      expect(await restartRuntimeAfterApply(record, value)).toEqual({ kind: "not-running" });
      expect(calls).toEqual([]);
    }
  });

  test("a changed connection or a failed restart is reported, never hidden", async () => {
    const changed = deps(0, { connectionUnchanged: () => false });
    expect(await restartRuntimeAfterApply(record, changed.value)).toEqual({ kind: "connection-changed" });
    expect(changed.calls).toEqual([]);
    const failed = deps(0, { restart: async () => false });
    const outcome = await restartRuntimeAfterApply(record, failed.value);
    expect(outcome).toEqual({ kind: "failed" });
    expect(applyRestartMessage(outcome)).toContain("the previous runtime keeps serving");
  });
});

function clientHealthDeps(postResponse: Response) {
  const secret = createLocalAttestationSecret();
  const posts: string[] = [];
  return {
    posts,
    deps: {
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/healthz")) {
          const challenge = new Headers(init?.headers).get(LOCAL_ATTESTATION_CHALLENGE_HEADER)!;
          return new Response(JSON.stringify({
            status: "ok", service: "opencodex", version: "test", uptime: 1, pid: child.pid, port: child.port,
            role: "client", restartCapability: "v1", startedAt: APPLIED,
          }), { headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: createLocalAttestationProof(secret, challenge, child.pid!, child.port)! } });
        }
        posts.push(url);
        return postResponse.clone();
      }) as typeof fetch,
      readRuntime: () => ({ pid: child.pid!, port: child.port, hostname: "127.0.0.1", attestationSecret: secret }),
      findLive: async () => child,
      createChallenge: () => "A".repeat(43),
      now: () => 1_000,
      cliVersion: "test",
    },
  };
}

describe("ocx restart against a client runtime", () => {
  test("a request that would leave the rollback too little time is refused before it is sent", async () => {
    const { deps: d, posts } = clientHealthDeps(new Response(null, { status: 202 }));
    const outcome = await requestBoundSystemRestart(child, 1_000 + CLIENT_RESTART_REQUEST_MIN_REMAINING_MS - 1, d);
    expect(outcome).toMatchObject({ accepted: false, uncertain: false });
    expect(outcome.accepted ? "" : (outcome.error as Error).message).toBe("restart_deadline_expired");
    expect(posts).toEqual([]);
  });

  test("in time, the request is sent; a supervised refusal comes back as its own code", async () => {
    const supervised = new Response(JSON.stringify({ success: false, error: { code: "restart_supervised", supervisor: "service" } }), { status: 409 });
    const { deps: d, posts } = clientHealthDeps(supervised);
    const outcome = await requestBoundSystemRestart(child, 1_000 + CLIENT_RESTART_REQUEST_MIN_REMAINING_MS, d);
    expect(posts).toEqual([`http://127.0.0.1:${child.port}${SYSTEM_RESTART_PATH}`]);
    expect(outcome.accepted ? "" : (outcome.error as Error).message).toBe("restart_supervised_service");

    const other = clientHealthDeps(new Response(JSON.stringify({ success: false, error: "Restart target identity changed." }), { status: 409 }));
    const generic = await requestBoundSystemRestart(child, 1_000 + CLIENT_RESTART_REQUEST_MIN_REMAINING_MS, other.deps);
    expect(generic.accepted ? "" : (generic.error as Error).message).toBe("restart_request_http_409");
  });

  test("the supervised refusal says the runtime was kept and how to restart it", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      reportRestartFailure({ ok: false, phase: "request", error: new Error("restart_supervised_service") });
      reportRestartFailure({ ok: false, phase: "request", error: new Error("restart_supervised_desktop") });
    } finally {
      console.error = original;
    }
    expect(lines).toEqual([
      "Restart not performed; the running client runtime was kept. Its background service owns it: run `ocx service restart`.",
      "Restart not performed; the running client runtime was kept. The OpenCodex desktop app owns it: restart it from the app.",
    ]);
  });
});

describe("ocx status --json OCX-6 fields (shape snapshot)", () => {
  const homeConfig = { fastMode: true, multiAgentMode: "v1", webSearchSidecar: { enabled: false } } as unknown as OcxConfig;
  const childConfig = {
    runtimeRole: "client",
    client: { transport: "link", link: { linkId: LINK_ID, tunnelPort: 23457 } },
  } as unknown as OcxConfig;

  test("a Home publishes the digest of its own values and no Child times", async () => {
    expect(await collectAppliedCodexSettingsStatus(homeConfig, null)).toEqual({
      appliedCodexSettingsDigest: "57c751eff89844f93db71a6ee4acdac03afbc29fec52734ade80a40193e826cd",
      lastApplyAt: null,
      runtimeStartedAt: null,
    });
  });

  test("a Child reports its recorded apply and its runtime's start, as epoch ms", async () => {
    expect(await collectAppliedCodexSettingsStatus(childConfig, child, { readStartedAt: async () => 1_761_008_405_000 })).toEqual({
      appliedCodexSettingsDigest: null, lastApplyAt: null, runtimeStartedAt: 1_761_008_405_000,
    });
    recordHomeCodexSettings(LINK_ID, { source: "home", document, fetchedAt: APPLIED }, () => new Date(APPLIED));
    expect(await collectAppliedCodexSettingsStatus(childConfig, child, { readStartedAt: async () => Date.parse(APPLIED) + 9_000 })).toEqual({
      // Same values as the Home above: the digests agree.
      appliedCodexSettingsDigest: "57c751eff89844f93db71a6ee4acdac03afbc29fec52734ade80a40193e826cd",
      lastApplyAt: Date.parse(APPLIED),
      runtimeStartedAt: Date.parse(APPLIED) + 9_000,
    });
    expect(await collectAppliedCodexSettingsStatus(childConfig, null)).toMatchObject({ runtimeStartedAt: null });
  });

  test("a hub client applies no Home settings", async () => {
    const hubClient = { runtimeRole: "client", client: { transport: "hub" } } as unknown as OcxConfig;
    expect(await collectAppliedCodexSettingsStatus(hubClient, null)).toEqual({
      appliedCodexSettingsDigest: null, lastApplyAt: null, runtimeStartedAt: null,
    });
  });
});
