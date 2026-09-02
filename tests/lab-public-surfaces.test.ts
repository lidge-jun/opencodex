import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLabCommand } from "../src/cli/lab";
import {
  labExportDir,
  labPublicPublisherKeyPath,
  persistConformanceResult,
  rebuildLabProjection,
} from "../src/lab";
import { labCommunityDir } from "../src/lab/paths";
import { createArtifactStore } from "../src/lab/artifacts/store";
import { resolveProtocolExecutionContext } from "../src/lab/conformance/executor";
import { discoverScenarios, loadCaseAuthority } from "../src/lab/conformance/manifest";
import type { CaseRecord } from "../src/lab/conformance/types";
import { queryLabObservations } from "../src/lab/query";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const HOMES: string[] = [];

afterEach(() => {
  for (const home of HOMES.splice(0)) removeTreeWithRetry(home);
  delete process.env.OPENCODEX_HOME;
});

function tempHome(): string {
  const home = join(tmpdir(), `ocx-cl10-surfaces-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  HOMES.push(home);
  return home;
}

function syntheticPassResult(caseRecord: CaseRecord) {
  return {
    scenarioId: caseRecord.id,
    suite: caseRecord.suite,
    passed: true,
    classification: "inconclusive" as const,
    assertionResults: caseRecord.assertions.map((assertion) => ({
      id: assertion.id,
      operator: assertion.operator,
      required: assertion.required,
      passed: true,
      observedSummary: "PRIVATE-CANARY-OBSERVED",
    })),
    diagnostics: ["PRIVATE-CANARY-DIAGNOSTIC"],
    executionContext: resolveProtocolExecutionContext(caseRecord),
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_000,
  };
}

function seedProtocolProjection(home: string): string {
  const authority = loadCaseAuthority();
  const scenario = discoverScenarios(authority, ["responses-core"])
    .find((candidate) => candidate.id === "responses-core.protocol.request-shape")
    ?? discoverScenarios(authority, ["responses-core"])[0];
  if (!scenario) throw new Error("no responses-core protocol scenario available");
  const store = createArtifactStore(join(home, "lab", "artifacts"));
  try {
    persistConformanceResult(syntheticPassResult(scenario), scenario, authority, {
      configDir: home,
      recordedAt: 1_700_000_001_100,
      artifactStore: store,
    });
  } finally {
    store.close();
  }
  rebuildLabProjection(home);
  const rows = queryLabObservations(
    { layer: "protocol_conformance", scenarioId: scenario.id },
    undefined,
    10,
    home,
  );
  const eventId = rows.items[0]?.eventId;
  if (!eventId) throw new Error("seeded observation missing");
  return eventId;
}

function config(home: string): OcxConfig {
  void home;
  return { port: 0, defaultProvider: "openai-apikey", providers: {} } as OcxConfig;
}

async function api(
  home: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  process.env.OPENCODEX_HOME = home;
  const req = new ManagementRequest(`http://127.0.0.1${path}`, {
    method: init.method ?? "GET",
    ...(init.body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }
      : {}),
  });
  const response = await handleManagementAPI(req, new URL(req.url), config(home), {
    refreshCodexCatalog: async () => {},
  });
  expect(response).not.toBeNull();
  return response!;
}

async function captureCli(argv: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { stdout.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { stderr.push(args.join(" ")); };
  try {
    return {
      code: await handleLabCommand(argv, { configDir: home }),
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function installNetworkCanary(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("CL10-NETWORK-CANARY");
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

describe("CL-10 CLI local public evidence", () => {
  test("preview is network-free, identifier-safe, and does not create publisher or export state", async () => {
    const home = tempHome();
    const eventId = seedProtocolProjection(home);
    const unknownEventId = "0".repeat(64);
    const restoreFetch = installNetworkCanary();
    try {
      const result = await captureCli([
        "public", "preview", "--event", eventId, "--event", unknownEventId, "--json",
      ], home);
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout) as {
        bundle: { records: unknown[]; publisher?: unknown };
        excluded: Array<{ selectionIndex: number; reason: string; eventId?: string }>;
      };
      expect(body.bundle.records).toHaveLength(1);
      expect(body.bundle).not.toHaveProperty("publisher");
      expect(body.excluded).toEqual([{ selectionIndex: 1, reason: "event_not_found" }]);
      expect(body.excluded[0]).not.toHaveProperty("eventId");
      expect(result.stdout).not.toContain(eventId);
      expect(result.stdout).not.toContain(unknownEventId);
      expect(existsSync(labPublicPublisherKeyPath(home))).toBe(false);
      expect(existsSync(labExportDir(home)) ? readdirSync(labExportDir(home)) : []).toEqual([]);
      expect(result.stdout).not.toContain("PRIVATE-CANARY");
    } finally {
      restoreFetch();
    }
  });

  test("explicit export signs and stores, then verify/import/community remain local", async () => {
    const home = tempHome();
    const eventId = seedProtocolProjection(home);
    const restoreFetch = installNetworkCanary();
    try {
      const exported = await captureCli(["public", "export", "--event", eventId, "--json"], home);
      expect(exported.code).toBe(0);
      const exportBody = JSON.parse(exported.stdout) as {
        bundle: { bundleId: string; publisher: { keyId: string } };
        stored: { path: string; created: boolean };
      };
      expect(exportBody.bundle.publisher.keyId).toMatch(/^[0-9a-f]{64}$/);
      expect(exportBody.stored).toEqual({ path: "<private>", created: true });
      expect(exported.stdout).not.toContain(home);
      const privateExportPath = join(labExportDir(home), `${exportBody.bundle.bundleId}.json`);
      expect(existsSync(privateExportPath)).toBe(true);

      const verified = await captureCli(["public", "verify", "--file", privateExportPath, "--json"], home);
      expect(verified.code).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        status: "cryptographically_valid",
        bundleId: exportBody.bundle.bundleId,
        publisherKeyId: exportBody.bundle.publisher.keyId,
        locallyVerified: false,
      });

      const ledgerBefore = readFileSync(join(home, "lab", "compatibility.jsonl"));
      const sqliteBefore = readFileSync(join(home, "lab", "compatibility.sqlite"));
      const imported = await captureCli(["public", "import", "--file", privateExportPath, "--json"], home);
      expect(imported.code).toBe(0);
      const importedBody = JSON.parse(imported.stdout) as Record<string, unknown>;
      expect(importedBody).toMatchObject({
        status: "cryptographically_valid",
        trustClass: "community_untrusted_v1",
        bundleId: exportBody.bundle.bundleId,
      });
      expect(importedBody).not.toHaveProperty("path");
      expect(imported.stdout).not.toContain(home);
      expect(readFileSync(join(home, "lab", "compatibility.jsonl")).equals(ledgerBefore)).toBe(true);
      expect(readFileSync(join(home, "lab", "compatibility.sqlite")).equals(sqliteBefore)).toBe(true);

      const community = await captureCli(["public", "community", "--json"], home);
      expect(community.code).toBe(0);
      const communityBody = JSON.parse(community.stdout) as { evidence: Array<{ bundleId: string; trustClass: string }> };
      expect(communityBody.evidence).toEqual([
        expect.objectContaining({ bundleId: exportBody.bundle.bundleId, trustClass: "community_untrusted_v1" }),
      ]);
    } finally {
      restoreFetch();
    }
  });

  test("has no publish command", async () => {
    const home = tempHome();
    const result = await captureCli(["public", "publish", "--json"], home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown public subcommand|usage/i);
  });
});

describe("CL-10 management local public evidence", () => {
  test("preview/export/verify/import/community are explicit authenticated local actions", async () => {
    const home = tempHome();
    const eventId = seedProtocolProjection(home);
    const restoreFetch = installNetworkCanary();
    try {
      const preview = await api(home, "/api/lab/public/preview", {
        method: "POST",
        body: { eventIds: [eventId] },
      });
      expect(preview.status).toBe(200);
      const previewBody = await preview.json() as { bundle: { records: unknown[]; publisher?: unknown } };
      expect(previewBody.bundle.records).toHaveLength(1);
      expect(previewBody.bundle).not.toHaveProperty("publisher");
      expect(existsSync(labPublicPublisherKeyPath(home))).toBe(false);

      const exported = await api(home, "/api/lab/public/export", {
        method: "POST",
        body: { eventIds: [eventId] },
      });
      expect(exported.status).toBe(200);
      const exportBody = await exported.json() as {
        bundle: { bundleId: string; publisher: { keyId: string } };
        stored: { path: string; created: boolean };
      };
      expect(exportBody.stored).toEqual({ path: "<private>", created: true });
      expect(JSON.stringify(exportBody)).not.toContain(home);

      const verified = await api(home, "/api/lab/public/verify", {
        method: "POST",
        body: { bundle: exportBody.bundle },
      });
      expect(verified.status).toBe(200);
      expect(await verified.json()).toMatchObject({
        status: "cryptographically_valid",
        bundleId: exportBody.bundle.bundleId,
        locallyVerified: false,
      });

      const ledgerBefore = readFileSync(join(home, "lab", "compatibility.jsonl"));
      const imported = await api(home, "/api/lab/public/community/import", {
        method: "POST",
        body: { bundle: exportBody.bundle },
      });
      expect(imported.status).toBe(200);
      const importedBody = await imported.json() as Record<string, unknown>;
      expect(importedBody).toMatchObject({
        status: "cryptographically_valid",
        trustClass: "community_untrusted_v1",
      });
      expect(importedBody).not.toHaveProperty("path");
      expect(JSON.stringify(importedBody)).not.toContain(home);
      expect(readFileSync(join(home, "lab", "compatibility.jsonl")).equals(ledgerBefore)).toBe(true);

      const community = await api(home, "/api/lab/public/community");
      expect(community.status).toBe(200);
      expect(await community.json()).toMatchObject({
        evidence: [expect.objectContaining({ bundleId: exportBody.bundle.bundleId })],
      });
    } finally {
      restoreFetch();
    }
  });

  test("busy community lock is a prompt retryable service response", async () => {
    const home = tempHome();
    const lockPath = join(labCommunityDir(home), ".mutation-lock");
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        token: "00000000-0000-4000-8000-000000000000",
        createdAt: Date.now(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const startedAt = performance.now();
    const response = await api(home, "/api/lab/public/community");
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toMatchObject({
      error: { code: "community_cache_busy" },
    });
  });

  test("does not expose a remote publish endpoint", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const req = new ManagementRequest("http://127.0.0.1/api/lab/public/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await handleManagementAPI(req, new URL(req.url), config(home), {
      refreshCodexCatalog: async () => {},
    });
    expect(res).toBeNull();
  });
});
