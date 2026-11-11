import { afterEach, expect, test } from "bun:test";
import {
  applyCodexCliUpdate, canApply, CodexCliUpdateError, fetchCodexCliUpdateJob, fetchCodexCliUpdatePlan, isTerminalJob, newCodexCliRequestId, readPlan,
  type CodexCliUpdateJobView, type CodexCliUpdatePlanView,
} from "../src/codex-cli-update-api";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const signal = () => new AbortController().signal;

export const PLAN = {
  schemaVersion: 1, package: "@openai/codex", channel: "latest", applicable: true, refusal: null,
  planId: "0123456789abcdef0123456789abcdef", provenance: "npm-global", managed: true,
  installedVersion: "0.160.0", versionEvidence: "package-json", location: "~/.npm-global/lib/node_modules/@openai/codex",
  targetVersion: "0.163.0", targetIntegrity: "sha512-x", session: { state: "none", matches: 0 },
  installContentDigest: "d", command: ["npm", "install", "-g", "@openai/codex@0.163.0"],
};

const job = (over: Partial<CodexCliUpdateJobView> = {}): CodexCliUpdateJobView =>
  ({ jobId: "11111111-2222-3333-4444-555555555555", status: "running", ownerState: "active", planId: PLAN.planId, reason: null, ...over });

test("the plan DTO is read field by field and a malformed one is refused", async () => {
  expect(readPlan(PLAN)).toMatchObject({ applicable: true, planId: PLAN.planId, provenance: "npm-global", targetVersion: "0.163.0" });
  expect(readPlan({ ...PLAN, provenance: "brew" })).toBeNull();
  globalThis.fetch = (async () => Response.json({ applicable: true })) as unknown as typeof fetch;
  await expect(fetchCodexCliUpdatePlan("http://x", signal())).rejects.toMatchObject({ code: "plan_unavailable" });
});

test("apply posts exactly the shown planId, the request id and confirmed: true", async () => {
  const seen: Array<{ url: string; method?: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json({ job: job({ status: "queued", ownerState: "active" }) }, { status: 202 });
  }) as unknown as typeof fetch;
  const result = await applyCodexCliUpdate("http://x", { requestId: "req-1", planId: PLAN.planId }, signal());
  expect(seen).toEqual([{ url: "http://x/api/codex/cli-update/apply", method: "POST", body: { requestId: "req-1", planId: PLAN.planId, confirmed: true } }]);
  expect(result.status).toBe("queued");
});

test("only admission failures that leave nothing behind may be retried with the same request", async () => {
  const cases: Array<[number, string, boolean]> = [
    [503, "job_store_busy", true], [503, "admission_failed", true],
    [409, "idempotency_conflict", false], [503, "store_full", false], [503, "unsupported_store", false],
    [503, "unsafe_store", false], [400, "invalid_request", false], [403, "local_dashboard_confirmation_required", false],
  ];
  for (const [status, code, retryable] of cases) {
    globalThis.fetch = (async () => Response.json({ error: code }, { status, headers: code === "job_store_busy" ? { "Retry-After": "1" } : {} })) as unknown as typeof fetch;
    const error = await applyCodexCliUpdate("http://x", { requestId: "r", planId: PLAN.planId }, signal()).catch(e => e) as CodexCliUpdateError;
    expect([error.code, error.retryable]).toEqual([code, retryable]);
  }
  globalThis.fetch = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
  const offline = await applyCodexCliUpdate("http://x", { requestId: "r", planId: PLAN.planId }, signal()).catch(e => e) as CodexCliUpdateError;
  expect([offline.code, offline.retryable]).toEqual(["network", true]);
});

test("a missing job record stops polling; an unreadable one may be read again", async () => {
  globalThis.fetch = (async () => Response.json({ error: "job_not_found" }, { status: 404 })) as unknown as typeof fetch;
  expect(await fetchCodexCliUpdateJob("http://x", "id", signal()).catch(e => e)).toMatchObject({ code: "job_not_found", retryable: false });
  globalThis.fetch = (async () => Response.json({ error: "job_state_unavailable" }, { status: 503 })) as unknown as typeof fetch;
  expect(await fetchCodexCliUpdateJob("http://x", "id", signal()).catch(e => e)).toMatchObject({ code: "job_state_unavailable", retryable: true });
});

test("apply is offered only for an applicable, bound, confirmed plan", () => {
  const plan = readPlan(PLAN) as CodexCliUpdatePlanView;
  expect(canApply(plan, true)).toBe(true);
  expect(canApply(plan, false)).toBe(false);
  expect(canApply(null, true)).toBe(false);
  expect(canApply({ ...plan, applicable: false, refusal: "already_current" }, true)).toBe(false);
  expect(canApply({ ...plan, planId: null }, true)).toBe(false);
});

test("a job is settled only when its status is final and no owner still writes it", () => {
  expect(isTerminalJob(job({ status: "queued" }))).toBe(false);
  expect(isTerminalJob(job({ status: "running" }))).toBe(false);
  expect(isTerminalJob(job({ status: "applied", ownerState: "active" }))).toBe(false);
  expect(isTerminalJob(job({ status: "applied", ownerState: "finished" }))).toBe(true);
  expect(isTerminalJob(job({ status: "ambiguous", ownerState: "unknown", reason: "owner_state_unknown" }))).toBe(true);
});

test("a request id is made without a secure context and fits the server's id grammar", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
      randomUUID: () => { throw new DOMException("insecure", "SecurityError"); },
      getRandomValues: (bytes: Uint8Array) => { bytes.fill(7); return bytes; },
    } });
    const id = newCodexCliRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    expect(newCodexCliRequestId()).toBeNull();
  } finally {
    Object.defineProperty(globalThis, "crypto", real);
  }
});
