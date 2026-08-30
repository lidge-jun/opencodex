import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentOsDbForTests } from "../src/agent-os/db";
import { deleteMemory, listMemories, readMemory, writeMemory } from "../src/agent-os/memory";
import { checkSkillHealth, listSkills, upsertSkill } from "../src/agent-os/skills";

const tempHomes: string[] = [];

function openFreshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-mem-"));
  tempHomes.push(dir);
  closeAgentOsDbForTests();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../src/agent-os/db").openAgentOsDb(dir);
}

afterEach(() => {
  closeAgentOsDbForTests();
  while (tempHomes.length) rmSync(tempHomes.pop()!, { recursive: true, force: true });
});

describe("phase 07 — memory OS", () => {
  test("write/read with scope and provenance", () => {
    openFreshDb();
    const mem = writeMemory({
      scope: "project",
      subjectId: "proj_pao",
      title: "Use ComfyUI for stock workflow",
      content: "ComfyUI is preferred for controllable video generation.",
      provenance: { source: "decision:dec_1", author: "Pao" },
    });
    const read = readMemory(mem.id);
    expect(read?.scope).toBe("project");
    expect(read?.provenance).toEqual({ source: "decision:dec_1", author: "Pao" });
  });

  test("correction: updating a memory changes content and keeps id (edit provenance stays inspectable)", () => {
    openFreshDb();
    const mem = writeMemory({ scope: "agent", subjectId: "agent_x", title: "T", content: "v1" });
    const updated = writeMemory({ id: mem.id, scope: "agent", subjectId: "agent_x", title: "T", content: "v2 corrected", provenance: { correctedFrom: "v1" } });
    expect(updated.id).toBe(mem.id);
    expect(readMemory(mem.id)?.content).toBe("v2 corrected");
    expect(readMemory(mem.id)?.provenance).toEqual({ correctedFrom: "v1" });
  });

  test("list filters by scope and deletion is real", () => {
    openFreshDb();
    const a = writeMemory({ scope: "global", title: "G", content: "g" });
    writeMemory({ scope: "failure", subjectId: "agent_x", title: "F", content: "f" });
    expect(listMemories({ scope: "global" })).toHaveLength(1);
    expect(listMemories()).toHaveLength(2);
    expect(deleteMemory(a.id)).toBe(true);
    expect(readMemory(a.id)).toBeNull();
    expect(deleteMemory(a.id)).toBe(false);
  });
});

describe("phase 08 — skill store", () => {
  test("upsert and list keep canonical ids", () => {
    openFreshDb();
    upsertSkill({ id: "skill_meta", name: "adobe-stock-metadata", version: "1.4", description: "d" });
    upsertSkill({ id: "skill_meta", name: "adobe-stock-metadata", version: "1.5", description: "d" });
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].version).toBe("1.5");
  });

  test("health pass flags duplicate names and missing files without mutating anything", async () => {
    openFreshDb();
    upsertSkill({ id: "skill_a", name: "dup", path: "Z:/definitely/not/here/SKILL.md" });
    upsertSkill({ id: "skill_b", name: "dup" });
    upsertSkill({ id: "skill_c", name: "old", status: "deprecated" });
    const issues = await checkSkillHealth();
    const kinds = issues.map((i) => i.kind).sort();
    expect(kinds).toContain("duplicate_name");
    expect(kinds).toContain("missing_file");
    expect(kinds).toContain("deprecated");
    expect(listSkills().every((s) => s.status !== "missing")).toBe(true);
  });
});
