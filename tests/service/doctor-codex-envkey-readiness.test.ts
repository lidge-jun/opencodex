import { isolateCodexShimEnvironment, withInstalledShim } from "../helpers/codex-shim-install-fixture";
import { describe, expect, test } from "bun:test";
import { collectCodexEnvKeyReadiness, formatCodexShimDoctorLines } from "../../src/cli/doctor";
import { diagnoseCodexShim, type CodexShimDiagnostic } from "../../src/codex/shim";
import { join } from "node:path";

isolateCodexShimEnvironment();

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

  test("an inactive runnable overlay keeps the token warning and advises shell activation", () => {
    const row = collectCodexEnvKeyReadiness(config, {}, {
      installed: true, healthy: false, runnable: true, active: false, summary: "inactive",
    }, true);
    expect(row?.shimState).toBe("inactive");
    expect(row?.detail).toContain("variable is unset");
    expect(row?.action).toContain("codex-shell-env.sh");
    expect(row?.action).not.toContain("codex-shim install");
    expect(row?.action).toContain("Absolute Codex paths and GUI launchers bypass");
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

describe.skipIf(process.platform === "win32")("doctor general Codex shim guidance", () => {
  test.each([
    { name: "no Codex config", text: null, env: {}, token: true },
    { name: "native provider", text: 'model_provider = "openai"', env: {}, token: true },
    { name: "exported env_key", text: config, env: { OPENCODEX_API_AUTH_TOKEN: "set" }, token: true },
    { name: "no service token", text: config, env: {}, token: false },
  ])("inactive overlay prints shell activation with $name", scenario => withInstalledShim(f => {
    const shim = diagnoseCodexShim();
    expect(shim).toMatchObject({ runnable: true, active: false });
    expect(collectCodexEnvKeyReadiness(scenario.text, scenario.env, shim, scenario.token)).toBeNull();
    const lines = formatCodexShimDoctorLines(shim).join("\n");
    expect(lines).toContain(`run . '${join(f.home, "codex-shell-env.sh")}'`);
    expect(lines).toContain("after other PATH setup in your shell startup file");
  }));

  test("token warning refers to restart guidance without duplicating the source command", () => withInstalledShim(() => {
    const shim = diagnoseCodexShim();
    const lines = formatCodexShimDoctorLines(shim);
    const row = collectCodexEnvKeyReadiness(config, {}, shim, true, lines.length > 0);
    expect(row?.shimState).toBe("inactive");
    expect(row?.detail).toContain("variable is unset");
    expect(row?.action).toContain("Codex restart safety");
    expect(row?.action).toContain("or export OPENCODEX_API_AUTH_TOKEN");
    expect(`${lines.join("\n")}\n${row?.action}`.split("codex-shell-env.sh")).toHaveLength(2);
  }));

  test("healthy legacy guidance remains visible without an env_key warning", () => {
    const shim = { ...healthyShim, summary: "Legacy Unix shim installed in place; run ocx codex-shim install." };
    expect(collectCodexEnvKeyReadiness(config, {}, shim, true)).toBeNull();
    expect(formatCodexShimDoctorLines(shim)).toEqual([`       ${shim.summary}`]);
  });

  test("Windows, missing, damaged, and active shims receive no Unix activation hint", () => {
    const inactive = { installed: true, healthy: false, runnable: true, active: false, summary: "inactive" };
    expect(formatCodexShimDoctorLines(inactive, "win32")).toEqual([]);
    expect(formatCodexShimDoctorLines(missingShim)).toEqual([]);
    expect(formatCodexShimDoctorLines({ ...inactive, runnable: false })).toEqual([]);
    expect(formatCodexShimDoctorLines({ ...inactive, active: true, healthy: true })).toEqual([]);
  });
});
