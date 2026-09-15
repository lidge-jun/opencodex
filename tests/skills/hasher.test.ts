import { describe, expect, test } from "bun:test";
import { computeSkillContentHash, sha256 } from "../../src/skills/hasher";

describe("Skill Hasher & Integrity", () => {
  test("computes accurate sha256 for string and buffer", () => {
    const textHash = sha256("hello world");
    expect(textHash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");

    const bufHash = sha256(Buffer.from("hello world", "utf8"));
    expect(bufHash).toBe(textHash);
  });

  test("produces deterministic composite content hash regardless of object key order", () => {
    const entry = "# Test Skill";
    const filesA = {
      "b.txt": "file b",
      "a.txt": "file a",
    };
    const filesB = {
      "a.txt": "file a",
      "b.txt": "file b",
    };

    const hashA = computeSkillContentHash(entry, filesA);
    const hashB = computeSkillContentHash(entry, filesB);

    expect(hashA.contentSha256).toBe(hashB.contentSha256);
    expect(hashA.filesSha256).toEqual(hashB.filesSha256);
  });

  test("any content mutation strictly alters the content hash", () => {
    const entry = "# Test Skill";
    const original = computeSkillContentHash(entry, { "ref.txt": "v1" });
    const mutatedEntry = computeSkillContentHash(entry + "\n// modified", { "ref.txt": "v1" });
    const mutatedFile = computeSkillContentHash(entry, { "ref.txt": "v2" });

    expect(original.contentSha256).not.toBe(mutatedEntry.contentSha256);
    expect(original.contentSha256).not.toBe(mutatedFile.contentSha256);
  });
});

