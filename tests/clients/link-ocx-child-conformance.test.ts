// Holds INV-LINK-CHILD-01 from structure/overview.md; shared TypeScript/Rust golden conformance suite for native/ocx-child.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { fixturePath, repoPath } from "../helpers/repo-root";
import { rustToolchainEnv } from "../helpers/rust-toolchain-env";
import { linkRouteAllowed } from "../../src/link/routes";
import { linkManagementRouteAllowed } from "../../src/link/management-routes";
import { isDetachedEphemeralChildConfig, isEphemeralChildHealth } from "../../src/link/ephemeral-child";
import { linkConnectionProof, linkRelayProof, linkRelayProofMatches } from "../../src/link/relay-auth";
import { codexSettingsDigest, codexSettingsDigestPayload, type HomeCodexSettings } from "../../src/link/codex-settings";
import { parseLinkChildParityReport } from "../../src/link/child-parity";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { isAllowedRequestOrigin } from "../../src/server/auth-cors";
import { validateHubRelayRequestHeaders } from "../../src/client/hub-relay";
import { handleLinkIngress } from "../../src/client/link-ingress";
import { forwardLinkRequestHeaders, HOME_INITIATED_LINK_TUNNEL } from "../../src/client/link-relay";
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
import { MANAGED_AGENTS_TABLE_MARKER, transformManagedSubagentDefaults, type WrittenSubagentDefaults } from "../../src/codex/subagent-defaults";
import { rootAssignmentKey, rootSourceLines, sourceText, splitSourceLines, type SourceLine } from "../../src/codex/toml-source-lines";

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

function isStructuralSimpleTable(line: SourceLine, expectedName: string): boolean {
  if (!line.structural || !/^\s*\[/.test(line.text)) return false;
  try {
    const parsed = Bun.TOML.parse(line.text) as Record<string, unknown>;
    const entry = parsed[expectedName];
    return (
      Object.keys(parsed).length === 1 &&
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      Object.keys(entry).length === 0
    );
  } catch {
    return false;
  }
}

function matchesStructuralBoolAssignment(line: SourceLine, key: string, expected: boolean): boolean {
  if (!line.structural || rootAssignmentKey(line.text) !== key) return false;
  try {
    const parsed = Bun.TOML.parse(line.text) as Record<string, unknown>;
    return parsed[key] === expected;
  } catch {
    return false;
  }
}

function collapseStructuralBlankLines(lf: string): string {
  const lines = splitSourceLines(lf);
  const out: SourceLine[] = [];
  let blankRun = 0;
  let started = false;
  for (const line of lines) {
    const isStructBlank = line.structural && line.text.length === 0;
    if (!started && isStructBlank) continue;
    started = true;
    if (isStructBlank) {
      blankRun += 1;
      if (blankRun <= 1) out.push(line);
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1]!.structural && out[out.length - 1]!.text.length === 0) {
    out.pop();
  }
  return sourceText(out);
}

function findStructuralFeatureLine(content: string, key: string): string | null {
  const lines = splitSourceLines(content);
  const featIdx = lines.findIndex(line => isStructuralSimpleTable(line, "features"));
  if (featIdx === -1) return null;
  let endIdx = lines.findIndex((line, i) => i > featIdx && line.structural && /^\s*\[/.test(line.text));
  if (endIdx === -1) endIdx = lines.length;
  for (let i = featIdx + 1; i < endIdx; i++) {
    if (lines[i]!.structural && rootAssignmentKey(lines[i]!.text) === key) {
      return lines[i]!.text;
    }
  }
  return null;
}

function applyMultiAgentFeature(content: string, mode: HomeCodexSettings["multiAgentMode"]): { content: string; createdKey: boolean; priorLine: string | null } {
  if (mode === null) return { content, createdKey: false, priorLine: null };
  const desired = mode === "v2";
  const lines = splitSourceLines(content);
  const eol = lines.find(l => l.eol)?.eol || "\n";
  const featIdx = lines.findIndex(line => isStructuralSimpleTable(line, "features"));
  if (featIdx === -1) {
    const trimmed = content.replace(/\n+$/, "");
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
    return { content: `${prefix}[features]\nmulti_agent_v2 = ${desired}\n`, createdKey: true, priorLine: null };
  }
  let endIdx = lines.findIndex((line, i) => i > featIdx && line.structural && /^\s*\[/.test(line.text));
  if (endIdx === -1) endIdx = lines.length;
  for (let i = featIdx + 1; i < endIdx; i++) {
    if (lines[i]!.structural && rootAssignmentKey(lines[i]!.text) === "multi_agent_v2") {
      const priorLine = lines[i]!.text;
      lines[i]!.text = `multi_agent_v2 = ${desired}`;
      return { content: sourceText(lines), createdKey: false, priorLine };
    }
  }
  let insertAt = endIdx;
  while (insertAt > featIdx + 1 && lines[insertAt - 1]!.structural && lines[insertAt - 1]!.text.trim() === "") insertAt--;
  if (insertAt > 0 && !lines[insertAt - 1]!.eol) lines[insertAt - 1]!.eol = eol;
  lines.splice(insertAt, 0, { text: `multi_agent_v2 = ${desired}`, eol, structural: true });
  return { content: sourceText(lines), createdKey: true, priorLine: null };
}

function stripSurgicalTableFeatures(
  content: string,
  wroteFastMode: boolean | null,
  priorUserFastModeLine: string | null,
  wroteMultiAgentV2: boolean | null,
  priorUserMultiAgentV2Line: string | null,
): string {
  if (wroteFastMode === null && wroteMultiAgentV2 === null) return content;
  const lines = splitSourceLines(content);
  const eol = lines.find(l => l.eol)?.eol || "\n";
  const featIdx = lines.findIndex(line => isStructuralSimpleTable(line, "features"));
  if (featIdx === -1) return content;
  let endIdx = lines.findIndex((line, i) => i > featIdx && line.structural && /^\s*\[/.test(line.text));
  if (endIdx === -1) endIdx = lines.length;
  const body: SourceLine[] = [];
  for (const line of lines.slice(featIdx + 1, endIdx)) {
    if (wroteFastMode !== null && matchesStructuralBoolAssignment(line, "fast_mode", wroteFastMode)) {
      if (priorUserFastModeLine !== null) body.push({ text: priorUserFastModeLine, eol: line.eol || eol, structural: true });
      continue;
    }
    if (wroteMultiAgentV2 !== null && matchesStructuralBoolAssignment(line, "multi_agent_v2", wroteMultiAgentV2)) {
      if (priorUserMultiAgentV2Line !== null) body.push({ text: priorUserMultiAgentV2Line, eol: line.eol || eol, structural: true });
      continue;
    }
    body.push(line);
  }
  if (body.every(line => line.structural && line.text.trim() === "")) {
    return collapseStructuralBlankLines(sourceText([...lines.slice(0, featIdx), ...lines.slice(endIdx)]));
  }
  return sourceText([...lines.slice(0, featIdx + 1), ...body, ...lines.slice(endIdx)]);
}

function stripSurgicalSubagentDefaults(content: string, written: WrittenSubagentDefaults | null): string {
  if (!written) return content;
  const markerStripped = transformManagedSubagentDefaults(content, null, written);
  let next = markerStripped.ok ? markerStripped.content : content;
  const lines = splitSourceLines(next);
  const agIdx = lines.findIndex(line => isStructuralSimpleTable(line, "agents"));
  if (agIdx === -1) return next;
  let endIdx = lines.findIndex((line, i) => i > agIdx && line.structural && /^\s*\[/.test(line.text));
  if (endIdx === -1) endIdx = lines.length;
  const prefixLines = agIdx > 0 && lines[agIdx - 1]!.structural && lines[agIdx - 1]!.text.trim() === MANAGED_AGENTS_TABLE_MARKER
    ? lines.slice(0, agIdx - 1)
    : lines.slice(0, agIdx);
  const body = lines.slice(agIdx + 1, endIdx).filter(line => {
    if (!line.structural) return true;
    if (written.default_subagent_model && line.text.trim() === `default_subagent_model = ${JSON.stringify(written.default_subagent_model)}`) return false;
    if (written.default_subagent_reasoning_effort && line.text.trim() === `default_subagent_reasoning_effort = ${JSON.stringify(written.default_subagent_reasoning_effort)}`) return false;
    return true;
  });
  if (body.every(line => line.structural && line.text.trim() === "")) {
    next = collapseStructuralBlankLines(sourceText([...prefixLines, ...lines.slice(endIdx)]));
  } else {
    next = sourceText([...prefixLines, lines[agIdx]!, ...body, ...lines.slice(endIdx)]);
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
        priorUserFastModeLine = findStructuralFeatureLine(lf, "fast_mode");
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

  const { lines: curStructLines, rootEnd: curRootEnd } = rootSourceLines(applyEol(currentToml, "\n"));
  for (let i = 0; i < curRootEnd; i++) {
    const line = curStructLines[i]!;
    if (line.structural && /^\s*(?:openai_base_url|experimental_realtime_ws_base_url|model_catalog_json|web_search)\s*=/.test(line.text)) {
      try {
        Bun.TOML.parse(line.text);
      } catch {
        return {
          attachOk: true,
          detachOutcome: "refuse_conflict",
          finalToml: currentToml,
          finalCatalog: currentCatalog,
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
  surgical = collapseStructuralBlankLines(surgical);
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
    const injectedToken = "ocx_data_" + "2".repeat(40);
    for (const row of suite.routeCases) {
      const actual = classifyChildIngressCase(row);
      expect(actual, row.id).toEqual({
        action: row.expectedAction,
        authHeader: row.expectedAuthHeader,
      });
      if (row.expectedAction === "relay_data" || row.expectedAction === "relay_management") {
        const forwarded = forwardLinkRequestHeaders(new Headers(), injectedToken, row.path);
        if (row.expectedAuthHeader === "x-opencodex-api-key") {
          expect(forwarded.get("x-opencodex-api-key"), row.id).toBe(injectedToken);
          expect(forwarded.get("authorization"), row.id).toBeNull();
        } else {
          expect(forwarded.get("authorization"), row.id).toBe(`Bearer ${injectedToken}`);
          expect(forwarded.get("x-opencodex-api-key"), row.id).toBeNull();
        }
      }
    }
  });

  test("framingCases match link header smuggling validation, handleLinkIngress chunked forwarding, and CALLER_CREDENTIAL_HEADERS stripping", async () => {
    const injectedToken = "ocx_data_" + "1".repeat(40);
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
      const forwarded = forwardLinkRequestHeaders(source, injectedToken, "/v1/responses");
      expect(forwarded.get("authorization"), row.id).toBe(`Bearer ${injectedToken}`);
      forwarded.delete("authorization");
      expect([...forwarded.keys()].sort(), row.id).toEqual(row.expectedSurvivedHeaders);
      const usageForwarded = forwardLinkRequestHeaders(source, injectedToken, "/v1/usage");
      expect(usageForwarded.get("x-opencodex-api-key"), row.id).toBe(injectedToken);
      if (row.id === "allow_lone_transfer_encoding_chunked") {
        let observedBody = "";
        const url = new URL("http://127.0.0.1:10100/v1/responses");
        const req = new Request(url, { method: "POST", headers: source, body: "{\"ok\":1}" });
        const resp = await handleLinkIngress(req, url, {
          tunnelPort: 22222,
          policy: { hostname: "127.0.0.1" },
          linkKey: () => injectedToken,
          relay: {
            tunnel: HOME_INITIATED_LINK_TUNNEL,
            fetchImpl: (async (_u, init) => {
              observedBody = await new Response(init?.body as BodyInit).text();
              return Response.json({ relayed: true });
            }) as typeof fetch,
          },
        });
        expect(resp?.status).toBe(200);
        expect(observedBody).toBe("{\"ok\":1}");
      }
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
    expect(isDetachedEphemeralChildConfig({ port: 10100, runtimeRole: null, ephemeralChild: true })).toBe(true);
    expect(isDetachedEphemeralChildConfig({ port: 10100, ephemeralChild: true })).toBe(true);
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

  const cargo = rustToolchainEnv("cargo");
  const cargoAvailable = cargo.bin !== null;

  test.skipIf(!cargoAvailable)("Rust conformance runner passes against the identical shared fixture", () => {
    const run = Bun.spawnSync(
      [cargo.bin!, "test", "--locked", "--manifest-path", repoPath("native", "ocx-child", "Cargo.toml"), "--test", "conformance"],
      {
        env: cargo.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90_000,
      },
    );
    if (run.signalCode) {
      throw new Error(`cargo test conformance terminated by signal ${run.signalCode} (90s timeout check):\n${run.stderr.toString()}`);
    }
    expect(run.exitCode, `${run.stderr.toString()}\ntoolchain: ${cargo.describe()}`).toBe(0);
  }, 90_000);
});
