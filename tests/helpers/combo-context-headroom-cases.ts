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

/** Register under the caller's isolated homes, mock state and server cleanup hooks. */
export function registerComboContextHeadroomCases<Server>({
  serve, baseUrl, chatSuccess, provider, comboConfig, post,
}: ComboHarness<Server>): void {
  test("combo skips a target that cannot fit input plus requested output before any bytes commit", async () => {
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
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(small), "key-a", {
        modelContextWindows: { m1: 128_000 },
        modelMaxOutputTokens: { m1: 32_000 },
      }),
      b: provider("openai-chat", baseUrl(large), "key-b", {
        modelContextWindows: { m2: 1_000_000 },
        modelMaxOutputTokens: { m2: 128_000 },
      }),
    });
    const response = await post(config, {
      input: "a".repeat(400_000), // about 100k estimated input tokens
      max_output_tokens: 64_000,
    });
    expect(response.status).toBe(200);
    expect(smallHits).toBe(0);
    expect(largeHits).toBe(1);
    expect(await response.text()).toContain("large context target");
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
