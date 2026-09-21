/**
 * The prompt-text probe: what it reads, and what it refuses to guess.
 *
 * These are unit tests over the pure extraction and classification logic. The
 * spawn itself is exercised by the route test and by hand; what matters here is
 * that a missing body is attributed to the right cause, because the dialog shows
 * that attribution to a user as an explanation.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSectionsForTests,
  probePromptText,
  promptTextProbeSpawnAttemptsForTests,
  resetPromptTextProbeForTests,
  setPromptTextProbeCloseBarrierForTests,
  setPromptTextProbeCommandForTests,
  setPromptTextProbeRuntimeForTests,
  type PromptTextProbe,
} from "../../src/codex/prompt-text-probe";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { displayCodexRuntimePath } from "../../src/codex/runtime";
import { INTERNAL_DEADLINE_MS } from "../helpers/test-budget";

const lifecycleRoots: string[] = [];
const VALID_PROBE_OUTPUT = JSON.stringify([{
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text: "<skills_instructions>Skill text.</skills_instructions>" }],
}]);

/** Mirrors MAX_PROBE_OUTPUT_BYTES, which the probe keeps private. */
const MAX_PROMPT_SOURCE_BYTES = 8 * 1024 * 1024;

function message(text: string): string {
  return JSON.stringify([{ type: "message", role: "developer", content: [{ type: "input_text", text }] }]);
}

async function waitUntil(predicate: () => boolean, detail: string): Promise<void> {
  // Gates on a spawned child writing its pid marker or exiting: 8-19 s on windows-latest.
  const deadline = Date.now() + INTERNAL_DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`);
    await Bun.sleep(10);
  }
}

function requireProcessId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid published process id");
  return value;
}

function readPublishedPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf8").trim();
  if (!/^\d+$/.test(value)) throw new Error("invalid published process id");
  return requireProcessId(Number(value));
}

async function waitForPublishedPid(path: string, detail: string): Promise<number> {
  let pid: number | undefined;
  await waitUntil(() => (pid = readPublishedPid(path)) !== undefined, detail);
  return pid!;
}

function publishPidSource(path: string): string {
  return `const fs = require("node:fs"); const marker = ${JSON.stringify(path)}; const temporary = marker + "." + process.pid + ".tmp"; fs.writeFileSync(temporary, String(process.pid)); fs.renameSync(temporary, marker);`;
}

function isProcessAlive(pid: number): boolean {
  requireProcessId(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "ocx-prompt-probe-"));
  lifecycleRoots.push(path);
  return path;
}

/** A throwaway Codex home holding exactly the files a base-prompt case needs. */
function promptHome(files: Record<string, string>): string {
  const home = root();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(home, name), content, "utf8");
  return home;
}

function catalogJson(models: unknown[]): string {
  return JSON.stringify({ models });
}

/** Sparse, because the ceiling is about what the reader accepts, not about writing 8 MiB. */
function oversizedFile(home: string, name: string): string {
  const path = join(home, name);
  writeFileSync(path, "", "utf8");
  truncateSync(path, MAX_PROMPT_SOURCE_BYTES + 1);
  return path;
}

/**
 * Probe a specific home with no Codex runtime at all.
 *
 * The null runtime seam is the point, not a shortcut: the base prompt is read
 * before a runtime is resolved, so every case below also proves it survives a
 * machine where Codex cannot be found - and none of them spawn a child.
 */
async function probeWithHome(home: string, signal?: AbortSignal): Promise<PromptTextProbe> {
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  setPromptTextProbeRuntimeForTests(null);
  try {
    return await probePromptText(2_000, signal);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
}

afterEach(async () => {
  await resetPromptTextProbeForTests();
  while (lifecycleRoots.length) removeTreeWithRetry(lifecycleRoots.pop()!);
});

test("PID markers are invisible until complete atomic publication", () => {
  const marker = join(root(), "pid.txt");
  const temporary = marker + ".tmp";
  writeFileSync(temporary, "12");
  expect(readPublishedPid(marker)).toBeUndefined();
  writeFileSync(temporary, String(process.pid));
  renameSync(temporary, marker);
  expect(readPublishedPid(marker)).toBe(process.pid);
});

test("malformed published PIDs never reach the process liveness check", () => {
  const marker = join(root(), "pid.txt");
  const kill = spyOn(process, "kill");
  try {
    for (const value of ["", "0", "-1", "1.5", "9007199254740992", "12junk"]) {
      writeFileSync(marker, value);
      expect(() => readPublishedPid(marker)).toThrow("invalid published process id");
    }
    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => isProcessAlive(pid)).toThrow("invalid published process id");
    }
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});

describe("section extraction", () => {
  test("a tag name containing a space is still matched", () => {
    // Codex renders `<permissions instructions>`, with a space. A [a-z_]+ pattern
    // skipped it silently and the layer was reported as having sent nothing.
    const sections = extractSectionsForTests(message("<permissions instructions>Sandbox rules.</permissions instructions>"));
    expect(sections.get("permissions instructions")).toBe("Sandbox rules.");
  });

  test("AGENTS.md is found even though it carries no tag of its own", () => {
    // Codex wraps the body in <INSTRUCTIONS>; the fixture matches live output.
    const raw = message("<skills_instructions>S</skills_instructions># AGENTS.md instructions for /home/u/.codex\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>");
    const sections = extractSectionsForTests(raw);
    expect(sections.get("skills_instructions")).toBe("S");
    expect(sections.get("__agents_md")).toContain("Be brief.");
  });

  test("malformed JSON yields no sections rather than inventing them", () => {
    // The caller turns an empty map into a failed read. Returning a populated
    // map here would have told the user fifteen layers each chose to send nothing.
    expect(extractSectionsForTests("{not json").size).toBe(0);
    expect(extractSectionsForTests("[]").size).toBe(0);
  });

  test("a section spanning multiple lines keeps its body", () => {
    const sections = extractSectionsForTests(message("<apps_instructions>line one\nline two</apps_instructions>"));
    expect(sections.get("apps_instructions")).toBe("line one\nline two");
  });

  test("AGENTS.md is bounded by its own INSTRUCTIONS wrapper", () => {
    // Capturing to end-of-message swept up whatever untagged prose followed. The
    // body is delimited, so the delimiter is the boundary.
    const raw = message(
      "</recommended_plugins># AGENTS.md instructions for /home/u/.codex\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS><environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>",
    );
    const sections = extractSectionsForTests(raw);
    expect(sections.get("__agents_md")).toBe("Be brief.");
    // The section that follows is its own entry, not swallowed into the doc.
    expect(sections.get("environment_context")).toContain("<cwd>/tmp</cwd>");
  });

  test("XML-like prose a user wrote inside AGENTS.md survives", () => {
    // Stripping tag-shaped blocks before extraction deleted the user's own text.
    const raw = message(
      "# AGENTS.md instructions for /home/u/.codex\n\n<INSTRUCTIONS>\nUse <angle> brackets freely.\n</INSTRUCTIONS>",
    );
    expect(extractSectionsForTests(raw).get("__agents_md")).toBe("Use <angle> brackets freely.");
  });

  test("a tag-shaped fragment inside prose does not become its own section", () => {
    const raw = message("# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>\nPrefer <div> over <span>.\n</INSTRUCTIONS>");
    const sections = extractSectionsForTests(raw);
    expect(sections.has("div")).toBe(false);
    expect(sections.get("__agents_md")).toContain("<div>");
  });
});

/**
 * The base prompt never appears in `codex debug prompt-input`: Codex discards
 * `base_instructions` before rendering it. These cases pin where the answer does
 * come from, and - just as important - every case in which the honest answer is
 * "not this text", because a wrong base prompt shown as sent text is worse than
 * none.
 */
describe("base prompt", () => {
  test("reads the selected model's published base instructions from the catalog", async () => {
    const home = promptHome({
      "config.toml": "model = \"gpt-test\"\n",
      "opencodex-catalog.json": catalogJson([{ slug: "gpt-test", base_instructions: "Base prompt body." }]),
    });

    const result = await probeWithHome(home);

    expect(result.base).toEqual({
      text: "Base prompt body.",
      reason: "ok",
      bytes: Buffer.byteLength("Base prompt body.", "utf8"),
      model: "gpt-test",
      sourcePath: join(home, "opencodex-catalog.json"),
      representation: "expanded",
    });
    expect(result.layers["base-instructions"]).toMatchObject({
      text: "Base prompt body.",
      reason: "ok",
      representation: "expanded",
    });
    // Read before the runtime is resolved: an unusable Codex costs the probe its
    // rendered layers, never this one.
    expect(result.ok).toBe(false);
  });

  test("a configured catalog path is read instead of the default one", async () => {
    const home = promptHome({
      "config.toml": "model = \"gpt-test\"\nmodel_catalog_json = \"custom-catalog.json\"\n",
      "custom-catalog.json": catalogJson([{ id: "gpt-test", base_instructions: "From the configured catalog." }]),
      "opencodex-catalog.json": catalogJson([{ slug: "gpt-test", base_instructions: "From the default catalog." }]),
    });

    const result = await probeWithHome(home);

    expect(result.base.text).toBe("From the configured catalog.");
    expect(result.base.sourcePath).toBe(join(home, "custom-catalog.json"));
  });

  test("a model_instructions_file override replaces the catalog row", async () => {
    const home = promptHome({
      "config.toml": "model = \"gpt-test\"\nmodel_instructions_file = \"replacement.md\"\n",
      "replacement.md": "Replaced base prompt.",
      "opencodex-catalog.json": catalogJson([{ slug: "gpt-test", base_instructions: "Catalog body." }]),
    });

    const result = await probeWithHome(home);

    // Relative to the config file's own directory, and it is the text Codex sends.
    expect(result.base).toMatchObject({
      text: "Replaced base prompt.",
      reason: "ok",
      sourcePath: join(home, "replacement.md"),
      representation: "expanded",
    });
    expect(result.layers["base-instructions"]).toMatchObject({ text: "Replaced base prompt.", reason: "ok" });
  });

  test("an unexpanded template is reported as a template and never as sent text", async () => {
    const home = promptHome({
      "config.toml": "model = \"gpt-template\"\n",
      "opencodex-catalog.json": catalogJson([
        { slug: "gpt-template", model_messages: { instructions_template: "Template for {model}." } },
      ]),
    });

    const result = await probeWithHome(home);

    expect(result.base).toMatchObject({ text: "Template for {model}.", reason: "ok", representation: "template" });
    // The legacy slot carries no renderer for `representation`, and the dialog
    // labels every `ok` layer "Text sent to the model". An unexpanded template is
    // not that, so it must not arrive there as `ok`.
    expect(result.layers["base-instructions"]).toMatchObject({
      text: null,
      reason: "not-exposed",
      bytes: 0,
      representation: "template",
    });
  });

  test("a published base_instructions wins over a template on the same row", async () => {
    const home = promptHome({
      "config.toml": "model = \"gpt-test\"\n",
      "opencodex-catalog.json": catalogJson([{
        slug: "gpt-test",
        base_instructions: "Published text.",
        model_messages: { instructions_template: "Template text." },
      }]),
    });

    const result = await probeWithHome(home);

    expect(result.base).toMatchObject({ text: "Published text.", representation: "expanded" });
  });

  test("a malformed row later in the catalog stays unavailable instead of throwing", async () => {
    // `parseCatalogJson` validates only that `models` is an array, so an
    // unguarded `candidate.slug` on a null row turns this read into a 500.
    const home = promptHome({
      "config.toml": "model = \"gpt-test\"\n",
      "opencodex-catalog.json": catalogJson([null, "gpt-test", ["gpt-test"], { slug: "other" }]),
    });

    const result = await probeWithHome(home);

    expect(result.base).toMatchObject({ text: null, reason: "model-not-found", representation: "unavailable" });
  });

  test("a config that parses only as far as the model key is not trusted", async () => {
    // Codex rejects a malformed config outright. Scraping the readable first lines
    // would display a base prompt this configuration never sends.
    const home = promptHome({
      "config.toml": "model = \"gpt-test\"\nbroken = [\n",
      "opencodex-catalog.json": catalogJson([{ slug: "gpt-test", base_instructions: "Never sent." }]),
    });

    const result = await probeWithHome(home);

    expect(result.base).toMatchObject({ text: null, reason: "config-unreadable", model: null });
  });

  test("a blank model_instructions_file does not fall back to the catalog", async () => {
    const home = promptHome({
      "config.toml": "model = \"gpt-test\"\nmodel_instructions_file = \"   \"\n",
      "opencodex-catalog.json": catalogJson([{ slug: "gpt-test", base_instructions: "Catalog body." }]),
    });

    const result = await probeWithHome(home);

    expect(result.base).toMatchObject({ text: null, reason: "override-not-found", model: "gpt-test" });
  });

  test("an override that exists but is blank is not effective prompt text", async () => {
    // Codex rejects this config with "model instructions file is empty", so `ok`
    // here would claim text for a configuration that does not start.
    const home = promptHome({
      "config.toml": "model = \"gpt-test\"\nmodel_instructions_file = \"blank.md\"\n",
      "blank.md": " \n\t",
    });

    const result = await probeWithHome(home);

    expect(result.base).toMatchObject({
      text: null,
      reason: "override-empty",
      sourcePath: join(home, "blank.md"),
      representation: "unavailable",
    });
  });

  const unavailableCases: Array<[string, Record<string, string>]> = [
    ["config-not-found", {}],
    ["model-not-selected", { "config.toml": "model_catalog_json = \"catalog.json\"\n" }],
    ["catalog-not-found", { "config.toml": "model = \"gpt-test\"\n" }],
    ["catalog-unreadable", {
      "config.toml": "model = \"gpt-test\"\n",
      "opencodex-catalog.json": "{ not json",
    }],
    ["model-not-found", {
      "config.toml": "model = \"gpt-test\"\n",
      "opencodex-catalog.json": catalogJson([{ slug: "other-model", base_instructions: "Someone else's." }]),
    }],
    ["not-published", {
      "config.toml": "model = \"gpt-test\"\n",
      "opencodex-catalog.json": catalogJson([{ slug: "gpt-test" }]),
    }],
    ["override-not-found", {
      "config.toml": "model = \"gpt-test\"\nmodel_instructions_file = \"missing.md\"\n",
    }],
  ];

  test.each(unavailableCases)("reports %s with no text and an unavailable layer", async (reason, files) => {
    const result = await probeWithHome(promptHome(files));

    expect(result.base).toMatchObject({ text: null, reason, bytes: 0, representation: "unavailable" });
    // The legacy slot has five coarse reasons, so every base failure collapses to
    // one of them while the distinguishable answer rides on `base`.
    expect(result.layers["base-instructions"]).toMatchObject({ text: null, reason: "unavailable", bytes: 0 });
  });

  const oversizedCases: Array<[string, string, string]> = [
    ["config.toml", "config-too-large", "model = \"gpt-test\"\n"],
    ["catalog.json", "catalog-too-large", "model = \"gpt-test\"\nmodel_catalog_json = \"catalog.json\"\n"],
    ["override.md", "override-too-large", "model = \"gpt-test\"\nmodel_instructions_file = \"override.md\"\n"],
  ];

  test.each(oversizedCases)("refuses an oversized %s before loading its content", async (fileName, reason, config) => {
    const home = promptHome({ "config.toml": config });
    const path = oversizedFile(home, fileName);

    const result = await probeWithHome(home);

    expect(result.base).toMatchObject({ text: null, reason, bytes: 0 });
    // The config case overwrites the file that names the others, so only the two
    // configured sources have a path to report.
    if (reason !== "config-too-large") expect(result.base.sourcePath).toBe(path);
  });

  test("a non-regular file is refused from the descriptor that was opened", async () => {
    const home = root();
    mkdirSync(join(home, "config.toml"));

    const result = await probeWithHome(home);

    expect(result.base).toMatchObject({ text: null, reason: "config-unreadable", model: null });
  });

  test.skipIf(process.platform === "win32")("a FIFO source is refused instead of blocking the request thread", async () => {
    // `openSync(path, "r")` on a FIFO with no writer never returns, and it holds the
    // loop that the probe timeout and request cancellation both need: the whole
    // proxy stops. O_NONBLOCK is what makes this case answerable at all.
    const home = root();
    const fifo = join(home, "prompt.fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    writeFileSync(
      join(home, "config.toml"),
      "model = \"gpt-test\"\nmodel_instructions_file = \"prompt.fifo\"\n",
      "utf8",
    );

    const result = await probeWithHome(home);

    expect(result.base).toMatchObject({ text: null, reason: "override-unreadable", sourcePath: fifo });
  });

  test("a cancelled probe still answers with the base prompt", async () => {
    const home = promptHome({
      "config.toml": "model = \"gpt-test\"\n",
      "opencodex-catalog.json": catalogJson([{ slug: "gpt-test", base_instructions: "Base prompt body." }]),
    });
    const controller = new AbortController();
    controller.abort();

    const result = await probeWithHome(home, controller.signal);

    expect(result.detail).toBe("prompt probe cancelled");
    expect(result.base).toMatchObject({ text: "Base prompt body.", reason: "ok" });
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(0);
  });
});

describe("prompt probe process lifecycle", () => {
  test("a pre-aborted caller starts no child", async () => {
    const marker = join(root(), "started.txt");
    setPromptTextProbeCommandForTests({
      binary: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
    });
    const controller = new AbortController();
    controller.abort();

    const result = await probePromptText(2_000, controller.signal);

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("prompt probe cancelled");
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("concurrent callers share one child and one caller may cancel", async () => {
    const started = join(root(), "started.txt");
    const source = [
      `require("node:fs").appendFileSync(${JSON.stringify(started)}, "1\\n");`,
      `setTimeout(() => process.stdout.write(${JSON.stringify(VALID_PROBE_OUTPUT)}), 150);`,
    ].join("");
    setPromptTextProbeCommandForTests({ binary: process.execPath, args: ["-e", source] });
    const controller = new AbortController();

    const first = probePromptText(2_000, controller.signal);
    const second = probePromptText(2_000);
    controller.abort();

    expect((await first).detail).toBe("prompt probe cancelled");
    expect((await second).ok).toBe(true);
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(1);
    expect(readFileSync(started, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });

  test("concurrent callers share one failure and a later caller retries", async () => {
    const started = join(root(), "failed-starts.txt");
    const source = [
      `require("node:fs").appendFileSync(${JSON.stringify(started)}, "1\\n");`,
      "setTimeout(() => process.exit(1), 150);",
    ].join("");
    setPromptTextProbeCommandForTests({ binary: process.execPath, args: ["-e", source] });

    const [first, second] = await Promise.all([
      probePromptText(2_000),
      probePromptText(2_000),
    ]);

    expect(first).toMatchObject({ ok: false, detail: "codex debug prompt-input failed" });
    expect(second).toMatchObject({ ok: false, detail: "codex debug prompt-input failed" });
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(1);
    expect(readFileSync(started, "utf8").trim().split(/\r?\n/)).toHaveLength(1);

    const later = await probePromptText(2_000);

    expect(later).toMatchObject({ ok: false, detail: "codex debug prompt-input failed" });
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(2);
    expect(readFileSync(started, "utf8").trim().split(/\r?\n/)).toHaveLength(2);
  });

  test("the last cancellation drains the exact child before another command starts", async () => {
    const dir = root();
    const pidPath = join(dir, "pid.txt");
    const overlapPath = join(dir, "overlap.txt");
    const hangingSource = [
      publishPidSource(pidPath),
      "setInterval(() => {}, 1_000);",
    ].join("");
    setPromptTextProbeCommandForTests({ binary: process.execPath, args: ["-e", hangingSource] });
    const controller = new AbortController();
    const hanging = probePromptText(5_000, controller.signal);
    const pid = await waitForPublishedPid(pidPath, "hanging child pid");
    expect(isProcessAlive(pid)).toBe(true);

    controller.abort();
    expect((await hanging).detail).toBe("prompt probe cancelled");

    const replacementSource = [
      `const fs = require("node:fs"); const rawPid = fs.readFileSync(${JSON.stringify(pidPath)}, "utf8").trim(); const pid = Number(rawPid);`,
      "if (!/^\\d+$/.test(rawPid) || !Number.isSafeInteger(pid) || pid <= 0) throw new Error(\"invalid published process id\");",
      "let priorProbeAlive = true;",
      "try { process.kill(pid, 0); } catch { priorProbeAlive = false; }",
      `if (priorProbeAlive) fs.writeFileSync(${JSON.stringify(overlapPath)}, "overlap");`,
      `process.stdout.write(${JSON.stringify(VALID_PROBE_OUTPUT)});`,
    ].join("");
    setPromptTextProbeCommandForTests({ binary: process.execPath, args: ["-e", replacementSource] });
    const blockedDuringDrain = await probePromptText(2_000);

    expect(blockedDuringDrain.ok).toBe(false);
    expect(blockedDuringDrain.detail).toBe("another prompt probe is still finishing; retry shortly");
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(1);
    await resetPromptTextProbeForTests();
    setPromptTextProbeCommandForTests({ binary: process.execPath, args: ["-e", replacementSource] });
    const replacement = await probePromptText(2_000);

    expect(replacement.ok).toBe(true);
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(1);
    expect(existsSync(overlapPath)).toBe(false);
    await waitUntil(() => !isProcessAlive(pid), "cancelled child exit");
  });

  async function exerciseCloseBoundary(injectFailure: boolean): Promise<void> {
    const pidPath = join(root(), "exited-parent-pid.txt");
    let releaseClose!: () => void;
    setPromptTextProbeCloseBarrierForTests(new Promise<void>(resolve => { releaseClose = resolve; }));
    let first: ReturnType<typeof probePromptText> | undefined;
    try {
      const delayedCloseSource = [
        publishPidSource(pidPath),
        `process.stdout.write(${JSON.stringify(VALID_PROBE_OUTPUT)});`,
      ].join("");
      setPromptTextProbeCommandForTests({ binary: process.execPath, args: ["-e", delayedCloseSource] });
      first = probePromptText(2_000);
      const pid = await waitForPublishedPid(pidPath, "exit-close parent pid");
      await waitUntil(() => !isProcessAlive(pid), "probe parent exit");
      if (injectFailure) throw new Error("fixture assertion failure before close release");

      setPromptTextProbeCommandForTests({
        binary: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(VALID_PROBE_OUTPUT)})`],
      });
      const blockedBeforeClose = await probePromptText(2_000);
      expect(blockedBeforeClose.ok).toBe(false);
      expect(blockedBeforeClose.detail).toBe("another prompt probe is still finishing; retry shortly");
      expect(promptTextProbeSpawnAttemptsForTests()).toBe(1);
      releaseClose();
      expect((await first).ok).toBe(true);
      const afterClose = await probePromptText(2_000);
      expect(afterClose.ok).toBe(true);
      expect(promptTextProbeSpawnAttemptsForTests()).toBe(2);
    } finally {
      releaseClose();
      try { if (first) await first; } finally { await resetPromptTextProbeForTests(); }
    }
  }

  test("admission stays occupied between child exit and close handling", async () => {
    await exerciseCloseBoundary(false);
  });

  test("a failure before close release leaves the probe reusable", async () => {
    await expect(exerciseCloseBoundary(true)).rejects.toThrow("fixture assertion failure before close release");
    setPromptTextProbeCommandForTests({
      binary: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(VALID_PROBE_OUTPUT)})`],
    });
    expect((await probePromptText(2_000)).ok).toBe(true);
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(1);
  });
});

describe("unmapped layers", () => {
  test("a layer with no confirmed tag reports unmapped, not the base prompt's not-exposed", async () => {
    // UNMAPPED_LAYER_IDS used to reuse "not-exposed", which is the base prompt's
    // contract: the GUI renders a base-prompt-specific explanation for it. A
    // layer the extractor simply has no verified tag for is a smaller claim.
    const home = promptHome({
      "config.toml": "model = \"gpt-test\"\n",
      "opencodex-catalog.json": catalogJson([{ slug: "gpt-test", base_instructions: "Base prompt body." }]),
    });
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    setPromptTextProbeCommandForTests({
      binary: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(VALID_PROBE_OUTPUT)})`],
    });
    try {
      const result = await probePromptText(2_000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.layers["personality"]).toMatchObject({ text: null, reason: "unmapped", bytes: 0 });
        expect(result.layers["tools"]).toMatchObject({ text: null, reason: "unmapped", bytes: 0 });
        // The base prompt keeps its own contract: readable text stays "ok" and an
        // unexpanded template stays "not-exposed" - never "unmapped".
        expect(result.layers["base-instructions"]).toMatchObject({ text: "Base prompt body.", reason: "ok" });
      }
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });
});

describe("runtime resolution and failure classification", () => {
  test("a runtime the shared resolver finds is spawned, not reported missing", async () => {
    // Issue 4458: the old four-path POSIX check reported "codex binary not
    // found" on a Windows machine where the Codex App had installed codex.exe
    // under %LOCALAPPDATA%. The resolver's answer must reach the spawn.
    const started = join(root(), "resolved-runtime.txt");
    setPromptTextProbeRuntimeForTests({ command: process.execPath, source: "installed" });
    setPromptTextProbeCommandForTests({
      binary: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(started)}, "1"); process.stdout.write(${JSON.stringify(VALID_PROBE_OUTPUT)})`],
    });

    const result = await probePromptText(2_000);

    expect(result.ok).toBe(true);
    expect(result.detail).not.toBe("codex binary not found");
    // The reported command is redacted the same way every other runtime path in
    // the product is, because this response is served over the management API.
    expect(result.runtime).toEqual({
      command: displayCodexRuntimePath(process.execPath),
      source: "installed",
    });
    expect(existsSync(started)).toBe(true);
  });

  test("a resolver that finds nothing yields failure.kind program-not-found", async () => {
    setPromptTextProbeRuntimeForTests(null);

    const result = await probePromptText(2_000);

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("codex binary not found");
    expect(result.failure?.kind).toBe("program-not-found");
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(0);
  });

  test("unparseable output from a zero-exit run yields output-invalid", async () => {
    setPromptTextProbeCommandForTests({
      binary: process.execPath,
      args: ["-e", "process.stdout.write(\"this is not probe json\")"],
    });

    const result = await probePromptText(2_000);

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("prompt output could not be parsed");
    expect(result.failure?.kind).toBe("output-invalid");
  });

  test("an unknown-subcommand exit yields command-unsupported without echoing stderr", async () => {
    // The sentinels are concatenated inside the child so they exist only on
    // stderr: failure.detail legitimately echoes the attempted command line, so
    // a marker written literally into argv would make these assertions vacuous.
    const marker = "stderr-marker-do-not-echo";
    const source = `process.stderr.write("error: " + "unrecognized" + " subcommand 'prompt-input' " + "stderr-marker-" + "do-not-echo"); process.exit(2);`;
    setPromptTextProbeCommandForTests({ binary: process.execPath, args: ["-e", source] });

    const result = await probePromptText(2_000);

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("command-unsupported");
    // stderr classifies the failure; it must never be served back in detail.
    expect(result.failure?.detail).not.toContain(marker);
    expect(result.failure?.detail).not.toContain("unrecognized subcommand");
  });

  test("an ordinary non-zero exit yields execution-failed without echoing stderr", async () => {
    const marker = "stderr-marker-do-not-echo";
    setPromptTextProbeCommandForTests({
      binary: process.execPath,
      args: ["-e", `process.stderr.write("boom " + "stderr-marker-" + "do-not-echo"); process.exit(1);`],
    });

    const result = await probePromptText(2_000);

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("codex debug prompt-input failed");
    expect(result.failure?.kind).toBe("execution-failed");
    expect(result.failure?.detail).not.toContain(marker);
  });
});
