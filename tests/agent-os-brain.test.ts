import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentOsDbForTests } from "../src/agent-os/db";
import { registerProject, scanProject } from "../src/agent-os/brain-scanner";
import {
  closeSession,
  createSession,
  eventsForSession,
  importSessionJsonl,
  listSessions,
  mapToCanonicalEvent,
} from "../src/agent-os/brain-sessions";

const tempHomes: string[] = [];
const tempProjects: string[] = [];

function openFreshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-brain-"));
  tempHomes.push(dir);
  closeAgentOsDbForTests();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../src/agent-os/db").openAgentOsDb(dir);
}

function makeProjectTree(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-proj-"));
  tempProjects.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Test project");
  writeFileSync(join(root, "AGENTS.md"), "read me first");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "19", next: "15" } }));
  writeFileSync(join(root, "src", "index.ts"), "export {};");
  writeFileSync(join(root, ".env"), "SECRET_KEY=super-secret-value");
  writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
  return root;
}

afterEach(() => {
  closeAgentOsDbForTests();
  while (tempHomes.length) rmSync(tempHomes.pop()!, { recursive: true, force: true });
  while (tempProjects.length) rmSync(tempProjects.pop()!, { recursive: true, force: true });
});

describe("phase 15 — project scanner (read-only)", () => {
  test("scans files, ignores node_modules, excludes secrets without reading them", () => {
    openFreshDb();
    const root = makeProjectTree();
    const project = registerProject({ name: "Test", rootPath: root });
    const result = scanProject(project.id, "standard");

    const paths = result.files.map((f) => f.path);
    expect(paths).toContain(join("src", "index.ts"));
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);

    // Secret excluded and its content never indexed anywhere.
    const envFile = result.files.find((f) => f.path === ".env");
    expect(envFile?.disposition).toBe("secret_excluded");
    expect(JSON.stringify(result)).not.toContain("super-secret-value");

    expect(result.coverage.filesIgnored).toBeGreaterThanOrEqual(1);
    expect(result.detected.agentInstructions).toContain("AGENTS.md");
    expect(result.detected.frameworks).toContain("react");
    expect(result.detected.frameworks).toContain("next");
  });

  test("second scan records a coverage row and scanner never writes into the project", () => {
    openFreshDb();
    const root = makeProjectTree();
    const project = registerProject({ name: "Test", rootPath: root });
    scanProject(project.id, "quick");
    const second = scanProject(project.id, "quick");
    expect(second.coverage.filesScanned).toBeGreaterThan(0);
    // Tree unchanged: scanner created nothing.
    expect(existsSync(join(root, "agent-os.sqlite3"))).toBe(false);
  });

  test("symlinked directories are never followed", () => {
    openFreshDb();
    const root = makeProjectTree();
    const outside = mkdtempSync(join(tmpdir(), "brain-outside-"));
    tempProjects.push(outside);
    writeFileSync(join(outside, "secret.txt"), "outside content");
    try {
      symlinkSync(outside, join(root, "escaped"));
    } catch {
      // Windows symlink privileges may be missing; the scan path is still safe.
    }
    const project = registerProject({ name: "T", rootPath: root });
    const result = scanProject(project.id, "quick");
    expect(result.files.some((f) => f.path.startsWith("escaped"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("outside content");
  });
});

describe("phase 15 — session indexer", () => {
  test("canonical mapping covers claude + codex event vocabularies", () => {
    openFreshDb();
    expect(mapToCanonicalEvent({ type: "user", timestamp: "2026-08-29T01:00:00Z" })?.eventType).toBe("user.message");
    expect(mapToCanonicalEvent({ type: "assistant" })?.eventType).toBe("agent.message");
    expect(mapToCanonicalEvent({ type: "tool_use" })?.eventType).toBe("tool.called");
    expect(mapToCanonicalEvent({ event: "test_pass" })?.eventType).toBe("test.passed");
    expect(mapToCanonicalEvent({ type: "custom.thing" })?.eventType).toBe("custom.thing");
    expect(mapToCanonicalEvent({})).toBeNull();
  });

  test("imports a JSONL log with broken lines counted, not fatal", async () => {
    openFreshDb();
    const session = createSession({ source: "claude", agentId: "agent_codex" });
    const lines = [
      JSON.stringify({ type: "user", timestamp: "2026-08-29T01:00:00Z", text: "hi" }),
      "{ this is broken",
      "",
      JSON.stringify({ type: "tool_use", timestamp: "2026-08-29T01:03:00Z", name: "read" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-08-29T01:05:00Z", text: "done" }),
    ];
    const dir = mkdtempSync(join(tmpdir(), "brain-jsonl-"));
    tempProjects.push(dir);
    const file = join(dir, "session.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");

    const progress = await importSessionJsonl(session.id, file);
    expect(progress.eventsIngested).toBe(3);
    expect(progress.linesBroken).toBe(1);
    const events = eventsForSession(session.id);
    expect(events.map((e) => e.eventType)).toEqual(["user.message", "tool.called", "agent.message"]);
  });

  test("resume: re-import after a checkpoint does not duplicate events", async () => {
    openFreshDb();
    const session = createSession({ source: "codex" });
    const dir = mkdtempSync(join(tmpdir(), "brain-jsonl2-"));
    tempProjects.push(dir);
    const file = join(dir, "session.jsonl");
    writeFileSync(file, JSON.stringify({ type: "user" }) + "\n" + JSON.stringify({ type: "assistant" }) + "\n");

    await importSessionJsonl(session.id, file);
    expect(eventsForSession(session.id)).toHaveLength(2);
    // Re-running the import resumes from the stored offset: no new events.
    const again = await importSessionJsonl(session.id, file);
    expect(again.eventsIngested).toBe(0);
    expect(eventsForSession(session.id)).toHaveLength(2);
  });

  test("session lifecycle: running -> completed, listable per project", () => {
    openFreshDb();
    const s = createSession({ source: "pao", projectId: "proj_x" });
    expect(listSessions("proj_x").map((x) => x.id)).toContain(s.id);
    expect(closeSession(s.id)).toBe(true);
    expect(listSessions("proj_x")[0].status).toBe("completed");
  });
});
