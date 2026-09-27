import { describe, expect, test } from "bun:test";
import { detectCodexRoutingDrift, type JournaledCodexRouting } from "../../src/codex/routing-drift";
import { OCX_ROUTING_MARKER_LINE } from "../../src/codex/injected-marker";

const OWN = [10100];
const NO_JOURNAL: JournaledCodexRouting = { openaiBaseUrl: null, realtimeWsBaseUrl: null };

/** The Design B root pair exactly as injection writes it. */
function designB(url: string, realtime = url): string {
  return [
    OCX_ROUTING_MARKER_LINE,
    `openai_base_url = "${url}"`,
    OCX_ROUTING_MARKER_LINE,
    `experimental_realtime_ws_base_url = "${realtime}"`,
    'model = "gpt-5.5"',
    "",
    "[features]",
    "fast_mode = true",
    "",
  ].join("\n");
}

describe("detectCodexRoutingDrift", () => {
  test("marker-owned root routing on another loopback port is foreign, both keys", () => {
    const drift = detectCodexRoutingDrift(designB("http://127.0.0.1:10199/v1"), { ownPorts: OWN });
    expect(drift).toEqual({
      kind: "foreign",
      targets: [
        { key: "openai_base_url", url: "http://127.0.0.1:10199/v1", hostname: "127.0.0.1", port: 10199 },
        { key: "experimental_realtime_ws_base_url", url: "http://127.0.0.1:10199/v1", hostname: "127.0.0.1", port: 10199 },
      ],
    });
  });

  test("a stripped marker still counts when the value equals the journaled URL (#1798)", () => {
    const url = "http://127.0.0.1:10199/v1";
    const rewritten = `openai_base_url = "${url}"\nexperimental_realtime_ws_base_url = "${url}"\n`;
    const drift = detectCodexRoutingDrift(rewritten, {
      ownPorts: OWN,
      journaled: () => ({ openaiBaseUrl: url, realtimeWsBaseUrl: url }),
    });
    expect(drift.kind).toBe("foreign");
    if (drift.kind === "foreign") expect(drift.targets.map(t => t.key)).toEqual(["openai_base_url", "experimental_realtime_ws_base_url"]);
  });

  test("an unmarked root URL with no journal match is the user's: not-owned", () => {
    const content = 'openai_base_url = "http://127.0.0.1:4000/v1"\n';
    expect(detectCodexRoutingDrift(content, { ownPorts: OWN, journaled: NO_JOURNAL })).toEqual({ kind: "not-owned" });
    expect(detectCodexRoutingDrift(content, {
      ownPorts: OWN,
      journaled: { openaiBaseUrl: "http://127.0.0.1:10199/v1", realtimeWsBaseUrl: null },
    })).toEqual({ kind: "not-owned" });
  });

  test("the opencodex provider table on a foreign port is foreign", () => {
    const content = [
      'model_provider = "opencodex"',
      "",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10199/v1"',
      "",
    ].join("\n");
    expect(detectCodexRoutingDrift(content, { ownPorts: OWN })).toEqual({
      kind: "foreign",
      targets: [{ key: "model_providers.opencodex.base_url", url: "http://127.0.0.1:10199/v1", hostname: "127.0.0.1", port: 10199 }],
    });
  });

  test("an external model_provider owns routing even beside an old opencodex line", () => {
    const content = `model_provider = "litellm"\n${designB("http://127.0.0.1:10199/v1")}\n[model_providers.litellm]\nbase_url = "http://127.0.0.1:4000/v1"\n`;
    expect(detectCodexRoutingDrift(content, { ownPorts: OWN })).toEqual({ kind: "not-owned" });
  });

  test("the bound port and the loopback-listener port are never drift", () => {
    expect(detectCodexRoutingDrift(designB("http://127.0.0.1:10100/v1"), { ownPorts: OWN })).toEqual({ kind: "none" });
    expect(detectCodexRoutingDrift(designB("http://127.0.0.1:10101/v1"), { ownPorts: [10100, 10101] })).toEqual({ kind: "none" });
  });

  test("the steady state reads no journal", () => {
    let reads = 0;
    const journaled = () => { reads++; return NO_JOURNAL; };
    detectCodexRoutingDrift(designB("http://127.0.0.1:10100/v1"), { ownPorts: OWN, journaled });
    detectCodexRoutingDrift('openai_base_url = "http://127.0.0.1:10100/v1"\n', { ownPorts: OWN, journaled });
    expect(reads).toBe(0);
  });

  test("[::1] and localhost spellings are loopback", () => {
    const v6 = detectCodexRoutingDrift(designB("http://[::1]:10199/v1"), { ownPorts: OWN });
    expect(v6.kind === "foreign" && v6.targets[0]).toEqual({ key: "openai_base_url", url: "http://[::1]:10199/v1", hostname: "::1", port: 10199 });
    const named = detectCodexRoutingDrift(designB("http://localhost:10199/v1"), { ownPorts: OWN });
    expect(named.kind === "foreign" && named.targets[0]?.hostname).toBe("localhost");
  });

  test("a realtime-only foreign override is foreign", () => {
    const drift = detectCodexRoutingDrift(designB("http://127.0.0.1:10100/v1", "http://127.0.0.1:10199/v1"), { ownPorts: OWN });
    expect(drift).toEqual({
      kind: "foreign",
      targets: [{ key: "experimental_realtime_ws_base_url", url: "http://127.0.0.1:10199/v1", hostname: "127.0.0.1", port: 10199 }],
    });
  });

  test("a URL without an explicit port or on a non-loopback host is ignored", () => {
    expect(detectCodexRoutingDrift(designB("http://127.0.0.1/v1"), { ownPorts: OWN })).toEqual({ kind: "none" });
    expect(detectCodexRoutingDrift(designB("http://192.168.1.20:10199/v1"), { ownPorts: OWN })).toEqual({ kind: "none" });
    expect(detectCodexRoutingDrift(designB("https://hub.example.test:8443/v1"), { ownPorts: OWN })).toEqual({ kind: "none" });
  });

  test("native config is not-owned", () => {
    expect(detectCodexRoutingDrift('model = "gpt-5.5"\n', { ownPorts: OWN })).toEqual({ kind: "not-owned" });
    expect(detectCodexRoutingDrift("", { ownPorts: OWN })).toEqual({ kind: "not-owned" });
  });

  test("CRLF files are read the same way", () => {
    const drift = detectCodexRoutingDrift(designB("http://127.0.0.1:10199/v1").replace(/\n/g, "\r\n"), { ownPorts: OWN });
    expect(drift.kind).toBe("foreign");
  });
});
