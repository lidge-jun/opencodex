import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Refresh-failure classification: which upstream bodies are allowed to retire an account.
 *
 * The rule the runtime states is that a terminal verdict comes from the exact structured
 * `error` code. The terminal WORDS were never held to it: "invalidated", "revoked" and
 * "expired" were matched anywhere in the combined code+description text, so a transient
 * `server_error` whose description happened to say "the token was revoked" retired a healthy
 * account -- the false quarantine #2887 exists to prevent, reached through the description
 * instead of through the code.
 *
 * Every terminal word is pinned here with its own negative case. These live in their own file
 * rather than in codex-account-store.test.ts because that file is 1.8k lines and each case
 * needs the same scratch-home isolation the parent file installs.
 */

let TEST_DIR = "";
const previousHome = process.env.OPENCODEX_HOME;

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };

describe("codex refresh-failure classification", () => {
  beforeEach(() => {
    // Credential-store behavior, not Windows ACL behavior: stub both runners so hardening
    // never spawns icacls.exe.
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
    TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-codex-refresh-class-"));
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(async () => {
    await flushConfigDirHardeningForTests();
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (TEST_DIR) removeTreeWithRetry(TEST_DIR);
    TEST_DIR = "";
  });

  /** Drive one forced refresh against a stubbed token endpoint and return the thrown reason. */
  async function classify(accountId: string, respond: () => Response,
    metadata?: { status: number; code: string | undefined }): Promise<string> {
    const { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential, TokenRefreshError } =
      await import("../../src/codex/account-store");
    saveCodexAccountCredential(accountId, {
      accessToken: "rejected",
      refreshToken: `grant-${accountId}`,
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acc",
    });
    const generation = readCodexAccountRecord(accountId)!.generation;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => respond()) as typeof fetch;
    try {
      await forceRefreshCodexPoolToken(accountId, {
        rejectedGeneration: generation,
        rejectedAccessToken: "rejected",
      });
      throw new Error("expected a TokenRefreshError");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenRefreshError);
      if (metadata) expect(error).toMatchObject(metadata);
      return (error as InstanceType<typeof TokenRefreshError>).reason;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // --- negative cases: a structured code that is not terminal wins over terminal prose ---

  test("a server_error whose description says the token was revoked stays transient", async () => {
    const reason = await classify("prose-revoked", () => Response.json({
      error: "server_error",
      error_description: "upstream reported the refresh token was revoked; retry shortly",
    }, { status: 503 }));
    expect(reason).toBe("unknown");
  });

  test("a server_error whose description says the grant was invalidated stays transient", async () => {
    const reason = await classify("prose-invalidated", () => Response.json({
      error: "server_error",
      error_description: "a peer cache entry was invalidated while refreshing",
    }, { status: 503 }));
    expect(reason).toBe("unknown");
  });

  test("a server_error whose description says the session expired stays transient", async () => {
    const reason = await classify("prose-expired", () => Response.json({
      error: "server_error",
      error_description: "the upstream session expired mid-request; try again",
    }, { status: 503 }));
    expect(reason).toBe("unknown");
  });

  test("a nested error object with a transient code and terminal prose stays transient", async () => {
    // The nested shape carries the code in `error.code`, and its `message` is the same
    // free-text field: reading the message as proof is the same defect in the other shape.
    const reason = await classify("nested-prose", () => Response.json({
      error: {
        code: "server_error",
        message: "Your session has expired and the token was revoked.",
        type: "server_error",
        param: null,
      },
    }, { status: 503 }));
    expect(reason).toBe("unknown");
  });

  test("an unrelated OAuth code with terminal prose stays transient", async () => {
    // `invalid_request` is a client-shape complaint, not a statement about the grant.
    const reason = await classify("unrelated-code", () => Response.json({
      error: "invalid_request",
      error_description: "refresh_token was invalidated by an unknown parameter",
    }, { status: 400 }));
    expect(reason).toBe("unknown");
  });

  // --- positive cases: the exact codes still retire, and prose still speaks when alone ---

  test("the exact terminal codes still classify as terminal", async () => {
    expect(await classify("code-invalid-grant", () => Response.json({ error: "invalid_grant" }, { status: 400 })))
      .toBe("revoked");
    expect(await classify("code-invalidated", () => Response.json({
      error: { code: "refresh_token_invalidated", message: "Your session has ended." },
    }, { status: 401 }))).toBe("revoked");
    expect(await classify("code-expired", () => Response.json({
      error: { code: "refresh_token_expired", message: "The refresh token has expired." },
    }, { status: 401 }))).toBe("expired");
  });

  test("with no structured code at all the description is still the only signal there is", async () => {
    // A body carrying only `error_description` gives the classifier nothing else to read, so
    // the substring fallback survives exactly there -- removing it would regress the opposite
    // direction and leave a genuinely dead grant retrying forever.
    expect(await classify("desc-only-revoked", () => Response.json({
      error_description: "refresh token revoked",
    }, { status: 400 }))).toBe("revoked");
    expect(await classify("desc-only-expired", () => Response.json({
      error_description: "refresh token expired",
    }, { status: 400 }))).toBe("expired");
  });

  test("an unparseable body carries no terminal evidence and stays transient", async () => {
    const reason = await classify("unparseable", () => new Response("<html>502 revoked</html>", { status: 502 }));
    expect(reason).toBe("unknown");
  });

  test.each([429, 500, 503])("HTTP %s cannot retire a grant from terminal code or prose", async status => {
    for (const [label, body] of [
      ["code", { error: "invalid_grant" }],
      ["prose", { error_description: "refresh token was revoked and expired" }],
    ] as const) {
      expect(await classify(`availability-${status}-${label}`, () => Response.json(body, { status }))).toBe("unknown");
    }
  });

  test.each(["token_invalidated", "refresh_token_reused"])("exact %s retires a pool grant", async code => {
    expect(await classify(code, () => Response.json({ error: { code } }, { status: 400 }))).toBe("revoked");
  });

  test.each([123, {}, [], null])("malformed error_description %j stays transient", async error_description => {
    expect(await classify(`malformed-${JSON.stringify(error_description)}`, () => Response.json({ error_description }, { status: 400 }))).toBe("unknown");
  });

  test("pool refresh logs only status and recognized codes, never provider text", async () => {
    const lines: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args) => { lines.push(args.join(" ")); });
    try {
      await classify("diagnostic-known", () => Response.json({ error: "invalid_grant", error_description: "private-body-marker" }, { status: 400 }));
      await classify("diagnostic-unknown", () => Response.json({ error: "private-code-marker", error_description: "private-body-marker" }, { status: 400 }));
      expect(lines).toContain("[codex] pool refresh: reauth status=400 code=invalid_grant");
      expect(lines).toContain("[codex] pool refresh: transient status=400 code=none");
      expect(lines.join("\n")).not.toContain("private-body-marker");
      expect(lines.join("\n")).not.toContain("private-code-marker");
      expect(lines.join("\n")).not.toContain("grant-diagnostic");
    } finally { warn.mockRestore(); }
  });


  test.each([
    { status: 400, bodyCode: "invalid_grant", code: "invalid_grant", reason: "revoked" },
    { status: 503, bodyCode: "server_error", code: "server_error", reason: "unknown" },
    { status: 400, bodyCode: "private-code-marker", code: undefined, reason: "unknown" },
  ])("pool refresh errors preserve safe structured metadata: %j", async ({ status, bodyCode, code, reason }) => {
    expect(await classify(`metadata-${status}-${bodyCode}`,
      () => Response.json({ error: bodyCode, error_description: "private-description-marker" }, { status }),
      { status, code })).toBe(reason);
  });

});
