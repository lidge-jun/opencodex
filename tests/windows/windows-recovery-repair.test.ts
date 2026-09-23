import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { repoPath } from "../helpers/repo-root";

const { runRepair } = require(repoPath("scripts", "ocx-recovery-guardian", "repair.cjs")) as {
  runRepair: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const ALLOWLIST = [
  "src/lib/runtime-diagnostics.ts",
  "src/lib/runtime-diagnostics-child.ts",
  "src/responses/state.ts",
  "src/codex/user-identity.ts",
  "scripts/windows-visible-proxy.ps1",
  "src/tray/windows-tray.ps1",
];
const homes: string[] = [];

function fixture(source = "export const value = 1;\n") {
  const home = join(tmpdir(), `ocx-repair-${crypto.randomUUID()}`);
  const projectRoot = join(home, "project");
  const incidentDir = join(home, "incident");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(incidentDir, { recursive: true });
  for (const relativePath of ALLOWLIST) {
    const target = join(projectRoot, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, relativePath.endsWith(".ps1") ? "$value = 1\n" : source);
  }
  homes.push(home);
  return { projectRoot, incidentDir };
}

function response(output: unknown) {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 });
}

function request(input: { projectRoot: string; incidentDir: string; fetchFn: typeof fetch }) {
  return runRepair({
    incident: { reason: "event_loop_delay", healthReady: false, attempts: 2, pid: 86488, timing: { delayMs: 7764 }, rawLog: "must-not-leave" },
    projectRoot: input.projectRoot,
    incidentDir: input.incidentDir,
    endpoint: "http://127.0.0.1:20128/v1",
    readKey: async () => "test-key",
    fetchFn: input.fetchFn,
  });
}

afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("ocx recovery guardian isolated GLM repair", () => {
  test("sends only sanitized bounded material and writes a review candidate, never production", async () => {
    const paths = fixture();
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchFn: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init! };
      return response({ diagnosis: "bounded candidate", patches: [{ path: "src/lib/runtime-diagnostics.ts", find: "value = 1", replace: "value = 2" }] })(url, init);
    };
    const result = await request({ ...paths, fetchFn });

    expect(result).toMatchObject({ outcome: "candidate_ready", model: "glm-5.3-flash", requestCount: 1, candidateCount: 1 });
    expect(captured?.url).toBe("http://127.0.0.1:20128/v1/chat/completions");
    const body = JSON.parse(String(captured?.init.body));
    expect(body).toMatchObject({ model: "ollama-local/glm-5.3-flash:cloud", stream: false, max_tokens: 4096, temperature: 0, response_format: { type: "json_object" } });
    expect(captured?.init.redirect).toBe("error");
    expect(JSON.stringify(body)).not.toContain("must-not-leave");
    expect(JSON.stringify(body)).not.toContain(paths.incidentDir);
    expect(JSON.stringify(body)).not.toContain(paths.projectRoot);
    expect(readFileSync(join(paths.projectRoot, "src", "lib", "runtime-diagnostics.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(readFileSync(join(paths.incidentDir, "candidate", "src", "lib", "runtime-diagnostics.ts"), "utf8")).toContain("value = 2");
    const metadata = JSON.parse(readFileSync(join(paths.incidentDir, "candidate", "metadata.json"), "utf8"));
    expect(JSON.stringify(metadata)).not.toContain("value = 2");
    expect(metadata.patches[0]).toMatchObject({ path: "src/lib/runtime-diagnostics.ts", patchStatus: expect.any(String) });
  });

  test("rejects a path outside the six-file allowlist", async () => {
    const paths = fixture();
    const result = await request({ ...paths, fetchFn: response({ diagnosis: "bad path", patches: [{ path: "src/server/index.ts", find: "x", replace: "y" }] }) });
    expect(result).toMatchObject({ outcome: "failed", failureClass: "MODEL_OUTPUT_INVALID" });
    expect(existsSync(join(paths.incidentDir, "candidate"))).toBeFalse();
  });

  test("rejects an ambiguous exact find and keeps production intact", async () => {
    const paths = fixture("export const value = 1;\nexport const another = 1;\n");
    const result = await request({ ...paths, fetchFn: response({ diagnosis: "ambiguous", patches: [{ path: "src/lib/runtime-diagnostics.ts", find: " = 1", replace: " = 2" }] }) });
    expect(result).toMatchObject({ outcome: "failed", failureClass: "MODEL_OUTPUT_INVALID" });
    expect(readFileSync(join(paths.projectRoot, "src", "lib", "runtime-diagnostics.ts"), "utf8")).toContain("another = 1");
  });

  test("rejects credential-like model echoes without creating candidates", async () => {
    const paths = fixture();
    const result = await request({ ...paths, fetchFn: response({ diagnosis: "api_key=do-not-store", patches: [] }) });
    expect(result).toMatchObject({ outcome: "failed", failureClass: "MODEL_OUTPUT_INVALID" });
    expect(existsSync(join(paths.incidentDir, "candidate"))).toBeFalse();
  });

  test("classifies network failure without a disk artifact", async () => {
    const paths = fixture();
    const fetchFn: typeof fetch = async () => { throw new TypeError("offline"); };
    const result = await request({ ...paths, fetchFn });
    expect(result).toMatchObject({ outcome: "failed", failureClass: "NETWORK", requestCount: 1 });
    expect(existsSync(join(paths.incidentDir, "candidate"))).toBeFalse();
  });

  test("uses no more than one root-supplied fallback endpoint with an independent key", async () => {
    const paths = fixture();
    const urls: string[] = [];
    const authorizations: string[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      urls.push(String(url));
      authorizations.push(String((init?.headers as Record<string, string>).authorization));
      if (urls.length === 1) throw new TypeError("offline");
      return response({ diagnosis: "fallback candidate", patches: [{ path: "src/lib/runtime-diagnostics.ts", find: "value = 1", replace: "value = 2" }] })(url, init);
    };
    const result = await runRepair({
      incident: { reason: "event_loop_delay", healthReady: false, attempts: 1, timing: { delayMs: 1 } },
      projectRoot: paths.projectRoot,
      incidentDir: paths.incidentDir,
      endpoint: "http://127.0.0.1:20128/v1",
      fallbackEndpoint: "https://api.mnnai.ru/v1",
      readKey: async () => "primary-key",
      readFallbackKey: async () => "fallback-key",
      fetchFn,
    });
    expect(result).toMatchObject({ outcome: "candidate_ready", requestCount: 2 });
    expect(urls).toEqual(["http://127.0.0.1:20128/v1/chat/completions", "https://api.mnnai.ru/v1/chat/completions"]);
    expect(authorizations).toEqual(["Bearer primary-key", "Bearer fallback-key"]);
  });

  test("rejects a fallback endpoint when no independent fallback key reader is supplied", async () => {
    const paths = fixture();
    const result = await runRepair({
      incident: { reason: "event_loop_delay", healthReady: false, attempts: 1, timing: { delayMs: 1 } },
      projectRoot: paths.projectRoot,
      incidentDir: paths.incidentDir,
      endpoint: "http://127.0.0.1:20128/v1",
      fallbackEndpoint: "https://api.mnnai.ru/v1",
      readKey: async () => "primary-key",
      fetchFn: response({ diagnosis: "not called", patches: [] }),
    });
    expect(result).toMatchObject({ outcome: "failed", failureClass: "INPUT_INVALID", requestCount: 0 });
  });

  test("forwards caller cancellation to an in-flight request and never starts fallback", async () => {
    const paths = fixture();
    const aborter = new AbortController();
    let fetchCalls = 0;
    let fallbackKeyReads = 0;
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    const fetchFn: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      fetchCalls += 1;
      started();
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true });
    });
    const pending = runRepair({
      incident: { reason: "event_loop_delay", healthReady: false, attempts: 1, timing: { delayMs: 1 } },
      projectRoot: paths.projectRoot,
      incidentDir: paths.incidentDir,
      endpoint: "http://127.0.0.1:11434/v1",
      fallbackEndpoint: "http://127.0.0.1:20128/v1",
      readKey: async () => "ollama-placeholder",
      readFallbackKey: async () => { fallbackKeyReads += 1; return "fallback-key"; },
      fetchFn,
      signal: aborter.signal,
    });
    await requestStarted;
    aborter.abort();
    await expect(pending).resolves.toMatchObject({ outcome: "cancelled", failureClass: "CANCELLED", requestCount: 1 });
    expect(fetchCalls).toBe(1);
    expect(fallbackKeyReads).toBe(0);
  });

  test("does not dispatch when cancellation races during readKey", async () => {
    const paths = fixture();
    const aborter = new AbortController();
    let fetchCalls = 0;
    const result = await runRepair({
      incident: { reason: "event_loop_delay", healthReady: false, attempts: 1, timing: { delayMs: 1 } },
      projectRoot: paths.projectRoot,
      incidentDir: paths.incidentDir,
      endpoint: "http://127.0.0.1:11434/v1",
      readKey: async () => { aborter.abort(); return "never-dispatch"; },
      fetchFn: async () => { fetchCalls += 1; return response({ diagnosis: "not called", patches: [] })(); },
      signal: aborter.signal,
    });
    expect(result).toMatchObject({ outcome: "cancelled", failureClass: "CANCELLED", requestCount: 0 });
    expect(fetchCalls).toBe(0);
  });

  test("returns the model diagnosis when no patch candidate is proposed", async () => {
    const paths = fixture();
    const result = await request({ ...paths, fetchFn: response({ diagnosis: "insufficient bounded evidence", patches: [] }) });
    expect(result).toMatchObject({ outcome: "no_candidate", diagnosis: "insufficient bounded evidence", candidateCount: 0 });
    expect(existsSync(join(paths.incidentDir, "candidate"))).toBeFalse();
  });

  test("uses the Ollama cloud wire model without changing the fixed logical model", async () => {
    const paths = fixture();
    let wireModel: string | null = null;
    const fetchFn: typeof fetch = async (_url, init) => {
      wireModel = JSON.parse(String(init?.body)).model;
      return response({ diagnosis: "Ollama candidate", patches: [{ path: "src/lib/runtime-diagnostics.ts", find: "value = 1", replace: "value = 2" }] })();
    };
    const result = await runRepair({
      incident: { reason: "event_loop_delay", healthReady: false, attempts: 1, timing: { delayMs: 1 } },
      projectRoot: paths.projectRoot,
      incidentDir: paths.incidentDir,
      endpoint: "http://127.0.0.1:11434/v1",
      readKey: async () => "placeholder-only",
      fetchFn,
    });
    expect(result).toMatchObject({ outcome: "candidate_ready", model: "glm-5.3-flash", requestCount: 1 });
    expect(wireModel).toBe("glm-5.3-flash:cloud");
  });

  test("uses the fixed loopback OpenRouter Ollama-local wire model without changing logical model", async () => {
    const paths = fixture();
    let wireModel: string | null = null;
    let requestUrl: string | null = null;
    const fetchFn: typeof fetch = async (url, init) => {
      requestUrl = String(url);
      wireModel = JSON.parse(String(init?.body)).model;
      return response({ diagnosis: "OpenRouter candidate", patches: [{ path: "src/lib/runtime-diagnostics.ts", find: "value = 1", replace: "value = 2" }] })();
    };
    const result = await runRepair({
      incident: { reason: "event_loop_delay", healthReady: false, attempts: 1, timing: { delayMs: 1 } },
      projectRoot: paths.projectRoot,
      incidentDir: paths.incidentDir,
      endpoint: "http://127.0.0.1:20128/v1",
      readKey: async () => "connection-bound-key",
      fetchFn,
    });
    expect(result).toMatchObject({ outcome: "candidate_ready", model: "glm-5.3-flash", requestCount: 1 });
    expect(requestUrl).toBe("http://127.0.0.1:20128/v1/chat/completions");
    expect(wireModel).toBe("ollama-local/glm-5.3-flash:cloud");
  });

  test("never overwrites a pre-existing candidate file", async () => {
    const paths = fixture();
    const candidate = join(paths.incidentDir, "candidate", "src", "lib", "runtime-diagnostics.ts");
    mkdirSync(dirname(candidate), { recursive: true });
    writeFileSync(candidate, "keep-existing-candidate\n");
    const result = await request({ ...paths, fetchFn: response({ diagnosis: "candidate", patches: [{ path: "src/lib/runtime-diagnostics.ts", find: "value = 1", replace: "value = 2" }] }) });
    expect(result).toMatchObject({ outcome: "failed", failureClass: "CANDIDATE_WRITE" });
    expect(readFileSync(candidate, "utf8")).toBe("keep-existing-candidate\n");
    expect(readFileSync(join(paths.projectRoot, "src", "lib", "runtime-diagnostics.ts"), "utf8")).toBe("export const value = 1;\n");
  });
});
