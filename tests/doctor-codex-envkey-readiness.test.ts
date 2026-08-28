import { describe, expect, test } from "bun:test";
import { collectCodexEnvKeyReadiness } from "../src/cli/doctor";
import type { CodexShimDiagnostic } from "../src/codex/shim";

const config = `
model_provider = "opencodex"

[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
env_key = "OPENCODEX_API_AUTH_TOKEN"
`;

const missingShim: CodexShimDiagnostic = {
  installed: false,
  healthy: false,
  summary: "Codex autostart shim is not installed.",
};

const healthyShim: CodexShimDiagnostic = {
  installed: true,
  healthy: true,
  summary: "healthy",
};

describe("doctor Codex env_key launch readiness", () => {
  test("warns when env_key is unset, the shim is missing, and a service token exists", () => {
    expect(collectCodexEnvKeyReadiness(config, {}, missingShim, true)).toEqual({
      envName: "OPENCODEX_API_AUTH_TOKEN",
      shimState: "missing",
      detail: "Codex uses env_key OPENCODEX_API_AUTH_TOKEN, but that variable is unset and the OpenCodex shim is missing; the service token file exists but plain Codex does not load it",
      action: "Run 'ocx codex-shim install' to repair launch-time token injection, or export OPENCODEX_API_AUTH_TOKEN in the process that starts Codex",
    });
  });

  test("distinguishes an installed but unhealthy shim", () => {
    const row = collectCodexEnvKeyReadiness(config, {}, { ...missingShim, installed: true }, true);
    expect(row?.shimState).toBe("unhealthy");
  });

  test("does not warn when the configured environment variable is set", () => {
    expect(collectCodexEnvKeyReadiness(config, { OPENCODEX_API_AUTH_TOKEN: "secret" }, missingShim, true)).toBeNull();
  });

  test("treats prototype names as unset unless they are own environment properties", () => {
    const prototypeNameConfig = config.replace("OPENCODEX_API_AUTH_TOKEN", "toString");
    expect(() => collectCodexEnvKeyReadiness(prototypeNameConfig, {}, missingShim, true)).not.toThrow();
    expect(collectCodexEnvKeyReadiness(prototypeNameConfig, {}, missingShim, true)?.envName).toBe("toString");
    expect(collectCodexEnvKeyReadiness(prototypeNameConfig, { toString: "set" }, missingShim, true)).toBeNull();
  });

  test("does not warn when the shim is healthy", () => {
    expect(collectCodexEnvKeyReadiness(config, {}, healthyShim, true)).toBeNull();
  });

  test("does not warn when no usable service token exists", () => {
    expect(collectCodexEnvKeyReadiness(config, {}, missingShim, false)).toBeNull();
  });

  test("ignores another active provider and env_key text outside the active table", () => {
    const other = `${config.replace('model_provider = "opencodex"', 'model_provider = "openai"')}\n# env_key = "SHOULD_NOT_MATCH"`;
    expect(collectCodexEnvKeyReadiness(other, {}, missingShim, true)).toBeNull();
  });

  test("never includes token material in output", () => {
    const token = "super-secret-fixture-token";
    const row = collectCodexEnvKeyReadiness(config, {}, missingShim, Boolean(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });
});
