import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  captureCodexAffinityDiagnostic,
  CODEX_AFFINITY_DEBUG_SAFE_HEADERS,
} from "../src/codex/affinity-debug";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";

function diagnosticPayload(): Record<string, unknown> {
  const line = getDebugLogEntries().at(-1)?.line ?? "";
  const prefix = "[ocx:codex:affinity] ";
  expect(line.startsWith(prefix)).toBe(true);
  return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
}

beforeEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
});

afterEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
});

describe("Codex affinity diagnostics", () => {
  test("stays silent unless provider debug is explicitly enabled", () => {
    captureCodexAffinityDiagnostic({
      inboundHeaders: new Headers({ session_id: "private-session" }),
      outboundHeaders: new Headers({ session_id: "private-session" }),
      authKind: "pool",
      accountMode: "pool",
      fixedAccount: false,
      credentialSubstituted: true,
      accountGatedModel: false,
      wireModelNormalized: false,
      status: 200,
    });
    expect(getDebugLogEntries()).toEqual([]);
  });

  test("emits only process-local equality tags and bounded known turn-field summaries", () => {
    setDebugSettings({ debug: true });
    const turnMetadata = JSON.stringify({
      session_id: "session-private",
      thread_id: "thread-private",
      parent_thread_id: "parent-private",
      forked_from_thread_id: "fork-private",
      request_kind: "turn",
      private_unknown_key: "must-not-appear",
    });
    captureCodexAffinityDiagnostic({
      inboundHeaders: new Headers({
        authorization: "Bearer inbound-secret",
        "chatgpt-account-id": "account-inbound-secret",
        "x-oai-attestation": "attestation-secret",
        session_id: "session-private",
        "x-codex-turn-metadata": turnMetadata,
      }),
      outboundHeaders: new Headers({
        authorization: "Bearer outbound-secret",
        "chatgpt-account-id": "account-outbound-secret",
        "x-oai-attestation": "attestation-secret",
        session_id: "session-private",
        "x-codex-turn-metadata": turnMetadata,
      }),
      authKind: "pool",
      accountMode: "pool",
      fixedAccount: true,
      credentialSubstituted: true,
      accountGatedModel: true,
      wireModelNormalized: false,
      status: 403,
    });

    const line = getDebugLogEntries().at(-1)?.line ?? "";
    for (const secret of [
      "inbound-secret",
      "outbound-secret",
      "account-inbound-secret",
      "account-outbound-secret",
      "attestation-secret",
      "session-private",
      "thread-private",
      "parent-private",
      "fork-private",
      "must-not-appear",
    ]) expect(line).not.toContain(secret);

    const payload = diagnosticPayload();
    expect(payload).toMatchObject({
      authKind: "pool",
      accountMode: "pool",
      fixedAccount: true,
      credentialSubstituted: true,
      accountGatedModel: true,
      wireModelNormalized: false,
      status: 403,
    });
    const inbound = payload.inbound as Array<{ name: string; tag?: string }>;
    const outbound = payload.outbound as Array<{ name: string; tag?: string }>;
    expect(inbound.map(row => row.name)).toEqual(["session_id", "x-codex-turn-metadata"]);
    expect(outbound.map(row => row.name)).toEqual(["session_id", "x-codex-turn-metadata"]);
    expect(inbound[0]?.tag).toBe(outbound[0]?.tag);
    expect(payload.inboundTurnMetadata).toMatchObject({ shape: "object", unknownFieldCount: 1 });
  });

  test("different values receive different tags and oversized values receive no digest", () => {
    setDebugSettings({ debug: true });
    captureCodexAffinityDiagnostic({
      inboundHeaders: new Headers({ session_id: "first" }),
      outboundHeaders: new Headers({ session_id: "second", "x-codex-turn-state": "x".repeat(16 * 1024 + 1) }),
      authKind: "main",
      accountMode: "direct",
      fixedAccount: false,
      credentialSubstituted: false,
      accountGatedModel: false,
      wireModelNormalized: false,
      status: 200,
    });
    const payload = diagnosticPayload();
    const inbound = payload.inbound as Array<{ name: string; tag?: string }>;
    const outbound = payload.outbound as Array<{ name: string; size: string; tag?: string }>;
    expect(inbound.find(row => row.name === "session_id")?.tag)
      .not.toBe(outbound.find(row => row.name === "session_id")?.tag);
    expect(outbound.find(row => row.name === "x-codex-turn-state")).toEqual({
      name: "x-codex-turn-state",
      size: "oversized",
    });
    expect(payload.outboundTurnState).toEqual({ shape: "oversized" });
  });

  test("the diagnostic allowlist never includes credential or attestation headers", () => {
    expect(CODEX_AFFINITY_DEBUG_SAFE_HEADERS).not.toContain("authorization");
    expect(CODEX_AFFINITY_DEBUG_SAFE_HEADERS).not.toContain("chatgpt-account-id");
    expect(CODEX_AFFINITY_DEBUG_SAFE_HEADERS).not.toContain("x-oai-attestation");
  });
});
