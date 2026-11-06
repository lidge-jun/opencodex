// Holds INV-LINK-CHILD-01 from structure/overview.md; shared TypeScript/Rust golden conformance suite for native/ocx-child.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { fixturePath } from "../helpers/repo-root";
import { linkRouteAllowed } from "../../src/link/routes";
import { linkManagementRouteAllowed } from "../../src/link/management-routes";
import { isDetachedEphemeralChildConfig, isEphemeralChildHealth } from "../../src/link/ephemeral-child";
import { linkConnectionProof, linkRelayProof, linkRelayProofMatches } from "../../src/link/relay-auth";
import { codexSettingsDigest, codexSettingsDigestPayload, type HomeCodexSettings } from "../../src/link/codex-settings";
import { parseLinkChildParityReport } from "../../src/link/child-parity";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { isAllowedRequestOrigin } from "../../src/server/auth-cors";
import { validateHubRelayRequestHeaders } from "../../src/client/hub-relay";
import { forwardLinkRequestHeaders } from "../../src/client/link-relay";
import {
  applyEol,
  dominantEol,
  ensureFastModeFeature,
  ensureRootWebSearchDisabled,
  externalCodexModelProvider,
  setRootModelCatalogPath,
  setRootOpenaiBaseUrlForTarget,
  setRootRealtimeWsBaseUrl,
  stripOpencodexCatalogPath,
} from "../../src/codex/inject/config-toml";
import { stripJournaledOpenaiBaseUrl } from "../../src/codex/injected-marker";
import { transformManagedSubagentDefaults, type WrittenSubagentDefaults } from "../../src/codex/subagent-defaults";

interface ConformanceSuite {
  schema: string;
  routeCases: Array<{
    id: string;
    method: string;
    path: string;
    query: string;
    hostHeader: string | null;
    originHeader: string | null;
    upgradeHeader: string | null;
    expectedAction: string;
    expectedAuthHeader: string;
  }>;
  framingCases: Array<{
    id: string;
    rawHeaders: Array<[string, string]>;
    expectedOutcome: string;
    expectedSurvivedHeaders: string[];
  }>;
  relayAuthCases: Array<{
    id: string;
    rawToken: string;
    tokenSha256Hex: string;
    keyId: string;
    linkId: string;
    nonce: string;
    generation: string;
    expectedCallerProof: string;
    expectedListenerProof: string;
    expectedConnectionProof: string;
  }>;
  settingsDigestCases: Array<{
    id: string;
    settings: HomeCodexSettings;
    expectedCanonicalJson: string;
    expectedDigestHex: string;
  }>;
  childParityCases: Array<{
    id: string;
    rawJson: string;
    expectedValid: boolean;
  }>;
  journalRoundtripCases: Array<{
    id: string;
    preAttachToml: string | null;
    preAttachCatalog: string | null;
    listenPort: number;
    catalogPath: string;
    initialSettings: HomeCodexSettings;
    syncSettings: HomeCodexSettings | null;
    midSessionMutation: {
      kind: string;
      appendedToml?: string;
      prependedRootLine?: string;
      newBaseUrl?: string;
      rawOverrideToml?: string;
      tamperedCatalog?: string;
    };
    expectedAttachOk: boolean;
    expectedDetachOutcome: string;
    expectedFinalToml: string | null;
    expectedFinalCatalog: string | null;
  }>;
}

const suite = JSON.parse(
  readFileSync(fixturePath("link", "ocx-child-conformance.json"), "utf8"),
) as ConformanceSuite;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function classifyChildIngressCase(row: ConformanceSuite["routeCases"][number]): {
  action: string;
  authHeader: string;
} {
  const headers = new Headers();
  if (row.hostHeader !== null) headers.set("host", row.hostHeader);
  if (row.originHeader !== null) headers.set("origin", row.originHeader);
  if (row.upgradeHeader !== null) headers.set("upgrade", row.upgradeHeader);
  const fullUrl = `http://127.0.0.1:10100${row.path}${row.query}`;
  const url = new URL(fullUrl);
  const req = new Request(fullUrl, { method: row.method, headers });
  const policy = { hostname: "127.0.0.1" };

  if (row.upgradeHeader !== null) {
    if (url.pathname === "/v1/responses" && row.upgradeHeader.trim().toLowerCase() === "websocket") {
      if (!isAllowedRequestOrigin(req, policy)) return { action: "reject_403_origin", authHeader: "none" };
      return { action: "reject_426_websocket", authHeader: "none" };
    }
    return { action: "reject_404", authHeader: "none" };
  }
  if (url.pathname === "/healthz" && row.method === "GET") {
    return { action: "local_healthz", authHeader: "none" };
  }
  if (url.pathname === "/readyz") {
    return row.method === "GET"
      ? { action: "local_readyz", authHeader: "none" }
      : { action: "reject_404", authHeader: "none" };
  }
  if (linkRouteAllowed(url, req)) {
    if (!isAllowedRequestOrigin(req, policy)) return { action: "reject_403_origin", authHeader: "none" };
    return {
      action: "relay_data",
      authHeader: url.pathname === "/v1/usage" ? "x-opencodex-api-key" : "bearer",
    };
  }
  if (linkManagementRouteAllowed(url, req)) {
    if (!isAllowedRequestOrigin(req, policy)) return { action: "reject_403_origin", authHeader: "none" };
    return { action: "relay_management", authHeader: "bearer" };
  }
  return { action: "reject_404", authHeader: "none" };
}

function applyMultiAgentFeature(content: string, mode: HomeCodexSettings["multiAgentMode"]): { content: string; createdKey: boolean; priorLine: string | null } {
  if (mode === null) return { content, createdKey: false, priorLine: null };
  const desired = mode === "v2";
  const lines = content.split("\n");
  const featIdx = lines.findIndex(line => /^\s*\[\s*features\s*\]\s*(?:#.*)?$/.test(line));
  if (featIdx === -1) {
    const trimmed = content.replace(/\n+$/, "");
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
    return { content: `${prefix}[features]\nmulti_agent_v2 = ${desired}\n`, createdKey: true, priorLine: null };
  }
  let endIdx = lines.findIndex((line, i) => i > featIdx && /^\s*\[/.test(line));
  if (endIdx === -1) endIdx = lines.length;
  for (let i = featIdx + 1; i < endIdx; i++) {
    if (/^\s*multi_agent_v2\s*=/.test(lines[i]!)) {
      const priorLine = lines[i]!;
      lines[i] = `multi_agent_v2 = ${desired}`;
      return { content: lines.join("\n"), createdKey: false, priorLine };
    }
  }
  let insertAt = endIdx;
  while (insertAt > featIdx + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  lines.splice(insertAt, 0, `multi_agent_v2 = ${desired}`);
  return { content: lines.join("\n"), createdKey: true, priorLine: null };
}

function stripSurgicalTableFeatures(
  content: string,
  wroteFastMode: boolean | null,
  priorUserFastModeLine: string | null,
  wroteMultiAgentV2: boolean | null,
  priorUserMultiAgentV2Line: string | null,
): string {
  if (wroteFastMode === null && wroteMultiAgentV2 === null) return content;
  const lines = content.split("\n");
  const featIdx = lines.findIndex(line => /^\s*\[\s*features\s*\]\s*(?:#.*)?$/.test(line));
  if (featIdx === -1) return content;
  let endIdx = lines.findIndex((line, i) => i > featIdx && /^\s*\[/.test(line));
  if (endIdx === -1) endIdx = lines.length;
  const body: string[] = [];
  for (const line of lines.slice(featIdx + 1, endIdx)) {
    if (wroteFastMode !== null && new RegExp(`^\\s*fast_mode\\s*=\\s*${wroteFastMode}\\s*(?:#.*)?$`).test(line)) {
      if (priorUserFastModeLine !== null) body.push(priorUserFastModeLine);
      continue;
    }
    if (wroteMultiAgentV2 !== null && new RegExp(`^\\s*multi_agent_v2\\s*=\\s*${wroteMultiAgentV2}\\s*(?:#.*)?$`).test(line)) {
      if (priorUserMultiAgentV2Line !== null) body.push(priorUserMultiAgentV2Line);
      continue;
    }
    body.push(line);
  }
  if (body.every(line => line.trim() === "" || line.trim().startsWith("#"))) {
    const next = [...lines.slice(0, featIdx), ...lines.slice(endIdx)];
    return next.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  return [...lines.slice(0, featIdx + 1), ...body, ...lines.slice(endIdx)].join("\n");
}

function stripSurgicalSubagentDefaults(content: string, written: WrittenSubagentDefaults | null): string {
  if (!written) return content;
  const markerStripped = transformManagedSubagentDefaults(content, null, written);
  let next = markerStripped.ok ? markerStripped.content : content;
  const lines = next.split("\n");
  const agIdx = lines.findIndex(line => /^\s*\[\s*agents\s*\]\s*(?:#.*)?$/.test(line));
  if (agIdx === -1) return next;
  let endIdx = lines.findIndex((line, i) => i > agIdx && /^\s*\[/.test(line));
  if (endIdx === -1) endIdx = lines.length;
  const body = lines.slice(agIdx + 1, endIdx).filter(line => {
    if (written.default_subagent_model && line.trim() === `default_subagent_model = ${JSON.stringify(written.default_subagent_model)}`) return false;
    if (written.default_subagent_reasoning_effort && line.trim() === `default_subagent_reasoning_effort = ${JSON.stringify(written.default_subagent_reasoning_effort)}`) return false;
    return true;
  });
  if (body.every(line => line.trim() === "" || line.trim().startsWith("#"))) {
    next = [...lines.slice(0, agIdx), ...lines.slice(endIdx)].join("\n").replace(/\n{3,}/g, "\n\n");
  } else {
    next = [...lines.slice(0, agIdx + 1), ...body, ...lines.slice(endIdx)].join("\n");
  }
  return next;
}

function runReferenceJournalCase(row: ConformanceSuite["journalRoundtripCases"][number]) {
  if (row.preAttachToml !== null && externalCodexModelProvider(row.preAttachToml) !== null) {
    return {
      attachOk: false,
      detachOutcome: "not_attached",
      finalToml: row.preAttachToml,
      finalCatalog: row.preAttachCatalog,
    };
  }
  const eol = row.preAttachToml ? dominantEol(row.preAttachToml) : "\n";
  const target = {
    baseUrl: `http://127.0.0.1:${row.listenPort}/v1`,
    requiresAdmissionToken: false,
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
  };
  let replacedUserWebSearch: string | null = null;
  let wroteWebSearch: string | null = null;
  let wroteFastMode: boolean | null = null;
  let priorUserFastModeLine: string | null = null;
  let wroteMultiAgentV2: boolean | null = null;
  let priorUserMultiAgentV2Line: string | null = null;
  let wroteSubagent: WrittenSubagentDefaults | null = null;

  const applySettings = (rawInput: string, settings: HomeCodexSettings): string => {
    let lf = applyEol(rawInput, "\n");
    lf = stripJournaledOpenaiBaseUrl(lf, target.baseUrl, target.baseUrl);
    const ws = ensureRootWebSearchDisabled(lf, !settings.webSearchSidecarEnabled, {
      injectedValue: wroteWebSearch,
      replacedUserLine: replacedUserWebSearch,
    });
    lf = ws.content;
    replacedUserWebSearch = ws.replacedUserLine;
    wroteWebSearch = ws.wroteValue;
    lf = setRootModelCatalogPath(lf, row.catalogPath);
    lf = setRootOpenaiBaseUrlForTarget(lf, target).content;
    lf = setRootRealtimeWsBaseUrl(lf, target).content;
    if (settings.fastMode !== null) {
      if (wroteFastMode === null) {
        const fmMatch = lf.split("\n").find(l => /^\s*fast_mode\s*=/.test(l));
        priorUserFastModeLine = fmMatch ?? null;
      }
      lf = ensureFastModeFeature(lf, settings.fastMode);
      wroteFastMode = settings.fastMode;
    }
    if (settings.multiAgentMode !== null) {
      const v2Res = applyMultiAgentFeature(lf, settings.multiAgentMode);
      if (wroteMultiAgentV2 === null) priorUserMultiAgentV2Line = v2Res.priorLine;
      lf = v2Res.content;
      wroteMultiAgentV2 = settings.multiAgentMode === "v2";
    }
    const desiredSub = settings.subagentDefaults
      ? {
          model: settings.subagentDefaults.model,
          ...(settings.subagentDefaults.reasoningEffort
            ? { reasoningEffort: settings.subagentDefaults.reasoningEffort }
            : {}),
        }
      : null;
    const subRes = transformManagedSubagentDefaults(lf, desiredSub, wroteSubagent);
    if (subRes.ok) {
      lf = subRes.content;
      wroteSubagent = desiredSub
        ? {
            default_subagent_model: desiredSub.model,
            ...(desiredSub.reasoningEffort
              ? { default_subagent_reasoning_effort: desiredSub.reasoningEffort }
              : {}),
          }
        : null;
    }
    return applyEol(lf, eol);
  };

  let currentToml = applySettings(row.preAttachToml ?? "", row.initialSettings);
  let latestInjectedSha = sha256Hex(currentToml);
  let untouchedByExternal = true;
  let currentCatalog: string | null = "{\"models\":[{\"slug\":\"home-m1\"}]}\n";
  const latestCatalogSha = sha256Hex(currentCatalog);

  if (row.syncSettings) {
    if (sha256Hex(currentToml) !== latestInjectedSha) untouchedByExternal = false;
    currentToml = applySettings(currentToml, row.syncSettings);
    latestInjectedSha = sha256Hex(currentToml);
  }

  switch (row.midSessionMutation.kind) {
    case "strip_comments_and_append_table": {
      currentToml = currentToml
        .split("\n")
        .filter(line => !line.trim().startsWith("#"))
        .join("\n")
        .replace(/\n+$/, "\n") + (row.midSessionMutation.appendedToml ?? "");
      break;
    }
    case "strip_comments_and_prepend_root": {
      currentToml = (row.midSessionMutation.prependedRootLine ?? "") + currentToml
        .split("\n")
        .filter(line => !line.trim().startsWith("#"))
        .join("\n");
      break;
    }
    case "replace_root_base_url": {
      currentToml = currentToml.replace(
        `openai_base_url = "http://127.0.0.1:${row.listenPort}/v1"`,
        `openai_base_url = ${JSON.stringify(row.midSessionMutation.newBaseUrl)}`,
      );
      break;
    }
    case "corrupt_managed_span": {
      currentToml = row.midSessionMutation.rawOverrideToml ?? currentToml;
      break;
    }
    case "tamper_catalog": {
      currentCatalog = row.midSessionMutation.tamperedCatalog ?? currentCatalog;
      break;
    }
  }

  if (currentCatalog !== null && sha256Hex(currentCatalog) !== latestCatalogSha) {
    return {
      attachOk: true,
      detachOutcome: "refuse_conflict",
      finalToml: null,
      finalCatalog: currentCatalog,
    };
  }

  if (untouchedByExternal && sha256Hex(currentToml) === latestInjectedSha) {
    return {
      attachOk: true,
      detachOutcome: "exact_restore",
      finalToml: row.preAttachToml,
      finalCatalog: row.preAttachCatalog,
    };
  }

  for (const line of applyEol(currentToml, "\n").split("\n")) {
    if (/^\s*(?:openai_base_url|experimental_realtime_ws_base_url|model_catalog_json|web_search)\s*=/.test(line)) {
      try {
        Bun.TOML.parse(line);
      } catch {
        return {
          attachOk: true,
          detachOutcome: "refuse_conflict",
          finalToml: currentToml,
          finalCatalog: row.preAttachCatalog,
        };
      }
    }
  }

  let surgical = applyEol(currentToml, "\n");
  surgical = surgical.replace(/^# Auto-injected by opencodex(?: \(undo: ocx restore\))?\n(?=\s*openai_base_url\s*=)/gm, "");
  surgical = stripJournaledOpenaiBaseUrl(surgical, target.baseUrl, target.baseUrl);
  surgical = stripOpencodexCatalogPath(surgical);
  surgical = ensureRootWebSearchDisabled(surgical, false, {
    injectedValue: wroteWebSearch,
    replacedUserLine: replacedUserWebSearch ? replacedUserWebSearch.replace(/(?:\r?\n)+$/, "") : null,
  }).content;
  surgical = stripSurgicalTableFeatures(
    surgical,
    wroteFastMode,
    priorUserFastModeLine,
    wroteMultiAgentV2,
    priorUserMultiAgentV2Line,
  );
  surgical = stripSurgicalSubagentDefaults(surgical, wroteSubagent);
  surgical = surgical.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
  if (surgical.length > 0 && !surgical.endsWith("\n")) surgical += "\n";
  const finalToml = surgical.trim().length === 0 ? null : applyEol(surgical, eol);
  return {
    attachOk: true,
    detachOutcome: "surgical_restore",
    finalToml,
    finalCatalog: row.preAttachCatalog,
  };
}

describe("ocx-child shared golden conformance vectors (INV-LINK-CHILD-01)", () => {
  test("schema version and non-empty vector coverage", () => {
    expect(suite.schema).toBe("ocx.child.conformance/1");
    expect(suite.routeCases.length).toBeGreaterThanOrEqual(40);
    expect(suite.framingCases.length).toBeGreaterThanOrEqual(10);
    expect(suite.relayAuthCases.length).toBeGreaterThanOrEqual(3);
    expect(suite.settingsDigestCases.length).toBeGreaterThanOrEqual(4);
    expect(suite.childParityCases.length).toBeGreaterThanOrEqual(6);
    expect(suite.journalRoundtripCases.length).toBeGreaterThanOrEqual(8);
  });

  test("routeCases match linkRouteAllowed, linkManagementRouteAllowed, Upgrade, and Host/Origin anti-rebinding", () => {
    for (const row of suite.routeCases) {
      const actual = classifyChildIngressCase(row);
      expect(actual, row.id).toEqual({
        action: row.expectedAction,
        authHeader: row.expectedAuthHeader,
      });
    }
  });

  test("framingCases match link header smuggling validation and CALLER_CREDENTIAL_HEADERS stripping", () => {
    for (const row of suite.framingCases) {
      const hasCrLf = row.rawHeaders.some(([k, v]) => !k || /[\r\n]/.test(k) || /[\r\n]/.test(v));
      if (hasCrLf) {
        const rawCheck = validateHubRelayRequestHeaders(row.rawHeaders);
        expect(rawCheck.ok, row.id).toBe(false);
        if (!rawCheck.ok) expect(rawCheck.reason, row.id).toBe("invalid");
        expect(row.expectedOutcome, row.id).toBe("reject_400_invalid");
        continue;
      }
      const contentLengths = row.rawHeaders.filter(([k]) => k.toLowerCase() === "content-length");
      const transferEncodings = row.rawHeaders.filter(([k]) => k.toLowerCase() === "transfer-encoding");
      const preNormalized = transferEncodings.length === 1
        && transferEncodings[0]![1]!.trim().toLowerCase() === "chunked"
        && contentLengths.length === 0
        ? row.rawHeaders.filter(([k]) => k.toLowerCase() !== "transfer-encoding")
        : row.rawHeaders;
      const check = validateHubRelayRequestHeaders(preNormalized);
      if (!check.ok) {
        expect(row.expectedOutcome, row.id).toBe(
          check.reason === "smuggling" ? "reject_400_smuggling" : "reject_400_invalid",
        );
        continue;
      }
      expect(row.expectedOutcome, row.id).toBe("allow");
      const source = new Headers();
      for (const [k, v] of row.rawHeaders) source.append(k, v);
      const forwarded = forwardLinkRequestHeaders(source, "ocx_data_" + "1".repeat(40), "/v1/responses");
      forwarded.delete("authorization");
      expect([...forwarded.keys()].sort(), row.id).toEqual(row.expectedSurvivedHeaders);
    }
  });

  test("relayAuthCases lock raw 32-byte SHA-256 HMAC key derivation and reject ASCII-hex key misuse", () => {
    for (const row of suite.relayAuthCases) {
      const fp = serviceApiTokenFingerprint(row.rawToken);
      expect(fp, row.id).toBe(row.tokenSha256Hex);
      const caller = linkRelayProof(fp, "caller", row.keyId, row.linkId, row.nonce);
      const listener = linkRelayProof(fp, "listener", row.keyId, row.linkId, row.nonce);
      const conn = linkConnectionProof(fp, row.keyId, row.linkId, row.nonce, row.generation);
      expect(caller, row.id).toBe(row.expectedCallerProof);
      expect(listener, row.id).toBe(row.expectedListenerProof);
      expect(conn, row.id).toBe(row.expectedConnectionProof);
      expect(linkRelayProofMatches(caller, row.expectedCallerProof), row.id).toBe(true);
      expect(linkRelayProofMatches(caller, listener), row.id).toBe(false);
      const asciiBug = createHmac("sha256", fp)
        .update(`opencodex-link-relay-v2\0caller\0${row.keyId}\0${row.linkId}\0${row.nonce}`)
        .digest("hex");
      expect(asciiBug, row.id).not.toBe(row.expectedCallerProof);
    }
  });

  test("settingsDigestCases lock OCX-6 fixed-key canonical JSON and SHA-256 digests", () => {
    for (const row of suite.settingsDigestCases) {
      expect(codexSettingsDigestPayload(row.settings), row.id).toBe(row.expectedCanonicalJson);
      expect(codexSettingsDigest(row.settings), row.id).toBe(row.expectedDigestHex);
    }
  });

  test("childParityCases match parseLinkChildParityReport exact-key and range invariants", () => {
    for (const row of suite.childParityCases) {
      const parsed = parseLinkChildParityReport(JSON.parse(row.rawJson));
      expect(parsed !== null, row.id).toBe(row.expectedValid);
    }
  });

  test("journalRoundtripCases verify exact restore, #1798 surgical strip, and fail-closed conflicts", () => {
    for (const row of suite.journalRoundtripCases) {
      const actual = runReferenceJournalCase(row);
      expect(actual.attachOk, row.id).toBe(row.expectedAttachOk);
      expect(actual.detachOutcome, row.id).toBe(row.expectedDetachOutcome);
      if (row.expectedFinalToml !== null || actual.detachOutcome !== "refuse_conflict") {
        expect(actual.finalToml, row.id).toBe(row.expectedFinalToml);
      }
      expect(actual.finalCatalog, row.id).toBe(row.expectedFinalCatalog);
    }
  });

  test("ephemeral-child config and health predicates enforce detached vs attached invariants", () => {
    expect(isDetachedEphemeralChildConfig({ port: 10100, runtimeRole: "standalone", ephemeralChild: true })).toBe(true);
    expect(isDetachedEphemeralChildConfig({ port: 10100, runtimeRole: "client", ephemeralChild: true })).toBe(false);
    expect(isDetachedEphemeralChildConfig({ port: 10100, runtimeRole: "standalone" })).toBe(false);
    expect(isDetachedEphemeralChildConfig({ port: 80, runtimeRole: "standalone", ephemeralChild: true })).toBe(false);
    expect(isEphemeralChildHealth({
      service: "opencodex",
      version: "2.98.0",
      role: "client",
      ephemeralChild: true,
      pid: 1234,
      port: 10100,
      startedAt: "2026-11-07T00:00:00.000Z",
    }, 10100)).toBe(true);
    expect(isEphemeralChildHealth({
      service: "opencodex",
      role: "client",
      ephemeralChild: false,
      pid: 1234,
      port: 10100,
      startedAt: "2026-11-07T00:00:00.000Z",
    }, 10100)).toBe(false);
  });
});
