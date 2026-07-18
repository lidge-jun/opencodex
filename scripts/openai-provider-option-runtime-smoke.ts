import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateLivePolicy, type LiveOutcome } from "./openai-hardening-live-policy";
import { buildSanitizedRuntimeEnv } from "./openai-hardening-runtime-env";

type ChildReady = {
  type: "ready";
  pid: number;
  port: number;
  version: string;
  catalogReady: boolean;
};

type Capture = {
  upstream: string;
  model: string;
  reasoningMode: string | null;
  credentialOwner: string;
  accountOwner: string | null;
};

type ListenerIdentity = {
  present: boolean;
  listeners: Array<{ pid: number; command: string; endpoint: string }>;
};

function argValue(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

const repoRoot = resolve(import.meta.dir, "..");
const unitRootCandidates = [
  "devlog/_plan/260717_openai_single_provider_option",
  "devlog/_fin/260717_openai_single_provider_option",
].map(path => resolve(repoRoot, path));
const defaultUnitRoot = unitRootCandidates.find(existsSync) ?? unitRootCandidates[0]!;
const unitRoot = resolve(repoRoot, argValue("--unit-root") ?? defaultUnitRoot);
const evidenceDir = resolve(repoRoot, argValue("--evidence-dir") ?? join(unitRoot, "evidence"));
const runtimeEvidencePath = join(evidenceDir, "030_runtime_smoke.json");

function atomicJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

function resolveConfiguredKey(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value);
  if (!match) return value;
  return process.env[match[1] ?? match[2] ?? ""]?.trim() || null;
}

function listenerIdentity10100(): ListenerIdentity {
  const result = Bun.spawnSync([
    "lsof", "-nP", "-iTCP@127.0.0.1:10100", "-sTCP:LISTEN", "-Fpcn",
  ], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return { present: false, listeners: [] };
  const listeners: ListenerIdentity["listeners"] = [];
  let current: Partial<ListenerIdentity["listeners"][number]> = {};
  for (const line of new TextDecoder().decode(result.stdout).split(/\r?\n/)) {
    if (line.startsWith("p")) {
      if (current.pid !== undefined) listeners.push({
        pid: current.pid,
        command: current.command ?? "unknown",
        endpoint: current.endpoint ?? "127.0.0.1:10100",
      });
      current = { pid: Number(line.slice(1)) };
    } else if (line.startsWith("c")) current.command = line.slice(1);
    else if (line.startsWith("n")) current.endpoint = line.slice(1);
  }
  if (current.pid !== undefined) listeners.push({
    pid: current.pid,
    command: current.command ?? "unknown",
    endpoint: current.endpoint ?? "127.0.0.1:10100",
  });
  return { present: listeners.length > 0, listeners };
}

async function checkLiveKey(): Promise<void> {
  const configHome = process.env.OPENCODEX_HOME?.trim() || join(homedir(), ".opencodex");
  const configPath = join(configHome, "config.json");
  let key: string | null = null;
  if (existsSync(configPath)) {
    let raw: { providers?: Record<string, { apiKey?: unknown }> };
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8")) as typeof raw;
    } catch {
      throw new Error("OpenCodex config is malformed; live-key status cannot be determined safely");
    }
    key = resolveConfiguredKey(raw.providers?.["openai-apikey"]?.apiKey);
  }

  const authorized = process.env.OCX_ALLOW_LIVE_OPENAI_SMOKE === "1";
  const outcomes: LiveOutcome[] = [];
  if (key && authorized) {
    for (const [selectedId, resolvedId, reasoning] of [
      ["openai-apikey/gpt-5.6-sol", "gpt-5.6-sol", { effort: "low" }],
      ["openai-apikey/gpt-5.6-sol-pro", "gpt-5.6-sol", { effort: "low", mode: "pro" }],
    ] as const) {
      try {
        const response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: resolvedId, input: "Reply OK", max_output_tokens: 8, reasoning }),
        });
        outcomes.push({ status: response.status, requestId: response.headers.get("x-request-id"), selectedId, resolvedId });
        await response.body?.cancel().catch(() => undefined);
      } catch {
        outcomes.push({ status: 0, requestId: null, selectedId, resolvedId });
      }
    }
  }
  const decision = evaluateLivePolicy(Boolean(key), authorized, outcomes);
  const existing = existsSync(runtimeEvidencePath)
    ? JSON.parse(readFileSync(runtimeEvidencePath, "utf8")) as Record<string, unknown>
    : { schemaVersion: 1, verdict: "PASS" };
  atomicJson(runtimeEvidencePath, {
    ...existing,
    liveKey: { status: decision.status, liveCalls: decision.liveCalls, outcomes },
  });
  process.stdout.write(`${decision.status}\n`);
  if (decision.failed) process.exitCode = 1;
}

if (Bun.argv.includes("--check-live-key")) {
  try {
    await checkLiveKey();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  function hashFile(path: string): { exists: boolean; sha256: string | null } {
    if (!existsSync(path)) return { exists: false, sha256: null };
    return { exists: true, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
  }

  function stateHashes(rows: ReadonlyArray<readonly [string, string]>): Record<string, { exists: boolean; sha256: string | null }> {
    return Object.fromEntries(rows.map(([label, path]) => [label, hashFile(path)]));
  }

  const liveBefore = listenerIdentity10100();
  const realOcxHome = process.env.OPENCODEX_HOME?.trim() || join(homedir(), ".opencodex");
  const realCodexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const realState = [
    ["opencodex-config", join(realOcxHome, "config.json")],
    ["opencodex-oauth", join(realOcxHome, "auth.json")],
    ["opencodex-codex-accounts", join(realOcxHome, "codex-accounts.json")],
    ["codex-config", join(realCodexHome, "config.toml")],
    ["codex-auth", join(realCodexHome, "auth.json")],
  ] as const;
  const hashesBefore = stateHashes(realState);

  const root = mkdtempSync(join(tmpdir(), "ocx-provider-option-runtime-smoke-"));
  const opencodexHome = join(root, "opencodex");
  const codexHome = join(root, "codex");
  const workdir = join(root, "work");
  const capturePath = join(root, "capture.json");
  mkdirSync(workdir, { recursive: true, mode: 0o700 });
  const env = buildSanitizedRuntimeEnv(process.env, opencodexHome, codexHome);
  const children: Bun.Subprocess[] = [];

  async function startChild(): Promise<{ child: Bun.Subprocess; ready: ChildReady }> {
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "openai-provider-option-runtime-child.ts"),
      opencodexHome,
      codexHome,
      capturePath,
    ], { cwd: workdir, env, stdout: "pipe", stderr: "pipe" });
    children.push(child);
    const reader = child.stdout.getReader();
    const readiness = (async (): Promise<ChildReady> => {
      let buffer = "";
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("runtime child exited before readiness");
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as Partial<ChildReady>;
            if (parsed.type === "ready" && typeof parsed.pid === "number" && typeof parsed.port === "number"
              && typeof parsed.version === "string" && parsed.catalogReady === true) {
              if (parsed.port === 10100) throw new Error("isolated runtime selected forbidden live port 10100");
              return parsed as ChildReady;
            }
          } catch (error) {
            if (error instanceof Error && error.message.includes("forbidden live port")) throw error;
            // startServer writes human-readable startup lines before the readiness receipt.
          }
        }
      }
    })();
    try {
      const ready = await Promise.race([
        readiness,
        Bun.sleep(15_000).then(() => { throw new Error("runtime child readiness timed out"); }),
      ]);
      reader.releaseLock();
      return { child, ready };
    } catch (error) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
      const stderr = await new Response(child.stderr).text();
      throw new Error(`${error instanceof Error ? error.message : String(error)}: ${stderr.trim().slice(0, 500)}`);
    }
  }

  async function stopChild(child: Bun.Subprocess): Promise<void> {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }

  async function runtimeProbe(port: number, model: string, authorization: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ model, input: "runtime fixture", stream: true }),
    });
    const text = await response.text();
    if (!response.ok || !text.includes("OCX_PROBE_OK")) {
      throw new Error(`runtime ${model} probe failed with status ${response.status}`);
    }
  }

  async function patchMode(port: number, mode: "pool" | "direct"): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${port}/api/providers?name=openai`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer fixture-admission" },
      body: JSON.stringify({ codexAccountMode: mode }),
    });
    const body = await response.json() as { codexAccountMode?: string };
    if (!response.ok || body.codexAccountMode !== mode) {
      throw new Error(`runtime mode PATCH failed with status ${response.status}`);
    }
  }

  function redactFailure(value: string): string {
    const line = value.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "no diagnostic output";
    return line
      .replaceAll(root, "<temp>")
      .replaceAll("fixture-api-key", "<redacted>")
      .replaceAll("fixture-codex-access", "<redacted>")
      .replaceAll("Reply exactly OCX_PROBE_OK", "<probe-prompt>")
      .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
      .slice(0, 500);
  }

  async function runCodexAttempt(attempt: number): Promise<{ ok: boolean; failure?: string; version: string }> {
    if (attempt > 1) rmSync(join(codexHome, "sessions"), { recursive: true, force: true });
    const versionProc = Bun.spawn(["codex", "--version"], { cwd: workdir, env, stdout: "pipe", stderr: "pipe" });
    const codexVersion = (await new Response(versionProc.stdout).text()).trim();
    if (await versionProc.exited !== 0) return { ok: false, failure: "codex --version failed", version: "unknown" };

    const codex = Bun.spawn([
      "codex", "exec", "--skip-git-repo-check", "--ignore-rules",
      "-C", workdir,
      "--model", "openai-apikey/gpt-5.6-sol-pro",
      "--sandbox", "read-only", "--json",
      "Reply exactly OCX_PROBE_OK",
    ], { cwd: workdir, env, stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      codex.kill("SIGKILL");
    }, 60_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(codex.stdout).text(),
      new Response(codex.stderr).text(),
      codex.exited,
    ]);
    clearTimeout(timeout);
    if (exitCode === 0 && stdout.includes("OCX_PROBE_OK")) return { ok: true, version: codexVersion };
    return {
      ok: false,
      version: codexVersion,
      failure: timedOut ? "timeout after 60 seconds" : `exit ${exitCode}: ${redactFailure(stderr)}`,
    };
  }

  try {
    const first = await startChild();
    const firstHealth = await fetch(`http://127.0.0.1:${first.ready.port}/healthz`).then(response => response.json()) as ChildReady;
    if (firstHealth.pid !== first.ready.pid
      || (firstHealth.port !== first.ready.port && firstHealth.port !== 0)
      || firstHealth.version !== first.ready.version) {
      throw new Error("first runtime readiness receipt does not match /healthz");
    }
    await stopChild(first.child);

    const second = await startChild();
    const secondHealth = await fetch(`http://127.0.0.1:${second.ready.port}/healthz`).then(response => response.json()) as ChildReady;
    if (secondHealth.pid !== second.ready.pid
      || (secondHealth.port !== second.ready.port && secondHealth.port !== 0)
      || secondHealth.version !== second.ready.version) {
      throw new Error("second runtime readiness receipt does not match /healthz");
    }
    if (first.ready.pid === second.ready.pid) throw new Error("runtime child PID did not change across cold starts");

    await runtimeProbe(second.ready.port, "gpt-5.6-sol", "Bearer fixture-admission");
    await patchMode(second.ready.port, "direct");
    await runtimeProbe(second.ready.port, "gpt-5.6-terra", "Bearer fixture-direct-caller");

    let codexResult: Awaited<ReturnType<typeof runCodexAttempt>> | null = null;
    const failures: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await runCodexAttempt(attempt);
      if (result.ok) {
        codexResult = result;
        break;
      }
      failures.push(`attempt ${attempt}: ${result.failure ?? "unknown failure"}`);
    }

    if (!codexResult) {
      atomicJson(join(evidenceDir, "030_client_history.json"), {
        schemaVersion: 1,
        verdict: "FAIL",
        attempts: 2,
        failure: failures.join(" | "),
      });
      throw new Error(`isolated codex exec failed after two attempts: ${failures.join(" | ")}`);
    }

    const sessionsDir = join(codexHome, "sessions");
    const rolloutPaths = existsSync(sessionsDir)
      ? readdirSync(sessionsDir, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(entry => join(entry.parentPath, entry.name))
      : [];
    if (rolloutPaths.length !== 1) throw new Error(`expected one temporary rollout, found ${rolloutPaths.length}`);
    const records = readFileSync(rolloutPaths[0]!, "utf8").split(/\r?\n/).filter(Boolean)
      .map(line => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> });
    const sessionMeta = records.find(record => record.type === "session_meta")?.payload;
    const turnContext = records.find(record => record.type === "turn_context")?.payload;
    const captures = JSON.parse(readFileSync(capturePath, "utf8")) as Capture[];
    const poolCapture = captures.find(row => row.credentialOwner === "openai-pool-added");
    const directCapture = captures.find(row => row.credentialOwner === "openai-direct-main");
    const apiCapture = captures.findLast(row => row.credentialOwner === "openai-apikey");
    if (!poolCapture || poolCapture.model !== "gpt-5.6-sol" || poolCapture.accountOwner === null) {
      throw new Error("runtime Pool added-account ownership mismatch");
    }
    if (!directCapture || directCapture.model !== "gpt-5.6-terra" || directCapture.accountOwner !== null) {
      throw new Error("runtime Direct caller ownership mismatch");
    }
    if (!apiCapture || apiCapture.model !== "gpt-5.6-sol" || apiCapture.reasoningMode !== "pro") {
      throw new Error("runtime API-Pro upstream identity mismatch");
    }
    if (turnContext?.model !== "openai-apikey/gpt-5.6-sol-pro") {
      throw new Error(`unexpected rollout selected model: ${String(turnContext?.model)}`);
    }
    if (sessionMeta?.model_provider !== "openai") {
      throw new Error(`unexpected rollout model provider: ${String(sessionMeta?.model_provider)}`);
    }

    const modelRows = await fetch(`http://127.0.0.1:${second.ready.port}/api/models`, {
      headers: { authorization: "Bearer fixture-admission" },
    }).then(response => response.json()) as Array<{ provider?: string; id?: string; namespaced?: string; native?: boolean }>;
    if (!modelRows.some(row => row.provider === "openai" && row.native === true && row.namespaced === row.id)) {
      throw new Error("runtime catalog is missing the bare OpenAI group");
    }
    if (!modelRows.some(row => row.namespaced === "openai-apikey/gpt-5.6-sol-pro")) {
      throw new Error("runtime catalog is missing the API Pro row");
    }
    if (modelRows.some(row => row.namespaced?.startsWith("openai-multi/"))) {
      throw new Error("runtime catalog exposes the legacy namespace");
    }

    const clientHistory = {
      schemaVersion: 1,
      verdict: "PASS",
      selectedModel: turnContext.model,
      modelProvider: sessionMeta.model_provider,
      resolvedModel: apiCapture.model,
      reasoningMode: apiCapture.reasoningMode,
      rolloutCount: 1,
      attempts: failures.length + 1,
    };

    await stopChild(second.child);
    const hashesAfter = stateHashes(realState);
    if (JSON.stringify(hashesBefore) !== JSON.stringify(hashesAfter)) {
      throw new Error("real user state changed during isolated runtime smoke");
    }
    const liveAfter = listenerIdentity10100();
    if (JSON.stringify(liveBefore) !== JSON.stringify(liveAfter)) {
      throw new Error("live 127.0.0.1:10100 listener identity changed during isolated runtime smoke");
    }

    atomicJson(join(evidenceDir, "030_client_history.json"), clientHistory);
    atomicJson(join(evidenceDir, "live_10100_before_after.json"), {
      schemaVersion: 1,
      verdict: "PASS",
      before: liveBefore,
      after: liveAfter,
      unchanged: true,
    });
    const previousLiveKey = existsSync(runtimeEvidencePath)
      ? (JSON.parse(readFileSync(runtimeEvidencePath, "utf8")) as { liveKey?: unknown }).liveKey
      : undefined;
    atomicJson(runtimeEvidencePath, {
      schemaVersion: 1,
      verdict: "PASS",
      instances: [
        { pid: first.ready.pid, version: first.ready.version, port: first.ready.port },
        { pid: second.ready.pid, version: second.ready.version, port: second.ready.port },
      ],
      distinctPids: true,
      catalogReady: true,
      poolDefault: {
        providerName: "openai",
        accountMode: "pool",
        selectedModel: "gpt-5.6-sol",
        wireModel: poolCapture.model,
        upstream: poolCapture.upstream,
        credentialOwner: "added",
        safeAccountOwner: "added",
      },
      direct: {
        providerName: "openai",
        accountMode: "direct",
        selectedModel: "gpt-5.6-terra",
        wireModel: directCapture.model,
        upstream: directCapture.upstream,
        credentialOwner: "caller",
        safeAccountOwner: null,
      },
      apiPro: {
        providerName: "openai-apikey",
        accountMode: null,
        selectedModel: "openai-apikey/gpt-5.6-sol-pro",
        wireModel: apiCapture.model,
        reasoningMode: apiCapture.reasoningMode,
        upstream: apiCapture.upstream,
        credentialOwner: "api-key",
        safeAccountOwner: null,
      },
      oneOpenAiModelGroup: true,
      clientHistoryVerified: true,
      codexVersion: codexResult.version,
      userStateUnchanged: true,
      live10100Unchanged: true,
      liveKey: previousLiveKey ?? { status: "NOT RUN (live spend not authorized)", liveCalls: 0, outcomes: [] },
    });
    process.stdout.write(JSON.stringify({
      verdict: "PASS",
      pid: second.ready.pid,
      version: second.ready.version,
      port: second.ready.port,
      poolDefault: "PASS",
      direct: "PASS",
      apiPro: "PASS",
      clientHistory: clientHistory.verdict,
      live10100Unchanged: true,
    }) + "\n");
  } finally {
    for (const child of children) await stopChild(child).catch(() => undefined);
    const hashesAfterFinally = stateHashes(realState);
    const liveAfterFinally = listenerIdentity10100();
    rmSync(root, { recursive: true, force: true });
    if (JSON.stringify(hashesBefore) !== JSON.stringify(hashesAfterFinally)) {
      throw new Error("real user state changed during runtime-smoke teardown");
    }
    if (JSON.stringify(liveBefore) !== JSON.stringify(liveAfterFinally)) {
      throw new Error("live 127.0.0.1:10100 listener identity changed during runtime-smoke teardown");
    }
  }
}
