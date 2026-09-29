import { describe, expect, test } from "bun:test";
import { handleModelsRuntimeCommand } from "../../src/cli/models-runtime";
import { CAPABILITIES } from "../../src/cli/capabilities";
import { MANAGEMENT_ROUTES } from "../../src/server/management/route-registry";

/**
 * `ocx models set` is the CLI half of the per-model editor. It drives the same route the
 * dashboard does, and the tests below pin the mapping it must not blur: a clear is `null`, an
 * explicit empty ladder is `[]`, and neither is inferred from a value that merely looks empty.
 */
async function invoke(args: string[], response?: unknown, status = 200) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  try {
    const code = await handleModelsRuntimeCommand("set", args, {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: async (url, init) => {
        calls.push({
          path: new URL(String(url)).pathname,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (response instanceof Response) return response;
        return Response.json(response ?? { ok: true, changed: true }, { status });
      },
    });
    return { code, calls, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("models per-model settings command", () => {
  test("each option maps to its wire field and the selector keeps the upstream id intact", async () => {
    const result = await invoke([
      "vendor/org/model",
      "--context-window", "262144",
      "--modalities", "text,image",
      "--reasoning-efforts", "low,medium,high",
      "--default-reasoning-effort", "medium",
    ]);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([{
      path: "/api/model-settings",
      method: "PUT",
      body: {
        provider: "vendor",
        modelId: "org/model",
        contextWindow: 262144,
        inputModalities: ["text", "image"],
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
    }]);
  });

  test("every clear spelling sends null rather than a value that looks empty", async () => {
    const result = await invoke([
      "vendor/model",
      "--context-window", "-",
      "--modalities", "-",
      "--reasoning-efforts", "-",
      "--default-reasoning-effort", "-",
    ]);
    expect(result.code).toBe(0);
    expect(result.calls[0]!.body).toEqual({
      provider: "vendor",
      modelId: "model",
      contextWindow: null,
      inputModalities: null,
      reasoningEfforts: null,
      defaultReasoningEffort: null,
    });
    // Zero is the other documented spelling for "no window override", from ocx models edit.
    const zero = await invoke(["vendor/model", "--context-window", "0"]);
    expect(zero.calls[0]!.body).toEqual({ provider: "vendor", modelId: "model", contextWindow: null });
  });

  test("an explicit empty ladder is [] while - restores inheritance", async () => {
    const empty = await invoke(["vendor/model", "--reasoning-efforts", ""]);
    expect(empty.calls[0]!.body).toEqual({ provider: "vendor", modelId: "model", reasoningEfforts: [] });
    const inherit = await invoke(["vendor/model", "--reasoning-efforts", "-"]);
    expect(inherit.calls[0]!.body).toEqual({ provider: "vendor", modelId: "model", reasoningEfforts: null });
    const malformed = await invoke(["vendor/model", "--reasoning-efforts", "low,,high"]);
    expect(malformed.code).toBe(2);
    expect(malformed.calls).toEqual([]);
  });

  test("--reset clears every axis at once and refuses to be combined", async () => {
    const reset = await invoke(["vendor/model", "--reset"]);
    expect(reset.code).toBe(0);
    expect(reset.calls[0]!.body).toEqual({
      provider: "vendor",
      modelId: "model",
      contextWindow: null,
      inputModalities: null,
      reasoningEfforts: null,
      defaultReasoningEffort: null,
    });
    const combined = await invoke(["vendor/model", "--reset", "--modalities", "text"]);
    expect(combined.code).toBe(2);
    expect(combined.calls).toEqual([]);
  });

  test("a request with nothing to change, or a native selector, never reaches the API", async () => {
    const empty = await invoke(["vendor/model"]);
    expect(empty.code).toBe(2);
    expect(empty.calls).toEqual([]);
    const native = await invoke(["gpt-5.6-luna", "--modalities", "text"]);
    expect(native.code).toBe(2);
    expect(native.stderr).toContain("routed model");
    expect(native.calls).toEqual([]);
    const invalidWindow = await invoke(["vendor/model", "--context-window", "12k"]);
    expect(invalidWindow.code).toBe(2);
    expect(invalidWindow.calls).toEqual([]);
    const unsafeWindow = await invoke(["vendor/model", "--context-window", String(2 ** 60)]);
    expect(unsafeWindow.code).toBe(2);
    expect(unsafeWindow.calls).toEqual([]);
    // Only "-" clears: a blank value or blank member must not normalize to [] and clear silently.
    for (const raw of ["", ",", "text,,image", "video"]) {
      const blank = await invoke(["vendor/model", "--modalities", raw]);
      expect(blank.code).toBe(2);
      expect(blank.calls).toEqual([]);
    }
  });

  test("an unchanged answer says so instead of claiming a write", async () => {
    const result = await invoke(["vendor/model", "--reset"], { ok: true, changed: false, hasOverrides: false });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Nothing to restore");
    const retained = await invoke(["vendor/model", "--reset"], { ok: true, changed: false, hasOverrides: true });
    expect(retained.stdout).toContain("No settings changed");
    expect(retained.stdout).not.toContain("Nothing to restore");
    const stale = await invoke(["vendor/model", "--context-window", "200000"], {
      ok: true, changed: true, saved: true, catalogRefresh: { status: "failed" },
    });
    expect(stale.stdout).toContain("Settings saved, but the Codex model catalog did not refresh");
    const unmanaged = await invoke(["vendor/model", "--context-window", "200000"], {
      ok: true, changed: true, saved: true, catalogRefresh: { status: "skipped", reason: "catalog-unavailable", retryable: false },
    });
    expect(unmanaged.stdout).toContain("Updated model settings");
    expect(unmanaged.stdout).not.toContain("did not refresh");
  });

  test("the capability declares the route this verb drives", () => {
    const capability = CAPABILITIES.find(entry => entry.command.join(" ") === "models set");
    expect(capability?.routes).toEqual([{ method: "PUT", path: "/api/model-settings" }]);
    expect(capability?.mutates).toBe(true);
    expect(MANAGEMENT_ROUTES.some(route => route.method === "PUT" && route.path === "/api/model-settings")).toBe(true);
  });
});
