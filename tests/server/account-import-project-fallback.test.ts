/**
 * #7382 / #7385: an operator-supplied Cockpit `project_id` is a fallback for an Antigravity account
 * whose Cloud Code Assist project is not auto-discovered. It is admitted only through a bounded
 * schema and an account-bound probe with the freshly validated token, discovery always wins, and
 * every failure or cancellation path persists nothing. All provider calls are fakes.
 */
import { describe, expect, test } from "bun:test";
import { createAntigravityAccountImportAdapter, verifyAntigravityImportProject, type AntigravityImportAdapterDeps } from "../../src/oauth/account-import/google-antigravity-adapter";
import { setAntigravityAccountQuotaTransportForTests } from "../../src/providers/quota/antigravity";
import { parseCockpitAccountDocument } from "../../src/oauth/account-import/parser";
import { importAccounts } from "../../src/oauth/account-import/service";
import { ACCOUNT_IMPORT_FORMAT, ACCOUNT_IMPORT_PROVIDER, type ValidatedAntigravityCredential } from "../../src/oauth/account-import/types";
import type { OAuthCredentials } from "../../src/oauth/types";

const CANARY = "cockpit-canary-refresh-token-DO-NOT-LEAK";

function credential(overrides: Partial<ValidatedAntigravityCredential> = {}): ValidatedAntigravityCredential {
  return { access: "access-for-user", refresh: CANARY, expires: Date.now() + 60_000, email: "user@example.com", ...overrides };
}

function harness(deps: Partial<AntigravityImportAdapterDeps> & { discovered?: string }) {
  const writes: OAuthCredentials[] = [];
  const probes: Array<{ accessToken: string; projectId: string }> = [];
  const adapter = createAntigravityAccountImportAdapter({
    validate: deps.validate ?? (async () => credential(deps.discovered ? { projectId: deps.discovered } : {})),
    upsert: async value => { writes.push(value); return "inserted"; },
    ...("verifyProject" in deps ? { verifyProject: deps.verifyProject } : {
      verifyProject: async (accessToken: string, projectId: string) => { probes.push({ accessToken, projectId }); return true; },
    }),
  });
  const run = (document: unknown, signal?: AbortSignal) => importAccounts(
    { provider: ACCOUNT_IMPORT_PROVIDER, format: ACCOUNT_IMPORT_FORMAT, document, signal },
    { resolveAdapter: () => ({ ok: true, adapter }) },
  );
  return { writes, probes, run };
}

const doc = (projectId?: unknown) => [{ email: "user@example.com", refresh_token: "refresh-safe", ...(projectId === undefined ? {} : { project_id: projectId }) }];

describe("Cockpit project_id schema", () => {
  test("accepts a bounded Google Cloud project id and carries it to the record", () => {
    expect(parseCockpitAccountDocument(doc("aicode-consumers"))).toEqual({
      ok: true,
      records: [{ index: 0, record: { email: "user@example.com", refreshToken: "refresh-safe", projectId: "aicode-consumers" } }],
    });
    expect(parseCockpitAccountDocument(doc("a".repeat(30))).ok).toBe(true);
  });

  test("rejects wrong types, blanks, padding, oversize and malformed ids as invalid records", () => {
    for (const bad of [42, null, true, ["aicode-consumers"], { id: "aicode-consumers" }, "", "      ", " aicode-consumers",
      "aicode-consumers\n", "a".repeat(31), "short", "Aicode-consumers", "1aicode", "aicode-", "aicode_consumers", "org.com:aicode"]) {
      const parsed = parseCockpitAccountDocument(doc(bad));
      expect(parsed).toEqual({ ok: true, records: [{ index: 0, code: "invalid_record" }] });
    }
  });
});

describe("Antigravity import project fallback", () => {
  test("admits a probed fallback project and persists it through the import service", async () => {
    const h = harness({});
    const result = await h.run(doc("aicode-consumers"));
    expect(result).toMatchObject({ ok: true, result: { importedCount: 1, failedCount: 0 } });
    expect(h.probes).toEqual([{ accessToken: "access-for-user", projectId: "aicode-consumers" }]);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ projectId: "aicode-consumers", email: "user@example.com", source: "credential-file" });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  test("automatic discovery takes precedence and never probes the fallback", async () => {
    const h = harness({ discovered: "discovered-project" });
    expect(await h.run(doc("aicode-consumers"))).toMatchObject({ ok: true, result: { importedCount: 1 } });
    expect(h.probes).toEqual([]);
    expect(h.writes[0]?.projectId).toBe("discovered-project");
  });

  test("a refused or throwing probe fails missing_project and writes nothing", async () => {
    for (const verifyProject of [async () => false, async () => { throw new Error(`probe echoed ${CANARY}`); }]) {
      const h = harness({ verifyProject });
      const result = await h.run(doc("aicode-consumers"));
      expect(result).toMatchObject({ ok: true, result: { failedCount: 1, results: [{ index: 0, status: "failed", code: "missing_project" }] } });
      expect(h.writes).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
  });

  test("without a fallback or without a probe owner, discovery failure stays missing_project", async () => {
    const noFallback = harness({});
    expect(await noFallback.run(doc())).toMatchObject({ ok: true, result: { results: [{ code: "missing_project" }] } });
    expect(noFallback.probes).toEqual([]);
    expect(noFallback.writes).toEqual([]);

    const noOwner = harness({ verifyProject: undefined });
    expect(await noOwner.run(doc("aicode-consumers"))).toMatchObject({ ok: true, result: { results: [{ code: "missing_project" }] } });
    expect(noOwner.writes).toEqual([]);
  });

  test("an invalid project_id is rejected before validation, probing or writing", async () => {
    let validations = 0;
    const h = harness({ validate: async () => { validations += 1; return credential(); } });
    expect(await h.run(doc(" aicode-consumers"))).toMatchObject({ ok: true, result: { results: [{ code: "invalid_record" }] } });
    expect(validations).toBe(0);
    expect(h.probes).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  test("cancellation during the probe returns import_cancelled and writes nothing, even if the probe admits", async () => {
    const controller = new AbortController();
    const h = harness({ verifyProject: async () => { controller.abort(); return true; } });
    expect(await h.run(doc("aicode-consumers"), controller.signal)).toEqual({ ok: false, status: 408, code: "import_cancelled" });
    expect(h.writes).toEqual([]);
  });
});

describe("real project verifier honors import cancellation", () => {
  const resolveAddresses = async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 as const }], privateNetwork: false });

  test("an already-cancelled import sends no probe request", async () => {
    const urls: string[] = [];
    setAntigravityAccountQuotaTransportForTests({ resolveAddresses, pinnedPost: async url => { urls.push(url); return new Response("{}", { status: 200 }); } });
    try {
      const controller = new AbortController();
      controller.abort();
      expect(await verifyAntigravityImportProject("access-for-user", "aicode-consumers", controller.signal)).toBe(false);
      expect(urls).toEqual([]);
    } finally { setAntigravityAccountQuotaTransportForTests(null); }
  });

  test("cancelling mid-probe aborts the request and skips the retry and models fallback", async () => {
    const urls: string[] = [];
    const controller = new AbortController();
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses,
      pinnedPost: async (url, _pinned, _body, signal) => {
        urls.push(url);
        controller.abort();
        if (signal?.aborted) throw signal.reason;
        return new Response("{}", { status: 200 });
      },
    });
    try {
      expect(await verifyAntigravityImportProject("access-for-user", "aicode-consumers", controller.signal)).toBe(false);
      expect(urls).toHaveLength(1);
    } finally { setAntigravityAccountQuotaTransportForTests(null); }
  });
});
