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
 * - `base-instructions` is absent from the probed output: Codex returns
 *   `prompt.input` and discards `base_instructions`, so the base prompt never
 *   appears there. It is read here from the configured sources instead - the
 *   `model_instructions_file` override when one is set, otherwise the selected
 *   model's catalog row - and reported separately as `base`.
 * - World-state sections are DIFF-rendered (`add_section` registers state, it does
 *   not emit text). A section that renders nothing on a first turn is missing
 *   from this output even though its layer exists.
 * - The output reflects the invoking directory and the current config, not a
 *   universal prompt.
 */
import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandUserPath } from "../config";
import { parseCatalogJson, readCodexCatalogPathForHome, type RawCatalog, type RawEntry } from "./catalog/parsing";
import { codexExecInvocation } from "./exec-invocation";
import { resolveCodexHomeDir } from "./home";
import {
  CODEX_PROGRAM_NOT_FOUND_REASON,
  displayCodexRuntimePath,
  resolveCodexRuntime,
  type CodexRuntimeSource,
  type ResolveCodexRuntimeResult,
} from "./runtime";

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
  // no attribution text. Listing the id here reports "unmapped" honestly instead of
  // claiming a tag this extractor has never actually matched - the same mistake the
  // header above records for permissions.
  "git-attribution",
] as const;

export interface LayerText {
  /** Rendered text, when this layer produced a section on the probed turn. */
  text: string | null;
  /** Why the text is absent, when it is. */
  reason: "ok" | "empty-source" | "not-rendered" | "not-exposed" | "unmapped" | "unavailable";
  bytes: number;
  /**
   * `expanded` is text Codex sends as written. `template` is a catalog
   * `instructions_template`, which Codex expands before sending. Absent for every
   * layer read out of the probed output, whose text is rendered by definition.
   */
  representation?: "expanded" | "template";
  /**
   * For `empty-source`: the file that exists but has nothing in it. For
   * `base-instructions`: the configured file the base prompt was read from, or
   * the one that could not be read.
   */
  sourcePath?: string;
}

/**
 * Why the base prompt is or is not readable, at the granularity a reader can act
 * on. `LayerText.reason` has six coarse values and cannot express any of this,
 * which is why the detailed answer travels on its own record.
 */
export type BasePromptReason =
  | "ok"
  | "config-not-found"
  | "config-unreadable"
  | "config-too-large"
  | "model-not-selected"
  | "model-not-found"
  | "catalog-not-found"
  | "catalog-unreadable"
  | "catalog-too-large"
  | "not-published"
  | "override-empty"
  | "override-not-found"
  | "override-too-large"
  | "override-unreadable";

export interface BasePromptText {
  /** The base prompt, when a configured source published one. */
  text: string | null;
  reason: BasePromptReason;
  bytes: number;
  /** The model selected in `config.toml`, when the config named one. */
  model: string | null;
  /** The file the answer came from, when a file was reached at all. */
  sourcePath: string | null;
  /**
   * `expanded` is the text Codex sends. `template` is a catalog
   * `instructions_template`: a template even when it currently carries no
   * placeholder, so it is never presented as the text the model receives.
   */
  representation: "expanded" | "template" | "unavailable";
}

/**
 * Why a probe failed, as a stable token the caller can branch on. The prose
 * `detail` string is kept for display, but matching on it was never a contract:
 * a caller that needs "is Codex installed at all" versus "Codex rejected the
 * command" cannot get that from a sentence.
 */
export type PromptProbeFailureKind =
  | "program-not-found"
  | "command-unsupported"
  | "execution-failed"
  | "output-invalid";

export interface PromptProbeFailure {
  kind: PromptProbeFailureKind;
  /** The command line that was attempted or resolved, for display. */
  command: string;
  /**
   * A short fixed phrase plus the command - never captured process output.
   * Codex stderr can carry the user's config path, model name, or environment
   * details, and this response is served over the management API, so raw
   * process output does not belong in it.
   */
  detail: string;
}

export interface PromptTextProbe {
  ok: boolean;
  /** The Codex home the probe reported on. */
  codexHome: string;
  layers: Record<string, LayerText>;
  /**
   * The base prompt, read from configuration rather than from the probed output.
   * Present on every outcome: it is computed before the subprocess, so it answers
   * even when Codex cannot be resolved, the probe fails, or the caller cancels.
   */
  base: BasePromptText;
  /** The runtime the probe resolved and tried, when resolution produced one. */
  runtime?: { command: string; source: CodexRuntimeSource };
  /** Stable failure classification; `detail` remains the display string. */
  failure?: PromptProbeFailure;
  detail?: string;
}

/** 8 MiB is far above any real prompt and far below anything that hurts the server. */
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;

/** stderr is captured only to classify the failure, never to echo back. */
const MAX_PROBE_STDERR_BYTES = 64 * 1024;

/** Read chunk for local prompt sources; the ceiling is MAX_PROBE_OUTPUT_BYTES. */
const PROMPT_SOURCE_CHUNK_BYTES = 64 * 1024;

function errorWithCode(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function errorCodeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * Read one configured prompt source, bounded, from a single descriptor.
 *
 * Three properties are load-bearing, and all three are about this running
 * synchronously on the Bun request thread:
 *
 * - `O_NONBLOCK` is set BEFORE anything else. `openSync(path, "r")` on a FIFO with
 *   no writer blocks forever, and nothing can recover it: the probe timeout and
 *   request cancellation both need the event loop this call is holding. Windows
 *   has no such flag, so the constant is absent there and contributes nothing.
 * - The regular-file check reads `fstatSync` on the OPENED descriptor. A path stat
 *   describes whatever the name pointed at a moment ago, not what got opened.
 * - The ceiling is enforced while reading, not from a preflight size. A
 *   stat-then-read pair is a window in which the file can change, and it would let
 *   an unbounded body through into a management-API response.
 */
function readBoundedPromptSource(path: string): string {
  // `O_NONBLOCK` is POSIX-only: Windows omits it from `fs.constants` even though the
  // type declares it, so it is read defensively and contributes nothing there.
  const nonBlocking = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  const descriptor = openSync(path, constants.O_RDONLY | nonBlocking);
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw errorWithCode(`prompt source is not a regular file: ${path}`, "EFTYPE");
    }
    const parts: Buffer[] = [];
    const view = Buffer.allocUnsafe(PROMPT_SOURCE_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = readSync(descriptor, view, 0, view.length, total);
      if (read === 0) break;
      total += read;
      // One byte past the ceiling is the whole answer: refuse before the content
      // is retained, so an oversized source costs no more than a bounded read.
      if (total > MAX_PROBE_OUTPUT_BYTES) {
        throw errorWithCode(`prompt source exceeds ${MAX_PROBE_OUTPUT_BYTES} bytes: ${path}`, "EFBIG");
      }
      parts.push(Buffer.from(view.subarray(0, read)));
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    try { closeSync(descriptor); } catch { /* the descriptor is already unusable */ }
  }
}

function unavailableBase(
  reason: BasePromptReason,
  model: string | null = null,
  sourcePath: string | null = null,
): BasePromptText {
  return { text: null, reason, bytes: 0, model, sourcePath, representation: "unavailable" };
}

function readableBase(
  text: string,
  representation: "expanded" | "template",
  model: string,
  sourcePath: string,
): BasePromptText {
  return { text, reason: "ok", bytes: Buffer.byteLength(text, "utf8"), model, sourcePath, representation };
}

function publishedString(entry: RawEntry, key: string): string | null {
  const value = entry[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The base prompt for the configured model, read from the same files Codex reads.
 *
 * Precedence follows Codex: `model_instructions_file` replaces the base prompt
 * outright, so an override that is set decides the answer whether or not it can be
 * read. Without one, the selected catalog row's `base_instructions` is the
 * published text, and `model_messages.instructions_template` is the fallback -
 * reported as a template, because that is what it is.
 *
 * Every failure is a reason, never an exception: this feeds a GET that must
 * degrade to "we could not read it" rather than to a 500.
 */
function readBasePrompt(codexHome: string): BasePromptText {
  const configPath = join(codexHome, "config.toml");
  let configText: string;
  try {
    configText = readBoundedPromptSource(configPath);
  } catch (error) {
    // ENOENT is "no config"; anything else is "the config we have could not be
    // read". `existsSync` cannot separate those: it races the read, and it reports
    // a permission failure as absence.
    const code = errorCodeOf(error);
    return unavailableBase(
      code === "ENOENT" ? "config-not-found" : code === "EFBIG" ? "config-too-large" : "config-unreadable",
    );
  }
  let root: Record<string, unknown>;
  try {
    const parsed = Bun.TOML.parse(configText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config.toml is not a table");
    root = parsed as Record<string, unknown>;
  } catch {
    // The WHOLE document has to parse before any key from it is trusted. Codex
    // rejects a malformed config outright, so a model scraped out of the readable
    // first lines would make this display a prompt that is never sent.
    return unavailableBase("config-unreadable", null, configPath);
  }
  const configuredModel = typeof root.model === "string" ? root.model.trim() : "";
  // A `model_instructions_file` with no model is out of scope here: the base
  // prompt this reports on is the selected model's, and there is no selection.
  if (!configuredModel) return unavailableBase("model-not-selected", null, configPath);
  const model = configuredModel;

  const override = typeof root.model_instructions_file === "string" ? root.model_instructions_file : null;
  if (override !== null) {
    // A blank value names no file. The key is still set, so Codex does not fall
    // back to the catalog default and neither does this: reporting the catalog row
    // would describe a base prompt this configuration never produces.
    if (override.trim().length === 0) return unavailableBase("override-not-found", model);
    // Relative to the config file's own directory, which is how the rest of this
    // repository resolves the key.
    const overridePath = resolve(dirname(configPath), expandUserPath(override));
    let text: string;
    try {
      text = readBoundedPromptSource(overridePath);
    } catch (error) {
      const code = errorCodeOf(error);
      return unavailableBase(
        code === "ENOENT" ? "override-not-found" : code === "EFBIG" ? "override-too-large" : "override-unreadable",
        model,
        overridePath,
      );
    }
    // Codex rejects this config with "model instructions file is empty", so
    // reporting `ok` here would claim text that is never sent - and claim it for a
    // configuration that does not start.
    if (text.trim().length === 0) return unavailableBase("override-empty", model, overridePath);
    return readableBase(text, "expanded", model, overridePath);
  }

  const catalogPath = readCodexCatalogPathForHome(codexHome, configText);
  let catalog: RawCatalog | null;
  try {
    catalog = parseCatalogJson(readBoundedPromptSource(catalogPath));
  } catch (error) {
    const code = errorCodeOf(error);
    return unavailableBase(
      code === "ENOENT" ? "catalog-not-found" : code === "EFBIG" ? "catalog-too-large" : "catalog-unreadable",
      model,
      catalogPath,
    );
  }
  if (!catalog) return unavailableBase("catalog-unreadable", model, catalogPath);
  // Each candidate is guarded rather than trusted: `parseCatalogJson` validates
  // only that `models` is an array, so a row of `null` would throw on property
  // access and turn this read into a 500 on the management API.
  const entry = catalog.models?.find(candidate => (
    candidate !== null
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && (candidate.slug === model || candidate.id === model)
  )) ?? null;
  if (!entry) return unavailableBase("model-not-found", model, catalogPath);
  const published = publishedString(entry, "base_instructions");
  if (published) return readableBase(published, "expanded", model, catalogPath);
  const messages = entry.model_messages;
  const template = messages !== null && typeof messages === "object" && !Array.isArray(messages)
    ? publishedString(messages as RawEntry, "instructions_template")
    : null;
  if (template) return readableBase(template, "template", model, catalogPath);
  return unavailableBase("not-published", model, catalogPath);
}

/**
 * Project the base prompt onto the legacy `base-instructions` layer slot.
 *
 * The slot is lossy by construction - six coarse reasons, no renderer that reads
 * `representation` - so it carries only what it can carry honestly: published text
 * when the source is text Codex sends, and otherwise no text at all. A template is
 * deliberately NOT `ok` here, because the dialog labels every `ok` layer "Text
 * sent to the model" and an unexpanded template is not that. The detailed answer
 * stays on `base`.
 */
function promptLayerForBase(base: BasePromptText): LayerText {
  const source = base.sourcePath ? { sourcePath: base.sourcePath } : {};
  if (base.reason === "ok" && base.text !== null && base.representation === "expanded") {
    return { text: base.text, reason: "ok", bytes: base.bytes, representation: "expanded", ...source };
  }
  if (base.reason === "ok") return { text: null, reason: "not-exposed", bytes: 0, representation: "template", ...source };
  return { text: null, reason: "unavailable", bytes: 0, ...source };
}

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
  result: Promise<PromptProbeExecutionResult | null>;
  closed: Promise<void>;
  waiters: number;
  joinable: boolean;
  resultSettled: boolean;
  settled: boolean;
}

interface PromptProbeExecution {
  result: Promise<PromptProbeExecutionResult | null>;
  closed: Promise<void>;
}

/**
 * The process outcome travels with its classification so a shared flight hands
 * every joined caller the same `failure`, not just the same null.
 */
interface PromptProbeExecutionResult {
  raw: string | null;
  failure: PromptProbeFailure | null;
}

type SharedPromptProbeOutcome =
  | { kind: "output"; raw: string }
  | { kind: "failed"; failure?: PromptProbeFailure }
  | { kind: "busy" };

let activePromptProbe: PromptProbeFlight | null = null;
let probeCommandForTests: { binary: string; args: string[] } | null = null;
let probeRuntimeForTests: { command: string; source: CodexRuntimeSource } | null | undefined;
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

function completedExecution(value: PromptProbeExecutionResult | null): PromptProbeExecution {
  return { result: Promise.resolve(value), closed: Promise.resolve() };
}

/**
 * The command line as it may be shown to a caller.
 *
 * Redacted, because this response is served over the management API and a
 * resolved Codex path is a user path: the Windows Codex App lives under the
 * profile directory, so echoing the raw command would put the account name in
 * a diagnostic. `displayCodexRuntimePath` is the same helper the runtime log
 * line and doctor output already use, so the probe reports a path in the form
 * the rest of the product reports it.
 */
function commandDescription(command: ProbeCommand): string {
  return [displayCodexRuntimePath(command.binary), ...command.args].join(" ");
}

function probeFailure(
  command: ProbeCommand,
  kind: PromptProbeFailureKind,
  detail: string,
): PromptProbeFailure {
  return { kind, command: commandDescription(command), detail };
}

/**
 * A non-zero exit whose stderr reports an unknown subcommand means the resolved
 * binary is a Codex too old (or too new) for `debug prompt-input` - a different
 * remedy than "the process died". The stderr text itself is used only for this
 * check; it never enters the response.
 */
function classifyProcessFailure(command: ProbeCommand, code: number | null, stderr: string): PromptProbeFailure {
  const lower = stderr.toLowerCase();
  const unsupported =
    (/unrecognized|unknown|unexpected|invalid/.test(lower) && /subcommand|command|argument|option/.test(lower))
    || /usage:/.test(lower);
  const kind: PromptProbeFailureKind = unsupported ? "command-unsupported" : "execution-failed";
  const phrase = unsupported
    ? "codex does not support this probe command"
    : `codex probe exited with code ${code ?? "unknown"}`;
  return probeFailure(command, kind, `${phrase}: ${commandDescription(command)}`);
}

/**
 * The resolver reports why each candidate lost. A candidate that is simply not
 * there (issue 4458's repeated "path does not exist" on Windows) is a
 * program-not-found; a candidate that exists but could not be probed is an
 * execution problem on an installed program.
 */
function classifyRuntimeFailure(result: ResolveCodexRuntimeResult): PromptProbeFailure {
  const isNotFound = (reason: string) =>
    reason === CODEX_PROGRAM_NOT_FOUND_REASON || /does not exist|not found|ENOENT/i.test(reason);
  const representative = result.failures.find(item => !isNotFound(item.reason))
    ?? result.failures[0];
  const kind: PromptProbeFailureKind = !representative || isNotFound(representative.reason)
    ? "program-not-found"
    : "execution-failed";
  // Same redaction obligation as commandDescription: a rejected candidate is a
  // real filesystem path, and every one of them is reported to the caller.
  const command = displayCodexRuntimePath(representative?.command ?? result.runtime.command);
  const phrase = kind === "program-not-found" ? "codex program not found" : "codex runtime could not be probed";
  return { kind, command, detail: `${phrase}: ${command}` };
}

function runProbe(
  command: ProbeCommand,
  signal: AbortSignal,
  onStopping: () => void,
): PromptProbeExecution {
  if (signal.aborted) return completedExecution({ raw: null, failure: null });
  let resolveResult!: (value: PromptProbeExecutionResult | null) => void;
  let resolveClosed!: () => void;
  const result = new Promise<PromptProbeExecutionResult | null>(resolve => { resolveResult = resolve; });
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let resultSettled = false;
  let closeSettled = false;

  const finishResult = (value: PromptProbeExecutionResult | null) => {
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
      // Route through the shared invocation helper: on Windows a resolved
      // `codex.cmd` cannot be spawned directly and must go through cmd.exe,
      // which `commandInvocation` does with correct metacharacter escaping.
      const invocation = codexExecInvocation(command.binary, command.args, process.platform);
      child = spawn(invocation.file, invocation.args, {
        cwd: command.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...invocation.options,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishResult({
        raw: null,
        failure: probeFailure(
          command,
          /ENOENT|not found/i.test(message) ? "program-not-found" : "execution-failed",
          `codex probe could not start: ${commandDescription(command)}`,
        ),
      });
      finishClosed();
      return { result, closed };
    }
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let size = 0;
    let errorSize = 0;
    let settled = false;
    let stopping = false;
    let stoppingFailure: PromptProbeFailure | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value: PromptProbeExecutionResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      finishResult(value);
      finishClosed();
    };

    // Keep the flight admitted until `close`: kill() only requests termination
    // and does not prove the exact child has released its process and stdio.
    const terminate = (
      failure = probeFailure(
        command,
        "execution-failed",
        `codex probe was terminated: ${commandDescription(command)}`,
      ),
    ) => {
      if (settled || stopping) return;
      stopping = true;
      stoppingFailure = failure;
      onStopping();
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      // The caller is bounded even if OS termination later fails. Admission is
      // retained separately by `closed`, and later probes fail soft while this
      // exact child remains unproven terminal.
      finishResult({ raw: null, failure });
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
    child.stderr?.on("data", (chunk: Buffer) => {
      errorSize += chunk.length;
      if (errorSize <= MAX_PROBE_STDERR_BYTES) errorChunks.push(chunk);
    });
    child.on("error", error => {
      // No PID means spawn itself failed, so there is no live child to drain.
      if (child.pid === undefined) {
        const message = error instanceof Error ? error.message : String(error);
        finish({
          raw: null,
          failure: probeFailure(
            command,
            /ENOENT|not found/i.test(message) ? "program-not-found" : "execution-failed",
            `codex probe could not start: ${commandDescription(command)}`,
          ),
        });
      }
      else terminate(probeFailure(
        command,
        "execution-failed",
        `codex probe process error: ${commandDescription(command)}`,
      ));
    });
    child.on("close", code => {
      // Decode once, at the end: `String(chunk)` per chunk corrupts any UTF-8
      // character that straddles a chunk boundary.
      const recordClose = () => {
        if (stopping) {
          finish({
            raw: null,
            failure: stoppingFailure ?? probeFailure(
              command,
              "execution-failed",
              `codex probe was terminated: ${commandDescription(command)}`,
            ),
          });
        } else if (code === 0) {
          finish({ raw: Buffer.concat(chunks).toString("utf8"), failure: null });
        } else {
          finish({
            raw: null,
            failure: classifyProcessFailure(command, code, Buffer.concat(errorChunks).toString("utf8")),
          });
        }
      };
      const barrier = probeCloseBarrierForTests;
      if (barrier) void barrier.then(recordClose, recordClose);
      else recordClose();
    });
    // Close the race between the pre-spawn check and listener registration.
    if (signal.aborted) terminate();
  } catch {
    finishResult({
      raw: null,
      failure: probeFailure(
        command,
        "execution-failed",
        `codex probe failed: ${commandDescription(command)}`,
      ),
    });
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
    const result = await waitForPromptProbeFlight(startPromptProbeFlight(command), signal);
    if (!result) return { kind: "failed" };
    if (result.failure) return { kind: "failed", failure: result.failure };
    return result.raw === null ? { kind: "failed" } : { kind: "output", raw: result.raw };
  }
  if (active.key === key && active.joinable && !active.controller.signal.aborted) {
    const result = await waitForPromptProbeFlight(active, signal);
    if (!result) return { kind: "failed" };
    if (result.failure) return { kind: "failed", failure: result.failure };
    return result.raw === null ? { kind: "failed" } : { kind: "output", raw: result.raw };
  }
  // A different or terminating flight still owns the sole process slot. Never
  // wait unboundedly for an unproven close and never launch beside it.
  return { kind: "busy" };
}

async function waitForPromptProbeFlight(
  flight: PromptProbeFlight,
  signal?: AbortSignal,
): Promise<PromptProbeExecutionResult | null> {
  if (signal?.aborted) {
    if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
    return null;
  }
  flight.waiters += 1;
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await flight.result;
    const aborted = new Promise<PromptProbeExecutionResult | null>(resolve => {
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
  // Read before anything is spawned. The base prompt comes from files this process
  // reads itself, so binding it to the subprocess would lose the one layer the
  // probed output never carries the moment Codex is missing, slow, or cancelled.
  const base = readBasePrompt(codexHome);
  const baseLayers = { "base-instructions": promptLayerForBase(base) };
  if (signal?.aborted) {
    return { ok: false, codexHome, layers: { ...baseLayers }, base, detail: "prompt probe cancelled" };
  }
  // Resolve through the shared runtime resolver, not a private path list: the
  // old four-path POSIX check could never match the Codex App's Windows install
  // under %LOCALAPPDATA%\OpenAI\Codex\bin\<version>, so the probe reported
  // "not found" on machines where Codex was plainly installed (issue 4458).
  //
  // Both flags are deliberate. This runs on a request path: discoverAlternatives
  // would walk the whole PATH just to fill a newerAvailable diagnostic the probe
  // never shows, and probeVersion would pay a blocking `--version` exec per
  // candidate. The probe needs a command it can spawn; the version is irrelevant.
  const resolved = probeCommandForTests || probeRuntimeForTests !== undefined
    ? null
    : resolveCodexRuntime({ discoverAlternatives: false, probeVersion: false });
  const runtime: { command: string; source: CodexRuntimeSource } | undefined =
    probeRuntimeForTests !== undefined
      ? probeRuntimeForTests ?? undefined
      : resolved && resolved.runtime.source !== "fallback"
        ? { command: resolved.runtime.command, source: resolved.runtime.source }
        : undefined;
  // A `fallback` result is the resolver saying "nothing concrete was found" -
  // its command is the bare word "codex", not a located binary. Reporting it as
  // resolved would just relabel the same not-found as a spawn failure.
  const binary = probeCommandForTests?.binary ?? runtime?.command ?? null;
  // The response travels over the management API, so the reported runtime is
  // redacted while `binary` keeps the real path the spawn needs. On Windows the
  // Codex App install sits under the user's profile directory, so the raw
  // command carries the account name.
  const reportedRuntime = runtime
    ? { command: displayCodexRuntimePath(runtime.command), source: runtime.source }
    : undefined;
  if (!binary) {
    const failure = resolved
      ? classifyRuntimeFailure(resolved)
      : probeFailure(
          { binary: "codex", args: ["debug", "prompt-input"], cwd: codexHome, timeoutMs, promptStateFingerprint },
          "program-not-found",
          "codex program not found: codex debug prompt-input",
        );
    return {
      ok: false,
      codexHome,
      layers: { ...baseLayers },
      base,
      ...(reportedRuntime ? { runtime: reportedRuntime } : {}),
      failure,
      detail: "codex binary not found",
    };
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
      layers: { ...baseLayers },
      base,
      ...(reportedRuntime ? { runtime: reportedRuntime } : {}),
      ...(outcome.kind === "failed" && outcome.failure ? { failure: outcome.failure } : {}),
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
    return {
      ok: false,
      codexHome,
      layers: { ...baseLayers },
      base,
      ...(reportedRuntime ? { runtime: reportedRuntime } : {}),
      failure: probeFailure(
        command,
        "output-invalid",
        `codex prompt output could not be parsed: ${commandDescription(command)}`,
      ),
      detail: "prompt output could not be parsed",
    };
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
  // Read from configuration above, not from this output: Codex discards
  // `base_instructions` before rendering `prompt.input`.
  Object.assign(layers, baseLayers);

  // Layers whose rendered tag we have not confirmed against live output. Leaving
  // them absent made the GUI fall through to "unavailable", which claims the probe
  // failed when it succeeded. Keep this distinct from the base prompt's
  // "not-exposed", which is confirmed to travel outside the printable message
  // list - reusing it showed a base-prompt-specific explanation for unrelated
  // layers.
  for (const id of UNMAPPED_LAYER_IDS) {
    layers[id] ??= { text: null, reason: "unmapped", bytes: 0 };
  }
  return { ok: true, codexHome, layers, base, ...(reportedRuntime ? { runtime: reportedRuntime } : {}) };
}

/** Test-only command seam; production always resolves the installed Codex binary. */
export function setPromptTextProbeCommandForTests(command: { binary: string; args: string[] } | null): void {
  probeCommandForTests = command ? { binary: command.binary, args: [...command.args] } : null;
}

/** Test-only runtime seam: stands in for the shared resolver's answer. */
export function setPromptTextProbeRuntimeForTests(
  runtime: { command: string; source: CodexRuntimeSource } | null | undefined,
): void {
  probeRuntimeForTests = runtime;
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
  probeRuntimeForTests = undefined;
  probeSpawnAttemptsForTests = 0;
  probeCloseBarrierForTests = null;
}
