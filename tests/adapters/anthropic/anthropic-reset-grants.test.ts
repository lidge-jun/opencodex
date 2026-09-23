import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnthropicResetGrantError,
  AnthropicResetGrantUnknownOutcome,
  anthropicResetGrantBlocker,
  claimAnthropicResetGrant,
  fetchAnthropicOrganizationUuid,
  fetchAnthropicResetGrantStatus,
  parseAnthropicResetGrantStatus,
} from "../../../src/providers/anthropic-reset-grants";
import {
  ANTHROPIC_RESET_LEASE_MS,
  ANTHROPIC_RESET_RETRY_WINDOW_MS,
  AnthropicResetLedgerError,
  anthropicOrgDigest,
  beginAnthropicResetOperation,
  pendingAnthropicResetOperation,
  releaseAnthropicResetLease,
  settleAnthropicResetOperation,
} from "../../../src/providers/anthropic-reset-grant-ledger";
import { CLAUDE_CLI_USER_AGENT } from "../../../src/providers/claude-cli-identity";

// Every upstream call in this file goes to an injected fake. No test may reach
// api.anthropic.com: a real claim spends the user's one-time reset.

const ORG = "cbbef438-0000-4000-8000-000000000001";

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: "opus55-launch-promax-20260921",
    label: "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
    resets_total: 1,
    resets_left: 1,
    starts_at: "2026-09-22T16:00:00+00:00",
    ends_at: "2026-10-22T16:00:00+00:00",
    clears: ["five_hour", "seven_day", "seven_day_overage_included"],
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    percent_used: { five_hour: 3, seven_day: 14, seven_day_overage_included: 0 },
    blocking: [],
    arm: null,
    ...overrides,
  };
}

function block(overrides: Record<string, unknown> = {}) {
  return {
    eligible: true,
    ineligible_reason: null,
    at_limit: false,
    exhausted: [],
    grants: [grant()],
    next_grant_id: "opus55-launch-promax-20260921",
    weekly_resets_at: "2026-09-25T15:00:00+00:00",
    cooldown_until: null,
    event_props: { surface: "claude_code_cli", tier: "claude_max_20x" },
    ...overrides,
  };
}

interface Call { url: string; init: RequestInit }

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("reset-grant status parsing", () => {
  test("a well-formed block yields typed grants and drops event_props", () => {
    const status = parseAnthropicResetGrantStatus(block());
    expect(status?.eligible).toBe(true);
    expect(status?.grants).toHaveLength(1);
    expect(status?.grants[0]).toMatchObject({ id: "opus55-launch-promax-20260921", resetsLeft: 1, usableNow: true });
    expect(status?.grants[0].percentUsed).toEqual({ five_hour: 3, seven_day: 14, seven_day_overage_included: 0 });
    expect(status?.nextGrantId).toBe("opus55-launch-promax-20260921");
    expect(JSON.stringify(status)).not.toContain("claude_max_20x");
  });

  test("the ineligible block the old CLI user agent receives parses as ineligible, not as an error", () => {
    const status = parseAnthropicResetGrantStatus(block({ eligible: false, ineligible_reason: "cli_version", grants: [], next_grant_id: null }));
    expect(status).toMatchObject({ eligible: false, ineligibleReason: "cli_version", grants: [] });
  });

  test("malformed blocks are rejected whole instead of reading as zero grants", () => {
    expect(parseAnthropicResetGrantStatus(null)).toBeNull();
    expect(parseAnthropicResetGrantStatus(undefined)).toBeNull();
    expect(parseAnthropicResetGrantStatus(block({ eligible: "yes" }))).toBeNull();
    expect(parseAnthropicResetGrantStatus(block({ grants: {} }))).toBeNull();
    expect(parseAnthropicResetGrantStatus(block({ grants: [grant({ id: "Bad Id" })] }))).toBeNull();
    expect(parseAnthropicResetGrantStatus(block({ grants: [grant({ resets_left: -1 })] }))).toBeNull();
    expect(parseAnthropicResetGrantStatus(block({ grants: [grant({ resets_left: 2, resets_total: 1 })] }))).toBeNull();
    expect(parseAnthropicResetGrantStatus(block({ grants: [grant({ ends_at: "not a date" })] }))).toBeNull();
    expect(parseAnthropicResetGrantStatus(block({ grants: [grant(), grant()] }))).toBeNull();
  });

  test("labels lose control characters and unknown reasons collapse to unknown", () => {
    const status = parseAnthropicResetGrantStatus(block({
      ineligible_reason: "brand_new_reason",
      grants: [grant({ label: "Reset\u0007\nnow" })],
    }));
    expect(status?.grants[0].label).toBe("Reset now");
    expect(status?.ineligibleReason).toBe("unknown");
  });

  test("a grant that omits usable_now is not usable", () => {
    const { usable_now: _drop, ...rest } = grant();
    const status = parseAnthropicResetGrantStatus(block({ grants: [rest] }))!;
    expect(anthropicResetGrantBlocker(status, rest.id)).toBe("not_usable");
  });

  test("the spend gate names each refusal", () => {
    const id = "opus55-launch-promax-20260921";
    const parse = (over: Record<string, unknown>, g: Record<string, unknown> = {}) =>
      parseAnthropicResetGrantStatus(block({ ...over, grants: [grant(g)] }))!;
    expect(anthropicResetGrantBlocker(parse({}), id)).toBeNull();
    expect(anthropicResetGrantBlocker(parse({ eligible: false }), id)).toBe("ineligible");
    expect(anthropicResetGrantBlocker(parse({}), "other-grant")).toBe("unknown_grant");
    expect(anthropicResetGrantBlocker(parse({}, { paused: true }), id)).toBe("paused");
    expect(anthropicResetGrantBlocker(parse({}, { resets_left: 0 }), id)).toBe("exhausted");
    expect(anthropicResetGrantBlocker(parse({ at_limit: false }, { use_requires_limit: true }), id)).toBe("not_limited");
    expect(anthropicResetGrantBlocker(parse({ at_limit: true }, { use_requires_limit: true }), id)).toBeNull();
  });
});

describe("reset-grant wire", () => {
  test("the status read uses the Claude CLI identity and the cedar_ember query", async () => {
    const fake = fakeFetch(() => json({ five_hour: {}, cedar_ember: block() }));
    const status = await fetchAnthropicResetGrantStatus({ accessToken: "tok-1", fetchFn: fake.fn });
    expect(status.grants).toHaveLength(1);
    expect(fake.calls[0].url).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1");
    const headers = fake.calls[0].init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(CLAUDE_CLI_USER_AGENT);
    expect(CLAUDE_CLI_USER_AGENT).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
    expect(headers.Authorization).toBe("Bearer tok-1");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(fake.calls[0].init.method).toBe("GET");
  });

  test("a missing block, auth refusal, and server error are distinct read errors", async () => {
    const missing = fakeFetch(() => json({ cedar_ember: null }));
    await expect(fetchAnthropicResetGrantStatus({ accessToken: "t", fetchFn: missing.fn })).rejects.toMatchObject({ code: "malformed" });
    const auth = fakeFetch(() => json({}, 403));
    await expect(fetchAnthropicResetGrantStatus({ accessToken: "t", fetchFn: auth.fn })).rejects.toMatchObject({ code: "auth" });
    const down = fakeFetch(() => json({}, 500));
    await expect(fetchAnthropicResetGrantStatus({ accessToken: "t", fetchFn: down.fn })).rejects.toBeInstanceOf(AnthropicResetGrantError);
  });

  test("the organization comes from the token's profile and must be a UUID", async () => {
    const ok = fakeFetch(() => json({ organization: { uuid: ORG.toUpperCase() } }));
    expect(await fetchAnthropicOrganizationUuid({ accessToken: "t", fetchFn: ok.fn })).toBe(ORG);
    expect(ok.calls[0].url).toBe("https://api.anthropic.com/api/oauth/profile");
    const bad = fakeFetch(() => json({ organization: { uuid: "../../etc" } }));
    await expect(fetchAnthropicOrganizationUuid({ accessToken: "t", fetchFn: bad.fn })).rejects.toMatchObject({ code: "malformed" });
  });

  test("a claim posts the Claude Code body to the organization path", async () => {
    const fake = fakeFetch(() => json({ result: "reset", resets_left: 0, cleared: ["five_hour", "seven_day", "mystery"] }));
    const answer = await claimAnthropicResetGrant({
      accessToken: "t", organizationUuid: ORG, grantId: "opus55-launch-promax-20260921", requestId: "8a6e0804-2bd0-4672-b79d-d97027f9071a", fetchFn: fake.fn,
    });
    expect(answer).toEqual({ code: "reset", resetsLeft: 0, cleared: ["five_hour", "seven_day"] });
    expect(fake.calls[0].url).toBe(`https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`);
    expect(fake.calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(fake.calls[0].init.body))).toEqual({
      program: "cedar_ember", grant_id: "opus55-launch-promax-20260921", request_id: "8a6e0804-2bd0-4672-b79d-d97027f9071a",
    });
  });

  test("claim answers map like the Claude Code client; anything unreadable is an unknown outcome", async () => {
    const base = { accessToken: "t", organizationUuid: ORG, grantId: "g-1", requestId: "r-1" };
    for (const result of ["already_used", "not_limited", "cooldown", "ineligible", "unavailable"]) {
      const fake = fakeFetch(() => json({ result }));
      expect((await claimAnthropicResetGrant({ ...base, fetchFn: fake.fn })).code).toBe(result as never);
    }
    expect((await claimAnthropicResetGrant({ ...base, fetchFn: fakeFetch(() => json({}, 429)).fn })).code).toBe("rate_limited");
    expect((await claimAnthropicResetGrant({ ...base, fetchFn: fakeFetch(() => json({}, 401)).fn })).code).toBe("auth_error");
    for (const respond of [
      () => json({}, 500),
      () => new Response("not json", { status: 200 }),
      () => json({ result: "something_new" }),
      () => { throw new TypeError("socket hang up"); },
    ]) {
      await expect(claimAnthropicResetGrant({ ...base, fetchFn: fakeFetch(respond).fn })).rejects.toBeInstanceOf(AnthropicResetGrantUnknownOutcome);
    }
  });

  test("malformed identifiers are refused before anything is sent", async () => {
    const fake = fakeFetch(() => json({ result: "reset" }));
    await expect(claimAnthropicResetGrant({ accessToken: "t", organizationUuid: "not-a-uuid", grantId: "g", requestId: "r", fetchFn: fake.fn }))
      .rejects.toBeInstanceOf(AnthropicResetGrantError);
    await expect(claimAnthropicResetGrant({ accessToken: "t", organizationUuid: ORG, grantId: "G!", requestId: "r", fetchFn: fake.fn }))
      .rejects.toBeInstanceOf(AnthropicResetGrantError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("reset-grant journal", () => {
  let dir: string;
  let journalPath: string;
  const T0 = 1_790_000_000_000;
  const id = (operationId: string, overrides: Partial<{ accountId: string; grantId: string; org: string }> = {}) => ({
    operationId,
    accountId: overrides.accountId ?? "acct-1",
    grantId: overrides.grantId ?? "grant-a",
    orgDigest: anthropicOrgDigest(overrides.org ?? ORG),
  });
  const OP = "11111111-1111-4111-8111-111111111111";
  const OP2 = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anthropic-reset-ledger-"));
    journalPath = join(dir, "anthropic-reset-grant-ledger.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a settled operation replays without executing again", () => {
    expect(beginAnthropicResetOperation(id(OP), { journalPath, now: T0 })).toEqual({ kind: "execute", attempt: 1 });
    settleAnthropicResetOperation({ operationId: OP, code: "reset", resetsLeft: 0 }, { journalPath, now: T0 + 1 });
    expect(beginAnthropicResetOperation(id(OP), { journalPath, now: T0 + 2 })).toMatchObject({ kind: "replay", code: "reset", resetsLeft: 0 });
  });

  test("the first settlement wins and a later settle gets the stored one back", () => {
    beginAnthropicResetOperation(id(OP), { journalPath, now: T0 });
    expect(settleAnthropicResetOperation({ operationId: OP, code: "reset", resetsLeft: 0 }, { journalPath, now: T0 + 1 }))
      .toEqual({ code: "reset", resetsLeft: 0 });
    expect(settleAnthropicResetOperation({ operationId: OP, code: "unavailable", resetsLeft: null }, { journalPath, now: T0 + 2 }))
      .toEqual({ code: "reset", resetsLeft: 0 });
    expect(beginAnthropicResetOperation(id(OP), { journalPath, now: T0 + 3 })).toMatchObject({ kind: "replay", code: "reset" });
  });

  test("settling an operation the journal does not hold fails instead of pretending to be durable", () => {
    expect(() => settleAnthropicResetOperation({ operationId: OP, code: "reset", resetsLeft: 0 }, { journalPath, now: T0 }))
      .toThrow(AnthropicResetLedgerError);
  });

  test("an open operation is single-flight inside its lease and retryable with the same id after it", () => {
    beginAnthropicResetOperation(id(OP), { journalPath, now: T0 });
    expect(beginAnthropicResetOperation(id(OP), { journalPath, now: T0 + 1_000 })).toEqual({ kind: "in-flight" });
    expect(beginAnthropicResetOperation(id(OP), { journalPath, now: T0 + ANTHROPIC_RESET_LEASE_MS + 1 }))
      .toEqual({ kind: "execute", attempt: 2 });
  });

  test("releasing the lease after an unknown outcome allows the same-id retry at once", () => {
    beginAnthropicResetOperation(id(OP), { journalPath, now: T0 });
    releaseAnthropicResetLease(OP, { journalPath, now: T0 + 5_000 });
    expect(beginAnthropicResetOperation(id(OP), { journalPath, now: T0 + 5_001 })).toEqual({ kind: "execute", attempt: 2 });
  });

  test("the same id is never retried after the ten-minute window", () => {
    beginAnthropicResetOperation(id(OP), { journalPath, now: T0 });
    releaseAnthropicResetLease(OP, { journalPath, now: T0 + 1 });
    expect(beginAnthropicResetOperation(id(OP), { journalPath, now: T0 + ANTHROPIC_RESET_RETRY_WINDOW_MS })).toEqual({ kind: "expired" });
  });

  test("a new id for the same account, grant, and org is refused while an attempt is unresolved", () => {
    beginAnthropicResetOperation(id(OP), { journalPath, now: T0 });
    releaseAnthropicResetLease(OP, { journalPath, now: T0 + 1 });
    expect(beginAnthropicResetOperation(id(OP2), { journalPath, now: T0 + 60_000 })).toEqual({ kind: "unresolved-prior", operationId: OP });
    expect(pendingAnthropicResetOperation("acct-1", { journalPath, now: T0 + 60_000 }))
      .toEqual({ operationId: OP, grantId: "grant-a", createdAt: T0, retryableUntil: T0 + ANTHROPIC_RESET_RETRY_WINDOW_MS });
    // After the window the vendor client mints a new id, and so may the dashboard.
    expect(beginAnthropicResetOperation(id(OP2), { journalPath, now: T0 + ANTHROPIC_RESET_RETRY_WINDOW_MS }))
      .toEqual({ kind: "execute", attempt: 1 });
    expect(pendingAnthropicResetOperation("acct-1", { journalPath, now: T0 + ANTHROPIC_RESET_RETRY_WINDOW_MS + 1 })?.operationId).toBe(OP2);
  });

  test("an operation id bound to another account, grant, or organization is refused", () => {
    beginAnthropicResetOperation(id(OP), { journalPath, now: T0 });
    for (const other of [{ accountId: "acct-2" }, { grantId: "grant-b" }, { org: "cbbef438-0000-4000-8000-000000000002" }]) {
      expect(beginAnthropicResetOperation(id(OP, other), { journalPath, now: T0 + 1 })).toEqual({ kind: "identity-mismatch" });
    }
  });

  test("the journal stores an organization digest, never the raw UUID", async () => {
    beginAnthropicResetOperation(id(OP), { journalPath, now: T0 });
    const raw = await Bun.file(journalPath).text();
    expect(raw).not.toContain(ORG);
    expect(raw).toContain(anthropicOrgDigest(ORG));
  });

  test("a corrupt journal refuses instead of starting from empty", () => {
    writeFileSync(journalPath, "{ not json");
    expect(() => beginAnthropicResetOperation(id(OP), { journalPath, now: T0 })).toThrow(AnthropicResetLedgerError);
    writeFileSync(journalPath, JSON.stringify({ version: 1, operations: { [OP]: { accountId: 1 } } }));
    expect(() => beginAnthropicResetOperation(id(OP), { journalPath, now: T0 })).toThrow(AnthropicResetLedgerError);
  });

  test("a held journal lock refuses immediately with busy", async () => {
    const { Database } = await import("bun:sqlite");
    beginAnthropicResetOperation(id(OP), { journalPath, now: T0 });
    const holder = new Database(`${journalPath}.lock.sqlite`);
    holder.exec("BEGIN IMMEDIATE");
    try {
      let caught: unknown;
      try { beginAnthropicResetOperation(id(OP2, { grantId: "grant-z" }), { journalPath, now: T0 }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AnthropicResetLedgerError);
      expect((caught as AnthropicResetLedgerError).code).toBe("busy");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });
});
