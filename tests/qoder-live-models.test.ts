import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchQoderModels, parseQoderModelList, setFetchQoderModelsForTests } from "../src/adapters/qoder/live-models";
import { clearQoderBinaryCache, QODER_CN_PROFILE, QODER_GLOBAL_PROFILE } from "../src/adapters/qoder/profiles";
import { fetchProviderModels } from "../src/codex/catalog/provider-fetch";
import { clearModelCache, providerCacheGenerations } from "../src/codex/model-cache";
import type { OcxProviderConfig } from "../src/types";

beforeEach(() => clearQoderBinaryCache());
afterEach(() => {
  setFetchQoderModelsForTests(null);
  clearModelCache("qoder-test");
  providerCacheGenerations.delete("qoder-test");
});

describe("qoder live model discovery", () => {
  test("parses the documented plaintext table with validation and dedupe", () => {
    expect(parseQoderModelList("MODEL\nQwen3.8-Max\nQwen3.8-Max\nGLM-5.3\n")).toEqual({ ok: true, models: ["Qwen3.8-Max", "GLM-5.3"] });
    expect(parseQoderModelList("warning that is not a roster\n")).toMatchObject({ ok: false, error: "invalid_output" });
  });

  test("passes PAT only in scoped env and supports Windows cmd shims", async () => {
    let seen: { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
    const exec = async (command: string, args: readonly string[], options: { env: Record<string, string> }) => {
      seen = { command, args, env: options.env };
      return { stdout: "MODEL\nQwen3.8-Max\n", stderr: "" };
    };
    const result = await fetchQoderModels(QODER_GLOBAL_PROFILE, "secret-pat", { platform: "win32", which: () => "C:\\npm\\qoder.cmd", exec });
    expect(result).toEqual({ ok: true, models: ["Qwen3.8-Max"] });
    expect(seen?.command.toLowerCase()).toContain("cmd.exe");
    expect(seen?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(seen?.env?.QODER_PERSONAL_ACCESS_TOKEN).toBe("secret-pat");
  });

  test("CN discovery selects qodercn and passes only the CN PAT variable", async () => {
    let seen: { command: string; env: Record<string, string> } | undefined;
    const result = await fetchQoderModels(QODER_CN_PROFILE, "cn-secret", {
      which: candidate => candidate === "qodercn" ? "/bin/qodercn" : undefined,
      exec: async (command, _args, options) => {
        seen = { command, env: options.env };
        return { stdout: "MODEL\nQwen3.8-Max\nQwen3.8-Flash\n", stderr: "" };
      },
    });
    expect(result).toEqual({ ok: true, models: ["Qwen3.8-Max", "Qwen3.8-Flash"] });
    expect(seen?.command).toBe("/bin/qodercn");
    expect(seen?.env.QODERCN_PERSONAL_ACCESS_TOKEN).toBe("cn-secret");
    expect(seen?.env.QODER_PERSONAL_ACCESS_TOKEN).toBeUndefined();
  });

  test("live account roster is authoritative and static models are only fallback", async () => {
    setFetchQoderModelsForTests((_profile, token) => token === "pat" ? { ok: true, models: ["Account-Model"] } : { ok: false, error: "auth" });
    const provider = { adapter: "qoder", baseUrl: "https://qoder.com", apiKey: "pat", authMode: "key", liveModels: true, models: ["Static-Model"] } as OcxProviderConfig;
    const models = await fetchProviderModels("qoder-test", provider, 60_000);
    expect(models.map(model => model.id)).toEqual(["Account-Model"]);
  });

  test("a PAT change cannot reuse the previous account's entitlement cache", async () => {
    const calls: string[] = [];
    setFetchQoderModelsForTests((_profile, token) => {
      calls.push(token);
      return { ok: true, models: [`${token}-model`] };
    });
    const base = { adapter: "qoder", baseUrl: "https://qoder.com", authMode: "key", liveModels: true } as OcxProviderConfig;
    const accountA = await fetchProviderModels("qoder-test", { ...base, apiKey: "account-a" }, 60_000);
    const accountB = await fetchProviderModels("qoder-test", { ...base, apiKey: "account-b" }, 60_000);
    expect(accountA.map(model => model.id)).toEqual(["account-a-model"]);
    expect(accountB.map(model => model.id)).toEqual(["account-b-model"]);
    expect(calls).toEqual(["account-a", "account-b"]);
  });

  test("sequential accounts receive only their own PAT and authentication failures are redacted", async () => {
    const credentials: string[] = [];
    const exec = async (_command: string, _args: readonly string[], options: { env: Record<string, string> }) => {
      const token = options.env.QODER_PERSONAL_ACCESS_TOKEN ?? "";
      credentials.push(token);
      if (token === "bad-secret") {
        throw Object.assign(new Error("auth failed"), { stderr: `Not logged in: QODER_PERSONAL_ACCESS_TOKEN=${token}` });
      }
      return { stdout: `MODEL\n${token}-model\n`, stderr: "" };
    };
    const first = await fetchQoderModels(QODER_GLOBAL_PROFILE, "account-a", { which: () => "/bin/qoder", exec });
    const second = await fetchQoderModels(QODER_GLOBAL_PROFILE, "account-b", { which: () => "/bin/qoder", exec });
    const failed = await fetchQoderModels(QODER_GLOBAL_PROFILE, "bad-secret", { which: () => "/bin/qoder", exec });
    expect(credentials).toEqual(["account-a", "account-b", "bad-secret"]);
    expect(first).toEqual({ ok: true, models: ["account-a-model"] });
    expect(second).toEqual({ ok: true, models: ["account-b-model"] });
    expect(failed).toMatchObject({ ok: false, error: "auth" });
    expect(JSON.stringify(failed)).not.toContain("bad-secret");
  });
});
