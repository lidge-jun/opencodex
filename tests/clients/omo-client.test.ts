import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ClientPathError,
  EXPORT_CLIENTS,
  LOOPBACK_API_KEY_PLACEHOLDER,
  OPENCODE_PROVIDER_ID,
  buildClientConfig,
  buildClientConfigText,
  buildClientContribution,
  omoAgentDir,
  omoConfigPath,
  type ExportContext,
  type PiGeneratedConfig,
} from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import type { OcxConfig } from "../../src/types";

const CONFIG = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

function context(): ExportContext {
  return {
    baseUrl: "http://127.0.0.1:10100/v1",
    config: CONFIG,
    models: [
      { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5", contextWindow: 200_000, inputModalities: ["text", "image"] },
      { namespaced: "openai/gpt-5.6-sol", provider: "openai", id: "gpt-5.6-sol", contextWindow: 922_000, reasoningEfforts: ["low", "medium", "high"] },
      // No authoritative context window: ships without limits rather than guessing.
      { namespaced: "mystery/model", provider: "mystery", id: "model" },
    ],
  };
}

describe("omo client config", () => {
  /**
   * The opposite of Prime's assertion, deliberately.
   *
   * Prime and Aside reuse Pi's builder with the session-affinity flag left at
   * its default, because nobody has verified that their engines read it. omo's
   * engine WAS verified: senpi's compiled validator accepts `compat` with
   * `sendSessionAffinityHeaders`, so omo opts in and the generated provider is
   * byte-identical to Pi's.
   */
  test("is Pi's document including the session-affinity opt-in", () => {
    const omo = buildClientConfig("omo", context()) as PiGeneratedConfig;
    const pi = buildClientConfig("pi", context()) as PiGeneratedConfig;
    expect(omo).toEqual(pi);
    expect(omo.providers[OPENCODE_PROVIDER_ID]!.compat).toEqual({ sendSessionAffinityHeaders: true });
  });

  /**
   * The flag has to be on BOTH paths or they drift: `build` feeds `ocx export`
   * and `/api/client-config`, while `buildContribution` is what the writer
   * actually puts on disk when the integration is enabled or refreshed. One
   * carrying `compat` and the other not would look correct in every unit test
   * that only reads one of them.
   */
  test("the exported document and the written fragment are the same bytes", () => {
    const document = buildClientConfig("omo", context()) as PiGeneratedConfig;
    expect(buildClientContribution("omo", context()).fragments[0]!.value)
      .toEqual(document.providers[OPENCODE_PROVIDER_ID]);
  });

  test("adds only providers.opencodex, wired to the loopback proxy", () => {
    const document = buildClientConfig("omo", context()) as PiGeneratedConfig;
    expect(Object.keys(document)).toEqual(["providers"]);
    expect(Object.keys(document.providers)).toEqual([OPENCODE_PROVIDER_ID]);
    const provider = document.providers[OPENCODE_PROVIDER_ID]!;
    expect(provider.baseUrl).toBe("http://127.0.0.1:10100/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe(LOOPBACK_API_KEY_PLACEHOLDER);
  });

  test("native JSON round-trips and never carries a credential", () => {
    const sentinel = ["sk", "live", "omo", "sentinel"].join("-");
    const withKey = { ...CONFIG, apiKeys: [{ key: sentinel }] } as OcxConfig;
    const built = buildClientConfigText("omo", { ...context(), config: withKey });
    expect(JSON.parse(built.text)).toEqual(built.document as never);
    expect(built.text).not.toContain(sentinel);
    expect(built.text).toContain(LOOPBACK_API_KEY_PLACEHOLDER);
  });

  test("the contribution owns exactly the providers.opencodex path under its own id", () => {
    const contribution = buildClientContribution("omo", context());
    // Reusing Pi's builder must not leak Pi's id into the ownership record, or
    // the writer would stamp one client's block with the other's name.
    expect(contribution.clientId).toBe("omo");
    expect(contribution.fragments.map(f => f.path)).toEqual([["providers", OPENCODE_PROVIDER_ID]]);
  });

  /**
   * omo publishes three variables and reads them in this order, then pins the
   * first two for the senpi process it spawns. Checking them in any other order
   * would write a catalog omo never opens.
   */
  test("resolves omo's own three-variable precedence", () => {
    expect(omoAgentDir({}, "/home/u")).toBe(join("/home/u", ".omo", "agent"));
    expect(omoConfigPath({}, "/home/u")).toBe(join("/home/u", ".omo", "agent", "models.json"));

    expect(omoConfigPath({ OMO_CODING_AGENT_DIR: "/from-omo" }, "/home/u")).toBe(join("/from-omo", "models.json"));
    expect(omoConfigPath({ SENPI_CODING_AGENT_DIR: "/from-senpi" }, "/home/u")).toBe(join("/from-senpi", "models.json"));
    expect(omoConfigPath({ PI_CODING_AGENT_DIR: "/from-pi" }, "/home/u")).toBe(join("/from-pi", "models.json"));

    // Precedence, not merely recognition.
    expect(omoConfigPath({
      OMO_CODING_AGENT_DIR: "/from-omo",
      SENPI_CODING_AGENT_DIR: "/from-senpi",
      PI_CODING_AGENT_DIR: "/from-pi",
    }, "/home/u")).toBe(join("/from-omo", "models.json"));
    expect(omoConfigPath({
      SENPI_CODING_AGENT_DIR: "/from-senpi",
      PI_CODING_AGENT_DIR: "/from-pi",
    }, "/home/u")).toBe(join("/from-senpi", "models.json"));

    // omo trims and then tests truthiness, so a blank value is not a path.
    expect(omoConfigPath({ OMO_CODING_AGENT_DIR: "   ", PI_CODING_AGENT_DIR: "/from-pi" }, "/home/u"))
      .toBe(join("/from-pi", "models.json"));
    expect(omoConfigPath({ OMO_CODING_AGENT_DIR: "" }, "/home/u"))
      .toBe(join("/home/u", ".omo", "agent", "models.json"));

    expect(omoConfigPath({ OMO_CODING_AGENT_DIR: "~/alt" }, "/home/u")).toBe(join("/home/u", "alt", "models.json"));
  });

  /**
   * Each variable reports under its own name. Telling someone their
   * `PI_CODING_AGENT_DIR` is relative when they set `OMO_CODING_AGENT_DIR`
   * sends them to the wrong line of their shell profile.
   */
  test("refuses a relative override and names the variable that carried it", () => {
    expect(() => omoConfigPath({ OMO_CODING_AGENT_DIR: "relative" }, "/home/u")).toThrow(ClientPathError);
    expect(() => omoConfigPath({ OMO_CODING_AGENT_DIR: "relative" }, "/home/u")).toThrow(/OMO_CODING_AGENT_DIR/);
    expect(() => omoConfigPath({ SENPI_CODING_AGENT_DIR: "relative" }, "/home/u")).toThrow(/SENPI_CODING_AGENT_DIR/);
    expect(() => omoConfigPath({ PI_CODING_AGENT_DIR: "relative" }, "/home/u")).toThrow(/PI_CODING_AGENT_DIR/);
  });

  /**
   * The AGENT directory, not `~/.omo`. The v4 launcher wrapper creates
   * `~/.omo` for its `binary-runtime` without ever creating `agent/`, so
   * detecting on the parent reports a v5 install that is not there.
   */
  test("detects installation by the agent directory, not the brand directory", () => {
    const spec = INTEGRATION_CLIENTS.omo;
    expect(spec.detectDir({}, "/home/u")).toBe(join("/home/u", ".omo", "agent"));
    expect(spec.detectDir({}, "/home/u")).not.toBe(join("/home/u", ".omo"));
    expect(spec.detectDir({ OMO_CODING_AGENT_DIR: "/elsewhere" } as NodeJS.ProcessEnv, "/home/u")).toBe("/elsewhere");
  });

  test("ships as a loopback-only integration with no env var to export", () => {
    const spec = EXPORT_CLIENTS.omo;
    expect(spec.loopbackOnly).toBe(true);
    expect(spec.apiKeyEnv).toBe("");
    // Not a bare models.json: a download would collide with pi's, prime's and
    // aside's in the user's Downloads folder.
    expect(spec.filename).toBe("omo-models.json");
  });
});
