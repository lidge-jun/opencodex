/**
 * Reading the prompt text Codex actually assembles.
 *
 * The read-only dialog used to say Codex "does not expose" a layer's text. That
 * was wrong: Codex is open source and ships `codex debug prompt-input`, which
 * renders the model-visible input list as JSON. Reading it is the difference
 * between describing a layer and showing it.
 *
 * What this does NOT cover, stated rather than implied:
 *
 * - `base-instructions` is absent. `prompt_debug.rs` returns `prompt.input` and
 *   discards `base_instructions`, so the base prompt never appears here.
 * - World-state sections are DIFF-rendered (`add_section` registers state, it does
 *   not emit text). A section that renders nothing on a first turn is missing
 *   from this output even though its layer exists.
 * - The output reflects the invoking directory and the current config, not a
 *   universal prompt.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveCodexHomeDir } from "./home";

/**
 * Layer id -> the tag Codex actually renders it under.
 *
 * Every entry here was read off live `codex debug prompt-input` output across the
 * feature flags that enable each section. None is inferred from the Rust section
 * `ID` constants: those are identifiers for diffing, not wrapper tags, and an
 * earlier guess from them mapped `permissions` to the wrong name while the real
 * tag - `permissions instructions`, with a space - went unmatched.
 *
 * A layer absent from this map is reported as unsupported, never as silent.
 */
const LAYER_SECTION_TAGS: Record<string, string> = {
  skills: "skills_instructions",
  apps: "apps_instructions",
  plugins: "plugins_instructions",
  environment: "environment_context",
  permissions: "permissions instructions",
  // Synthetic: the project doc carries no tag of its own (see extractSections).
  "agents-md": "__agents_md",
};

/**
 * Inventory ids with no confirmed tag in the rendered output. They are listed
 * explicitly rather than left missing: an absent entry made the dialog report a
 * successful probe as unavailable.
 */
const UNMAPPED_LAYER_IDS = [
  "model-switch",
  "context-window-guidance",
  "environments-instructions",
  "tools",
  "multi-agent-mode",
  // Confirmed absent from live output under their own feature flags, so the
  // previous `personality` / `realtime` guesses reported these as silent when the
  // truth is that this extractor has no verified tag for them.
  "personality",
  "realtime",
  "collaboration",
  // The Rust source names a <git_attribution> marker pair, but a world-state section is
  // DIFF-rendered: it emits nothing on a turn where its state has not changed. Live
  // `codex debug prompt-input` (codex-cli 0.145.0, 32978 bytes) showed no such block and
  // no attribution text. Listing the id here reports "not exposed" honestly instead of
  // claiming a tag this extractor has never actually matched - the same mistake the
  // header above records for permissions.
  "git-attribution",
] as const;

export interface LayerText {
  /** Rendered text, when this layer produced a section on the probed turn. */
  text: string | null;
  /** Why the text is absent, when it is. */
  reason: "ok" | "empty-source" | "not-rendered" | "not-exposed" | "unavailable";
  bytes: number;
  /** For `empty-source`: the file that exists but has nothing in it. */
  sourcePath?: string;
}

export interface PromptTextProbe {
  ok: boolean;
  /** The Codex home the probe reported on. */
  codexHome: string;
  layers: Record<string, LayerText>;
  detail?: string;
}

function resolveCodexBinary(): string | null {
  const candidates = [
    join(homedir(), ".codex/packages/standalone/current/bin/codex"),
    join(homedir(), ".local/bin/codex"),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ];
  return candidates.find(path => existsSync(path)) ?? null;
}

/** 8 MiB is far above any real prompt and far below anything that hurts the server. */
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;

interface ProbeCommand {
  binary: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  promptStateFingerprint: string | null;
}

interface PromptProbeFlight {
  key: string;
  controller: AbortController;
  result: Promise<string | null>;
  closed: Promise<void>;
  waiters: number;
  joinable: boolean;
  resultSettled: boolean;
  settled: boolean;
}

interface PromptProbeExecution {
  result: Promise<string | null>;
  closed: Promise<void>;
}

type SharedPromptProbeOutcome =
  | { kind: "output"; raw: string }
  | { kind: "failed" }
  | { kind: "busy" };

let activePromptProbe: PromptProbeFlight | null = null;
let probeCommandForTests: { binary: string; args: string[] } | null = null;
let probeSpawnAttemptsForTests = 0;
let probeCloseBarrierForTests: Promise<void> | null = null;

function commandKey(command: ProbeCommand): string {
  return JSON.stringify([
    command.binary,
    command.args,
    command.cwd,
    command.timeoutMs,
    command.promptStateFingerprint,
  ]);
}

function completedExecution(value: string | null): PromptProbeExecution {
  return { result: Promise.resolve(value), closed: Promise.resolve() };
}

function runProbe(
  command: ProbeCommand,
  signal: AbortSignal,
  onStopping: () => void,
): PromptProbeExecution {
  if (signal.aborted) return completedExecution(null);
  let resolveResult!: (value: string | null) => void;
  let resolveClosed!: () => void;
  const result = new Promise<string | null>(resolve => { resolveResult = resolve; });
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let resultSettled = false;
  let closeSettled = false;

  const finishResult = (value: string | null) => {
    if (resultSettled) return;
    resultSettled = true;
    resolveResult(value);
  };
  const finishClosed = () => {
    if (closeSettled) return;
    closeSettled = true;
    resolveClosed();
  };

  try {
    // A probe must never hang OR balloon the management API: it is bounded in
    // time AND in bytes, and every failure degrades to "unavailable" rather than
    // an error page.
    let child: ReturnType<typeof spawn>;
    try {
      if (probeCommandForTests) probeSpawnAttemptsForTests += 1;
      child = spawn(command.binary, command.args, {
        cwd: command.cwd,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finishResult(null);
      finishClosed();
      return { result, closed };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let stopping = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      finishResult(value);
      finishClosed();
    };

    // Keep the flight admitted until `close`: kill() only requests termination
    // and does not prove the exact child has released its process and stdio.
    const terminate = () => {
      if (settled || stopping) return;
      stopping = true;
      onStopping();
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      // The caller is bounded even if OS termination later fails. Admission is
      // retained separately by `closed`, and later probes fail soft while this
      // exact child remains unproven terminal.
      finishResult(null);
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Exact child state is ambiguous. Keep admission non-joinable until its
        // own `close` proves terminal instead of targeting a reusable numeric PID.
      }
    };
    const onAbort = () => terminate();

    timer = setTimeout(terminate, command.timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROBE_OUTPUT_BYTES) { terminate(); return; }
      chunks.push(chunk);
    });
    child.on("error", () => {
      // No PID means spawn itself failed, so there is no live child to drain.
      if (child.pid === undefined) {
        finish(null);
      }
      else terminate();
    });
    child.on("close", code => {
      // Decode once, at the end: `String(chunk)` per chunk corrupts any UTF-8
      // character that straddles a chunk boundary.
      const recordClose = () => {
        finish(!stopping && code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
      };
      const barrier = probeCloseBarrierForTests;
      if (barrier) void barrier.then(recordClose, recordClose);
      else recordClose();
    });
    // Close the race between the pre-spawn check and listener registration.
    if (signal.aborted) terminate();
  } catch {
    finishResult(null);
    finishClosed();
  }
  return { result, closed };
}

function startPromptProbeFlight(command: ProbeCommand): PromptProbeFlight {
  const controller = new AbortController();
  const flight: PromptProbeFlight = {
    key: commandKey(command),
    controller,
    result: Promise.resolve(null),
    closed: Promise.resolve(),
    waiters: 0,
    joinable: true,
    resultSettled: false,
    settled: false,
  };
  const execution = runProbe(command, controller.signal, () => {
    flight.joinable = false;
  });
  flight.result = execution.result
    .catch(() => null)
    .finally(() => {
      flight.resultSettled = true;
    });
  flight.closed = execution.closed
    .finally(() => {
      flight.settled = true;
      if (activePromptProbe === flight) activePromptProbe = null;
    });
  activePromptProbe = flight;
  return flight;
}

async function runSharedPromptProbe(
  command: ProbeCommand,
  signal?: AbortSignal,
): Promise<SharedPromptProbeOutcome> {
  const key = commandKey(command);
  if (signal?.aborted) return { kind: "failed" };
  const active = activePromptProbe;
  if (!active) {
    const raw = await waitForPromptProbeFlight(startPromptProbeFlight(command), signal);
    return raw === null ? { kind: "failed" } : { kind: "output", raw };
  }
  if (active.key === key && active.joinable && !active.controller.signal.aborted) {
    const raw = await waitForPromptProbeFlight(active, signal);
    return raw === null ? { kind: "failed" } : { kind: "output", raw };
  }
  // A different or terminating flight still owns the sole process slot. Never
  // wait unboundedly for an unproven close and never launch beside it.
  return { kind: "busy" };
}

async function waitForPromptProbeFlight(flight: PromptProbeFlight, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) {
    if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
    return null;
  }
  flight.waiters += 1;
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await flight.result;
    const aborted = new Promise<null>(resolve => {
      onAbort = () => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return await Promise.race([flight.result, aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    flight.waiters = Math.max(0, flight.waiters - 1);
    if (flight.waiters === 0 && !flight.resultSettled) {
      flight.controller.abort(new DOMException("All prompt probe callers cancelled", "AbortError"));
    }
  }
}

/** Pull every `<tag>...</tag>` section out of the rendered developer messages. */
function extractSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return sections;
  }
  if (!Array.isArray(parsed)) return sections;
  for (const item of parsed) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const text = content.map(part => String((part as { text?: unknown }).text ?? "")).join("");
    // Tag names are NOT all snake_case: Codex renders `<permissions instructions>`
    // with a space. A `[a-z_]+` pattern silently skipped it, and the layer was
    // reported as "sent nothing" while its text sat right there.
    for (const match of text.matchAll(/<([a-zA-Z_][a-zA-Z0-9_ -]*)>([\s\S]*?)<\/\1>/g)) {
      sections.set(match[1]!, match[2]!.trim());
    }
    // AGENTS.md is NOT tagged: it arrives as a plain `# AGENTS.md instructions
    // for <path>` block among the tagged sections. Matching only on tags would
    // report the layer as unrendered while its text sits in the same message.
    //
    // Bounded at both ends. Capturing to end-of-message swept up any unrelated
    // untagged prose that happened to follow, and stripping tag-shaped blocks
    // first also deleted XML-like text the user had written INSIDE their own
    // AGENTS.md. Codex wraps the body in <INSTRUCTIONS>, so that is the boundary.
    // No line anchor: the block is concatenated directly onto the previous
    // section's closing tag, so requiring a newline before it never matched.
    const projectDoc = /# AGENTS\.md instructions for [^\n]*\n+<INSTRUCTIONS>\n?([\s\S]*?)\n?<\/INSTRUCTIONS>/.exec(text);
    if (projectDoc) sections.set("__agents_md", projectDoc[1]!.trim());
  }
  return sections;
}

/** Test seam: the extraction is the part worth pinning, not the spawn. */
export const extractSectionsForTests = extractSections;

/**
 * Probe once and map every known layer to its rendered text.
 *
 * `cwd` matters: AGENTS.md and environment context are directory-dependent, so a
 * probe from the wrong place would describe a prompt the user never sees.
 */
export async function probePromptText(
  timeoutMs = 15_000,
  signal?: AbortSignal,
  promptStateFingerprint: string | null = null,
): Promise<PromptTextProbe> {
  // The probe runs in CODEX_HOME, never in a caller-supplied directory. A `cwd`
  // parameter let an authenticated request read any readable folder's AGENTS.md,
  // and it also described a prompt that depends on where Codex happened to run.
  // The global home is the one context this page can honestly report on.
  const codexHome = resolveCodexHomeDir();
  if (signal?.aborted) {
    return { ok: false, codexHome, layers: {}, detail: "prompt probe cancelled" };
  }
  const binary = probeCommandForTests?.binary ?? resolveCodexBinary();
  if (!binary) {
    return { ok: false, codexHome, layers: {}, detail: "codex binary not found" };
  }
  const command: ProbeCommand = {
    binary,
    args: probeCommandForTests?.args ?? ["debug", "prompt-input"],
    cwd: codexHome,
    timeoutMs,
    promptStateFingerprint,
  };
  const outcome = await runSharedPromptProbe(command, signal);
  if (outcome.kind !== "output") {
    return {
      ok: false,
      codexHome,
      layers: {},
      detail: signal?.aborted
        ? "prompt probe cancelled"
        : outcome.kind === "busy"
          ? "another prompt probe is still finishing; retry shortly"
          : "codex debug prompt-input failed",
    };
  }
  const raw = outcome.raw;
  const sections = extractSections(raw);
  if (sections.size === 0) {
    // Zero sections from a zero-exit probe means the output did not parse, which
    // is a failed read - not fifteen layers that each chose to send nothing.
    return { ok: false, codexHome, layers: {}, detail: "prompt output could not be parsed" };
  }
  const layers: Record<string, LayerText> = {};
  for (const [layerId, tag] of Object.entries(LAYER_SECTION_TAGS)) {
    const text = sections.get(tag) ?? null;
    layers[layerId] = text === null
      // Registered but not rendered on this turn, which is an ordinary state for
      // a diff-rendered section rather than an error.
      ? { text: null, reason: "not-rendered", bytes: 0 }
      : { text, reason: "ok", bytes: Buffer.byteLength(text, "utf8") };
  }

  // A file that exists and is empty is not the same as a layer that chose to send
  // nothing. Reporting "sent nothing" for an empty AGENTS.md tells the user their
  // layer is idle when the real answer is that the file they wrote is blank.
  const agentsMdPath = join(codexHome, "AGENTS.md");
  if (layers["agents-md"]?.reason === "not-rendered" && existsSync(agentsMdPath)) {
    try {
      if (statSync(agentsMdPath).size === 0) {
        layers["agents-md"] = { text: null, reason: "empty-source", bytes: 0, sourcePath: agentsMdPath };
      }
    } catch {
      // An unreadable file stays "not-rendered": we cannot claim it is empty.
    }
  }
  // The base prompt travels outside prompt.input and cannot be read this way.
  layers["base-instructions"] = { text: null, reason: "not-exposed", bytes: 0 };

  // Layers whose rendered tag we have not confirmed against live output. Leaving
  // them absent made the GUI fall through to "unavailable", which claims the probe
  // failed when it succeeded. Saying we have no mapping is the smaller claim.
  for (const id of UNMAPPED_LAYER_IDS) {
    layers[id] ??= { text: null, reason: "not-exposed", bytes: 0 };
  }
  return { ok: true, codexHome, layers };
}

/** Test-only command seam; production always resolves the installed Codex binary. */
export function setPromptTextProbeCommandForTests(command: { binary: string; args: string[] } | null): void {
  probeCommandForTests = command ? { binary: command.binary, args: [...command.args] } : null;
}

/** Test-only process-start counter for proving admission without timing guesses. */
export function promptTextProbeSpawnAttemptsForTests(): number {
  return probeSpawnAttemptsForTests;
}

/** Test-only close barrier for proving admission is not released at process exit. */
export function setPromptTextProbeCloseBarrierForTests(barrier: Promise<void> | null): void {
  probeCloseBarrierForTests = barrier;
}

/** Test-only fail-closed drain so one failed lifecycle case cannot poison another. */
export async function resetPromptTextProbeForTests(): Promise<void> {
  const active = activePromptProbe;
  if (active && !active.settled) {
    active.controller.abort(new DOMException("Prompt probe test reset", "AbortError"));
    const drained = await Promise.race([
      active.closed.then(() => true),
      Bun.sleep(2_000).then(() => false),
    ]);
    if (!drained) throw new Error("prompt probe child did not close during test reset");
  }
  if (activePromptProbe === active) activePromptProbe = null;
  probeCommandForTests = null;
  probeSpawnAttemptsForTests = 0;
  probeCloseBarrierForTests = null;
}
