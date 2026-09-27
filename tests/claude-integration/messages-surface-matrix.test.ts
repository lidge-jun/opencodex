/**
 * Upgrade/rollback matrix for the Messages surface (PF-04,
 * devlog/_plan/260924_protocol_first_class/030_gui_and_management_api.md).
 *
 * "new binary" is this tree: `resolveApiSurfaceSettings` gates /v1/messages and
 * /v1/messages/count_tokens. "old binary" is every release before `apiSurfaces` existed, whose
 * only reader was `config.claudeCode.enabled === false` → 403. The safe direction is the
 * invariant: a state the dashboard writes may be open on the new binary and closed on the old
 * one, never the reverse.
 */
import { describe, expect, test } from "bun:test";
import { handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import { applyProtocolSettingsPatch } from "../../src/server/management/protocol-settings-patch";
import { buildApiAccessEndpoints } from "../../src/server/management/api-access";
import { resolveApiSurfaceSettings } from "../../src/protocols/settings";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";

/** The pre-PF-04 reader, quoted: absent or anything but literal false was open. */
function oldBinaryOpen(config: OcxConfig): boolean {
  return config.claudeCode?.enabled !== false;
}

function cfg(extra: Record<string, unknown>): OcxConfig {
  return { port: 10100, providers: {}, ...extra } as unknown as OcxConfig;
}

/** An unparseable body: open surfaces fail on it with 400, closed ones answer 403 first. */
function badRequest(path: string): Request {
  return new Request(`http://127.0.0.1:10100${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
}

async function refused(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = await res.json() as { error?: { type?: string; message?: string } };
  return body.error?.type === "permission_error" && (body.error.message ?? "").includes("Messages API is disabled");
}

async function newBinaryOpen(config: OcxConfig): Promise<{ messages: boolean; countTokens: boolean }> {
  const messages = await handleClaudeMessages(badRequest("/v1/messages"), config, {} as RequestLogContext);
  const countTokens = await handleClaudeCountTokens(badRequest("/v1/messages/count_tokens"), config);
  return { messages: !(await refused(messages)), countTokens: !(await refused(countTokens)) };
}

type Row = { label: string; config: OcxConfig; newOpen: boolean; oldOpen: boolean; source: string };

const MATRIX: Row[] = [
  { label: "absent, Claude untouched → inherit open", config: cfg({}), newOpen: true, oldOpen: true, source: "claude-code-legacy" },
  { label: "absent, Claude on → inherit open", config: cfg({ claudeCode: { enabled: true } }), newOpen: true, oldOpen: true, source: "claude-code-legacy" },
  { label: "absent, Claude off → inherit closed", config: cfg({ claudeCode: { enabled: false } }), newOpen: false, oldOpen: false, source: "claude-code-legacy" },
  {
    label: "explicit false as the dashboard writes it → closed on both",
    config: cfg({ apiSurfaces: { messages: { enabled: false } }, claudeCode: { enabled: false } }),
    newOpen: false, oldOpen: false, source: "api-surfaces",
  },
  {
    label: "explicit true with Claude off → new open, old closed (safe direction)",
    config: cfg({ apiSurfaces: { messages: { enabled: true } }, claudeCode: { enabled: false } }),
    newOpen: true, oldOpen: false, source: "api-surfaces",
  },
  { label: "empty messages block → inherit", config: cfg({ apiSurfaces: { messages: {} } }), newOpen: true, oldOpen: true, source: "claude-code-legacy" },
  { label: "non-object apiSurfaces → closed", config: cfg({ apiSurfaces: "on" }), newOpen: false, oldOpen: true, source: "invalid" },
  { label: "non-object messages → closed", config: cfg({ apiSurfaces: { messages: true } }), newOpen: false, oldOpen: true, source: "invalid" },
  { label: "string enabled → closed", config: cfg({ apiSurfaces: { messages: { enabled: "true" } } }), newOpen: false, oldOpen: true, source: "invalid" },
  { label: "null enabled → closed", config: cfg({ apiSurfaces: { messages: { enabled: null } } }), newOpen: false, oldOpen: true, source: "invalid" },
];

describe("Messages surface upgrade/rollback matrix", () => {
  test.each(MATRIX.map(row => [row.label, row] as const))("%s", async (_label, row) => {
    const resolved = resolveApiSurfaceSettings(row.config).messages;
    expect(resolved).toEqual({ enabled: row.newOpen, source: row.source as typeof resolved.source });
    expect(oldBinaryOpen(row.config)).toBe(row.oldOpen);
    // count_tokens and /v1/messages never disagree, and both follow the resolver.
    expect(await newBinaryOpen(row.config)).toEqual({ messages: row.newOpen, countTokens: row.newOpen });
    // The dashboard metadata reports the same state, including to older dashboards.
    const endpoints = buildApiAccessEndpoints(row.config);
    expect(endpoints.surfaces.messages).toEqual(resolved);
    expect(endpoints.claudeCodeEnabled).toBe(row.newOpen);
  });

  test("a closed surface never answers 403 on only one of the two routes", async () => {
    for (const row of MATRIX) {
      const open = await newBinaryOpen(row.config);
      expect(open.messages).toBe(open.countTokens);
    }
  });
});

describe("states the settings PATCH produces keep the safe direction", () => {
  const starts: Array<[string, OcxConfig]> = [
    ["untouched", cfg({})],
    ["Claude on", cfg({ claudeCode: { enabled: true } })],
    ["Claude off", cfg({ claudeCode: { enabled: false } })],
    ["explicit true, Claude off", cfg({ apiSurfaces: { messages: { enabled: true } }, claudeCode: { enabled: false } })],
    ["invalid surface", cfg({ apiSurfaces: { messages: { enabled: "no" } } })],
  ];

  test.each(starts)("closing from %s closes the new and the old binary", async (_label, start) => {
    const config = structuredClone(start);
    expect(applyProtocolSettingsPatch(config, { messagesEnabled: false }).ok).toBe(true);
    expect(resolveApiSurfaceSettings(config).messages).toEqual({ enabled: false, source: "api-surfaces" });
    expect(oldBinaryOpen(config)).toBe(false);
    expect(await newBinaryOpen(config)).toEqual({ messages: false, countTokens: false });
  });

  test.each(starts)("opening from %s opens the new binary and never opens the old one", async (_label, start) => {
    const config = structuredClone(start);
    const oldBefore = oldBinaryOpen(config);
    expect(applyProtocolSettingsPatch(config, { messagesEnabled: true }).ok).toBe(true);
    expect(resolveApiSurfaceSettings(config).messages).toEqual({ enabled: true, source: "api-surfaces" });
    // Opening writes only apiSurfaces: the old binary's reader is exactly as it was.
    expect(oldBinaryOpen(config)).toBe(oldBefore);
    expect(config.claudeCode).toEqual(start.claudeCode);
    expect(await newBinaryOpen(config)).toEqual({ messages: true, countTokens: true });
  });

  test("new binary closed implies old binary closed for every PATCH result", () => {
    for (const [, start] of starts) {
      for (const messagesEnabled of [true, false]) {
        const config = structuredClone(start);
        applyProtocolSettingsPatch(config, { messagesEnabled });
        if (!resolveApiSurfaceSettings(config).messages.enabled) expect(oldBinaryOpen(config)).toBe(false);
      }
    }
  });
});
