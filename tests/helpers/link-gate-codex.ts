import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePath } from "./repo-root";
import { preparePinnedCodex } from "./link-gate-binary";
import { removeTreeWithRetry } from "./remove-tree";

// The pinned Codex binary of the link WebSocket release gate (design T4 11.1 item 13, U13): codex-rs built at
// openai/codex 88c5856. Tests that drive it run only when OCX_LINK_GATE_CODEX names an executable; otherwise each is
// skipped with that reason. A run is release evidence only when the binary's sha256 equals the digest recorded for
// that revision in tests/fixtures/link-gate-codex.json, a file that changes only through review; any other executable
// runs as a smoke check, and each Codex scenario's title says which. Codex is an external process with no clock to inject, so
// each file carries a per-test bound. The scenarios wait on events, not on time, except the Child restart measurement,
// whose restart phases are wall-clock waits by design; every wait on an event also ends, with Codex's stderr, if Codex
// exits first (untilOrExit).

// OCX_LINK_GATE_CODEX is resolved once to an executable file and copied read-only into a scratch directory; that copy is
// what is hashed and what every scenario spawns, by absolute path (tests/helpers/link-gate-binary.ts).
// The copy belongs to the process, not to a file: a plain multi-file "bun test" shares one module registry, so every file
// that drives the pinned Codex uses the same copy, and it is removed when the process exits. With --isolate each file
// makes its own copy, removed at exit; a run killed by a signal leaves it. It is removed at once when the value is refused or preparing it throws. The fixture is read
// first, so a fixture error never leaves a copy behind.
export const GATE_PIN = JSON.parse(readFileSync(fixturePath("link-gate-codex.json"), "utf8")) as { revision: string; sha256: string | null };
const BIN_SCRATCH = process.env.OCX_LINK_GATE_CODEX ? mkdtempSync(join(tmpdir(), "ocx-link-gate-bin-")) : "";
function removePinnedCodexCopy(): void { if (BIN_SCRATCH) removeTreeWithRetry(BIN_SCRATCH); }
if (BIN_SCRATCH) process.once("exit", removePinnedCodexCopy);
const PREPARED = (() => {
  if (!BIN_SCRATCH) return null;
  try {
    const prepared = preparePinnedCodex(process.env.OCX_LINK_GATE_CODEX!, { scratch: BIN_SCRATCH });
    if (!prepared) removePinnedCodexCopy();
    return prepared;
  } catch (error) { removePinnedCodexCopy(); throw error; }
})();
export const GATE_BIN = PREPARED?.path ?? "";
export const gateUsable = PREPARED !== null;
const PINNED_SHA256 = typeof GATE_PIN.sha256 === "string" ? GATE_PIN.sha256.toLowerCase() : "";
const digest = PREPARED?.digest ?? "";
const mode: "absent" | "gate" | "smoke" = !gateUsable ? "absent" : PINNED_SHA256 && digest === PINNED_SHA256 ? "gate" : "smoke";
export const GATE_LABEL = {
  absent: " [skipped: pinned Codex binary absent (U13); set OCX_LINK_GATE_CODEX to an executable file of codex-rs built at openai/codex 88c5856]",
  gate: " [release gate: Codex sha256 " + digest + " matches the reviewed digest for openai/codex " + GATE_PIN.revision.slice(0, 7) + " in tests/fixtures/link-gate-codex.json]",
  smoke: " [smoke only, not release evidence: Codex sha256 " + digest + " is not the reviewed digest for openai/codex " + GATE_PIN.revision.slice(0, 7) + " (tests/fixtures/link-gate-codex.json" + (PINNED_SHA256 ? "" : " records none yet") + ")]",
}[mode];

/** A test that drives the pinned Codex: skipped without it, and labelled release gate or smoke only. */
export const gate = (title: string, body: () => Promise<void>) => test.skipIf(!gateUsable)(title + GATE_LABEL, body);

const sse = (type: string, data: unknown) => "event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n";

/** A turn that ends by calling get_goal, a read-only tool Codex declares, so Codex sends a second request. */
export function toolCall(id: string): string {
  const call = { type: "function_call", id: "fc_" + id, call_id: "call_gate_goal", name: "get_goal", status: "completed", arguments: "{}" };
  return [
    sse("response.created", { type: "response.created", response: { id, status: "in_progress", output: [] } }),
    sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: call }),
    sse("response.completed", { type: "response.completed", response: { id, status: "completed", output: [call], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
  ].join("");
}

export function completed(id: string): string {
  const message = { type: "message", id: "msg_" + id, role: "assistant", status: "completed", content: [{ type: "output_text", text: "gate-ok", annotations: [] }] };
  return [
    sse("response.created", { type: "response.created", response: { id, status: "in_progress", output: [] } }),
    sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: message }),
    sse("response.completed", { type: "response.completed", response: { id, status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
  ].join("");
}

export interface CodexRun { code: number; stdout: string; stderr: string }

/**
 * Runs one `codex exec` turn against `port`, with a scratch HOME and CODEX_HOME under `dir` and nothing else from
 * this machine. `streamMaxRetries` is Codex's per-provider stream_max_retries (the gate uses 3).
 */
export function runGateCodex(options: {
  dir: string; port: number; prompt: { argument: string } | { stdin: string };
  children: Array<ReturnType<typeof Bun.spawn>>; instructionsBytes?: number; streamMaxRetries?: number;
  /** Called with each line Codex writes to stderr, as it arrives (its retry and fallback notices). */
  onStderrLine?: (line: string) => void;
  /** Called as soon as the Codex process exits, before its output is collected. */
  onExit?: (code: number) => void;
}): Promise<CodexRun> {
  const scratch = mkdtempSync(join(options.dir, "codex-"));
  const codexDir = join(scratch, "codex-home");
  mkdirSync(codexDir, { recursive: true });
  // Codex caps a prompt at 1 MiB of characters; its base instructions have no such cap, so a large request comes from them.
  const instructions = options.instructionsBytes ? join(scratch, "instructions.md") : null;
  if (instructions) writeFileSync(instructions, "Answer with gate-ok.\n" + "x".repeat(options.instructionsBytes!));
  writeFileSync(join(codexDir, "config.toml"), [
    ...(instructions ? ["model_instructions_file = " + JSON.stringify(instructions)] : []),
    'model = "fixture/fixture"', 'model_provider = "ocxgate"', "model_context_window = 100000000",
    'approval_policy = "never"', 'sandbox_mode = "read-only"', "",
    "[model_providers.ocxgate]", 'name = "ocx gate"', 'base_url = "http://127.0.0.1:' + options.port + '/v1"', 'env_key = "OCX_GATE_KEY"',
    'wire_api = "responses"', "supports_websockets = true", "stream_max_retries = " + (options.streamMaxRetries ?? 3), "request_max_retries = 1", "",
  ].join("\n"));
  const prompt = options.prompt;
  const args = [GATE_BIN, "exec", "--skip-git-repo-check", "-C", scratch, "argument" in prompt ? prompt.argument : "-"];
  const child = Bun.spawn(args, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch, CODEX_HOME: codexDir, OCX_GATE_KEY: "gate-client-key" },
    stdin: "stdin" in prompt ? new TextEncoder().encode(prompt.stdin) : "ignore", stdout: "pipe", stderr: "pipe",
  });
  options.children.push(child);
  if (options.onExit) { const onExit = options.onExit; void child.exited.then(code => onExit(code)); }
  const stderr = (async () => {
    if (!options.onStderrLine) return await new Response(child.stderr).text();
    const decoder = new TextDecoder();
    let text = ""; let partial = "";
    for await (const chunk of child.stderr) {
      const piece = decoder.decode(chunk, { stream: true });
      text += piece; partial += piece;
      const lines = partial.split("\n"); partial = lines.pop() ?? "";
      for (const line of lines) options.onStderrLine(line);
    }
    if (partial) options.onStderrLine(partial);
    return text;
  })();
  return (async () => ({ code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await stderr }))();
}

/**
 * Waits for `event`, unless the Codex run ends first: then it fails at once with Codex's exit code and the tail of its
 * stderr, instead of holding the test until its bound.
 */
export function untilOrExit<T>(event: Promise<T>, run: Promise<CodexRun>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    event.then(value => { if (!done) { done = true; resolve(value); } }, error => { if (!done) { done = true; reject(error); } });
    // A later, ordinary exit after the event changes nothing and leaves no rejection behind.
    run.then(result => {
      if (done) return;
      done = true;
      reject(new Error("codex exited " + result.code + " before " + what + ": " + result.stderr.slice(-1500)));
    }, error => {
      // The run itself failed (its output could not be read): that ends the wait too. After the event it is left to the
      // caller's own await of the run; handling it here leaves no rejection unobserved either way.
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

/** Codex's own account of a failure is part of the evidence: a non-zero exit fails with the tail of its stderr. */
export function expectCompleted(result: CodexRun): void {
  if (result.code !== 0) throw new Error("codex exited " + result.code + ": " + result.stderr.slice(-1500));
  expect(result.stdout).toContain("gate-ok");
}
