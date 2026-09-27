import { describe, expect, test } from "bun:test";
import { codexRoutingDriftWarning } from "../../src/cli/status";
import { OCX_ROUTING_MARKER_LINE } from "../../src/codex/injected-marker";

const NO_JOURNAL = () => ({ openaiBaseUrl: null, realtimeWsBaseUrl: null });

function routedAt(port: number): string {
  const url = `http://127.0.0.1:${port}/v1`;
  return `${OCX_ROUTING_MARKER_LINE}\nopenai_base_url = "${url}"\n${OCX_ROUTING_MARKER_LINE}\nexperimental_realtime_ws_base_url = "${url}"\n`;
}

function warning(
  content: string | null,
  livePort: number | undefined,
  loopbackPort: number | null = null,
  siblingOfPort: number | undefined = undefined,
): string | null {
  return codexRoutingDriftWarning({ content, livePort, loopbackPort, siblingOfPort, journaled: NO_JOURNAL });
}

describe("ocx status: Codex routing port drift", () => {
  test("owned routing on a port the live proxy does not serve is reported", () => {
    const line = warning(routedAt(10199), 10100);
    expect(line).toContain("Codex routing points at port 10199, but the proxy is on 10100");
    expect(line).toContain("ocx sync");
    // Whether a healer runs is not visible from `ocx status`, so the line never promises one.
    expect(line).not.toContain("re-points it on its own");
    expect(line).toContain("may also");
  });

  test("the live port and the loopback-listener port are not drift", () => {
    expect(warning(routedAt(10100), 10100)).toBeNull();
    expect(warning(routedAt(10101), 10100, 10101)).toBeNull();
  });

  test("native, custom and external routing are never reported", () => {
    expect(warning('model = "gpt-5.5"\n', 10100)).toBeNull();
    expect(warning('openai_base_url = "http://127.0.0.1:4000/v1"\n', 10100)).toBeNull();
    expect(warning(`model_provider = "litellm"\n${routedAt(10199)}`, 10100)).toBeNull();
  });

  test("a sibling's report says nothing: its routing names the owner it runs beside", () => {
    // The sibling serves 10200; routing correctly names the live owner on 10100.
    expect(warning(routedAt(10100), 10200, null, 10100)).toBeNull();
    expect(warning(routedAt(10199), 10200, null, 10100)).toBeNull();
  });

  test("no config or no live port says nothing", () => {
    expect(warning(null, 10100)).toBeNull();
    expect(warning(routedAt(10199), undefined)).toBeNull();
  });
});
