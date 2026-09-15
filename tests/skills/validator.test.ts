import { describe, expect, test } from "bun:test";
import { isSafeRelativePath, parseSkillFrontmatter, validateSkillPackage } from "../../src/skills/validator";

describe("Skill Validator", () => {
  test("accepts safe relative paths", () => {
    expect(isSafeRelativePath("references/checklist.md")).toBe(true);
    expect(isSafeRelativePath("templates/config.json")).toBe(true);
    expect(isSafeRelativePath("nested/deep/file.txt")).toBe(true);
  });

  test("rejects path traversal attempts", () => {
    expect(isSafeRelativePath("../escape.txt")).toBe(false);
    expect(isSafeRelativePath("references/../../escape.txt")).toBe(false);
    expect(isSafeRelativePath("..\\escape.txt")).toBe(false);
    expect(isSafeRelativePath("/absolute/path")).toBe(false);
    expect(isSafeRelativePath("C:\\Windows\\System32")).toBe(false);
    expect(isSafeRelativePath("%2e%2e/encoded.txt")).toBe(false);
    expect(isSafeRelativePath("//network/share")).toBe(false);
  });

  test("parses markdown YAML frontmatter safely without eval", () => {
    const raw = `---
name: sample-skill
displayName: Sample Skill
version: 1.2.3
description: "A test procedure"
tags: test, automation
---

# Instructions
Follow these steps.
`;
    const { frontmatter, body } = parseSkillFrontmatter(raw);
    expect(frontmatter.name).toBe("sample-skill");
    expect(frontmatter.displayName).toBe("Sample Skill");
    expect(frontmatter.version).toBe("1.2.3");
    expect(frontmatter.description).toBe("A test procedure");
    expect(frontmatter.tags).toBe("test, automation");
    expect(body).toContain("# Instructions");
  });

  test("validates skill package structure and rejects empty entry content", () => {
    const emptyResult = validateSkillPackage("");
    expect(emptyResult.valid).toBe(false);
    expect(emptyResult.issues.some(i => i.field === "entry_file")).toBe(true);

    const validResult = validateSkillPackage("# Valid Skill\nInstructions here.", {
      "references/doc.md": "Reference content",
    });
    expect(validResult.valid).toBe(true);
    expect(validResult.issues.length).toBe(0);
  });

  test("rejects package when bundled file contains traversal", () => {
    const result = validateSkillPackage("# Valid Entry", {
      "../escaped.txt": "evil content",
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.message.includes("Path traversal"))).toBe(true);
  });

  test("enforces file count and size budgets", () => {
    const customLimits = {
      maxFiles: 2,
      maxSingleFileBytes: 50,
      maxTotalBytes: 100,
    };

    const countExceeded = validateSkillPackage("# Entry", {
      "f1.txt": "1",
      "f2.txt": "2",
      "f3.txt": "3",
    }, undefined, customLimits);
    expect(countExceeded.valid).toBe(false);
    expect(countExceeded.issues.some(i => i.field === "files")).toBe(true);

    const sizeExceeded = validateSkillPackage("A".repeat(150), {}, undefined, customLimits);
    expect(sizeExceeded.valid).toBe(false);
  });
});

