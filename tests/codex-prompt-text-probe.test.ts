/**
 * The prompt-text probe: what it reads, and what it refuses to guess.
 *
 * These are unit tests over the pure extraction and classification logic. The
 * spawn itself is exercised by the route test and by hand; what matters here is
 * that a missing body is attributed to the right cause, because the dialog shows
 * that attribution to a user as an explanation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSectionsForTests,
  probePromptText,
  promptTextProbeSpawnAttemptsForTests,
  resetPromptTextProbeForTests,
  setPromptTextProbeCloseBarrierForTests,
  setPromptTextProbeCommandForTests,
} from "../src/codex/prompt-text-probe";

const lifecycleRoots: string[] = [];
const VALID_PROBE_OUTPUT = JSON.stringify([{
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text: "<skills_instructions>Skill text.</skills_instructions>" }],
}]);

function message(text: string): string {
  return JSON.stringify([{ type: "message", role: "developer", content: [{ type: "input_text", text }] }]);
}

async function waitUntil(predicate: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`);
    await Bun.sleep(10);
  }
}

function isProcessAlive(pid: number): boolean {
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

afterEach(async () => {
  await resetPromptTextProbeForTests();
  while (lifecycleRoots.length) rmSync(lifecycleRoots.pop()!, { recursive: true, force: true });
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
      `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1_000);",
    ].join("");
    setPromptTextProbeCommandForTests({ binary: process.execPath, args: ["-e", hangingSource] });
    const controller = new AbortController();
    const hanging = probePromptText(5_000, controller.signal);
    await waitUntil(() => existsSync(pidPath), "hanging child pid");
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(isProcessAlive(pid)).toBe(true);

    controller.abort();
    expect((await hanging).detail).toBe("prompt probe cancelled");

    const replacementSource = [
      `const fs = require("node:fs"); const pid = Number(fs.readFileSync(${JSON.stringify(pidPath)}, "utf8"));`,
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

  test("admission stays occupied between child exit and close handling", async () => {
    const pidPath = join(root(), "exited-parent-pid.txt");
    let releaseClose!: () => void;
    setPromptTextProbeCloseBarrierForTests(new Promise<void>(resolve => { releaseClose = resolve; }));
    const delayedCloseSource = [
      `const fs = require("node:fs");`,
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      `process.stdout.write(${JSON.stringify(VALID_PROBE_OUTPUT)});`,
    ].join("");
    setPromptTextProbeCommandForTests({ binary: process.execPath, args: ["-e", delayedCloseSource] });
    const first = probePromptText(2_000);
    await waitUntil(() => existsSync(pidPath), "exit-close parent pid");
    const pid = Number(readFileSync(pidPath, "utf8"));
    await waitUntil(() => !isProcessAlive(pid), "probe parent exit");

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
  });
});
