import { expect, test } from "bun:test";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

interface ComboHarness<Server> {
  serve(handler: () => Response | Promise<Response>): Server;
  baseUrl(server: Server): string;
  chatSuccess(text: string, model?: string): Response;
  provider(adapter: string, url: string, apiKey: string, extra?: Partial<OcxProviderConfig>): OcxProviderConfig;
  comboConfig(providers: OcxConfig["providers"]): OcxConfig;
  post(config: OcxConfig, raw?: Record<string, unknown>): Promise<Response>;
}

/** Roughly `tokens` worth of plain ASCII at the default 4 chars/token ratio. */
function asciiTokens(tokens: number): string {
  return "a".repeat(tokens * 4);
}

/** Register under the caller's isolated homes, mock state and server cleanup hooks. */
export function registerComboContextHeadroomCases<Server>({
  serve, baseUrl, chatSuccess, provider, comboConfig, post,
}: ComboHarness<Server>): void {
  test("a target that cannot hold input plus requested output is skipped before any bytes commit", async () => {
    let smallHits = 0;
    let largeHits = 0;
    const small = serve(() => {
      smallHits += 1;
      return chatSuccess("MUST NOT RUN", "m1");
    });
    const large = serve(() => {
      largeHits += 1;
      return chatSuccess("large context target", "m2");
    });
    // ~10k input, and m1 can reach 3,200 output inside a 12,800 window, so the turn cannot
    // finish there. m2 holds the same turn with the caller's full 6,400 allowance.
    const response = await post(comboConfig({
      a: provider("openai-chat", baseUrl(small), "key-a", {
        modelContextWindows: { m1: 12_800 },
        modelMaxOutputTokens: { m1: 3_200 },
      }),
      b: provider("openai-chat", baseUrl(large), "key-b", {
        modelContextWindows: { m2: 100_000 },
        modelMaxOutputTokens: { m2: 32_000 },
      }),
    }), { input: asciiTokens(10_000), max_output_tokens: 6_400 });
    expect(response.status).toBe(200);
    expect(smallHits).toBe(0);
    expect(largeHits).toBe(1);
    expect(await response.text()).toContain("large context target");
  });

  test("the same undersized target still serves a turn that declares no output allowance", async () => {
    // The strict reserve is opt-in on the caller's declared allowance. Without one, the
    // deliberately loose pathological-input gate still applies and nothing is skipped.
    let smallHits = 0;
    const small = serve(() => {
      smallHits += 1;
      return chatSuccess("small context target", "m1");
    });
    const response = await post(comboConfig({
      a: provider("openai-chat", baseUrl(small), "key-a", {
        modelContextWindows: { m1: 12_800 },
        modelMaxOutputTokens: { m1: 3_200 },
      }),
    }), { input: asciiTokens(10_000) });
    expect(response.status).toBe(200);
    expect(smallHits).toBe(1);
    expect(await response.text()).toContain("small context target");
  });

  test("provider-specific prompt-too-long 400 hops to a larger-context combo target", async () => {
    let backupHits = 0;
    const capped = serve(() => Response.json({ error: {
      message: "Prompt 346030 > 262144 maximum context length",
      type: "invalid_request_prompt_too_long",
      code: "5059",
      raw_status_code: 400,
    } }, { status: 400 }));
    const backup = serve(() => {
      backupHits += 1;
      return chatSuccess("larger context backup", "m2");
    });
    const response = await post(comboConfig({
      a: provider("openai-chat", baseUrl(capped), "key-a"),
      b: provider("openai-chat", baseUrl(backup), "key-b"),
    }));
    expect(response.status).toBe(200);
    expect(backupHits).toBe(1);
    expect(await response.text()).toContain("larger context backup");
  });
}

