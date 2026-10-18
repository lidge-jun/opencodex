import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServeOptions } from "../../src/server/index/serve-options";
import { reasoningArchiveErrorResponse } from "../../src/server/responses/reasoning-archive-error";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainCompactionResponseState, installCompactionRoutingAclFixture,
  keyProviderConfig, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";

installCompactionRoutingAclFixture();
const previousHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
let releaseSpendHome: () => void;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-archive-http-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  try { await drainCompactionResponseState(); } finally {
    releaseSpendHome();
    await removeCompactionFixture(home);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

// Exercise the production HTTP router and handlers without opening a listener. Only ingress,
// package integrity and outer turn admission are fixture seams; retention and its SQLite lock run.
function publicFetch(config: ReturnType<typeof keyProviderConfig>) {
  const options = createServeOptions({
    config, deps: {}, managementApiDeps: {},
    ingressForServer: () => "public",
    packageTreeIntegrity: { status: () => ({ ok: true }) },
    runAdmittedHttpTurn: (_req: Request, _policy: unknown, work: () => Promise<Response>) => work(),
  } as unknown as Parameters<typeof createServeOptions>[0]);
  const server = { timeout() {} } as unknown as Parameters<typeof options.fetch>[1];
  return (req: Request) => options.fetch(req, server);
}

describe("reasoning archive public HTTP refusal", () => {
  test("unrelated exceptions retain their existing handling", () => {
    expect(reasoningArchiveErrorResponse(new Error("unrelated failure"))).toBeUndefined();
  });
  for (const [v1, stream] of [[true, false], [false, false], [false, true]]) {
    test.each(["quota", "busy", "io", "write"] as const)(`v${v1 ? 1 : 2} stream=${stream} %s is safe, actionable and sends nothing`, async kind => {
      const dir = join(home, "reasoning-archive");
      mkdirSync(dir);
      writeFileSync(join(dir, "prior.md"), "preserved old archive");
      let lock: Database | undefined;
      if (kind === "quota") {
        for (let i = 1; i < 256; i++) writeFileSync(join(dir, `prior-${i}.md`), "");
      } else if (kind === "busy") {
        lock = new Database(`${dir}.lock`, { create: true });
        lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      } else if (kind === "io") {
        mkdirSync(join(dir, "foreign-directory"));
      }
      const before = readdirSync(dir).sort();
      const config = keyProviderConfig();
      config.reasoningRetention = { enabled: true, maxTokens: 1 };
      config.compactionRecovery = { enabled: true, model: "backup/other" };
      config.providers.backup = { ...config.providers.gw! };
      let sends = 0;
      const mock = (async () => { sends++; throw new Error("unexpected upstream send"); }) as typeof fetch;
      globalThis.fetch = mock;
      for (const provider of Object.values(config.providers)) Object.assign(provider, { fetch: mock, upstreamWebsocket: false });
      const body = { model: "gw/some-model", stream, input: [
        { type: "message", role: "user", content: "continue" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "private retained reasoning" }],
          encrypted_content: "private-provider-signature" },
        ...(!v1 ? [{ type: "compaction_trigger" }] : []),
      ] };
      const original = structuredClone(body);
      const originalWrite = fs.writeFileSync;
      const write = kind === "write" ? spyOn(fs, "writeFileSync").mockImplementation((path, ...args) => {
        if (typeof path === "number") {
          originalWrite(path, "partial");
          throw new Error(`fixture ENOSPC ${dir} private-provider-signature`);
        }
        return originalWrite(path, ...args);
      }) : undefined;
      try {
        const response = await publicFetch(config)(new Request(`http://localhost/v1/responses${v1 ? "/compact" : ""}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        }));
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBeNull();
        const text = await response.text();
        const json = JSON.parse(text);
        const code = kind === "quota" ? "reasoning_archive_quota_exceeded"
          : kind === "busy" ? "reasoning_archive_busy" : "reasoning_archive_unavailable";
        expect(json.error).toMatchObject({ type: "server_error", code });
        expect(json.error.message).toContain(kind === "quota" ? "manually" : kind === "busy" ? "retry" : "permissions");
        for (const secret of [home, dir, "prior.md", "foreign-directory", "private retained reasoning", "private-provider-signature", "test-key"])
          expect(text).not.toContain(secret);
        expect(sends).toBe(0);
        expect(body).toEqual(original);
        expect(readdirSync(dir).sort()).toEqual(before);
        expect(readFileSync(join(dir, "prior.md"), "utf8")).toBe("preserved old archive");
      } finally { write?.mockRestore(); lock?.close(); }
    });
  }
});
