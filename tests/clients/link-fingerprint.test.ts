import { describe, expect, test } from "bun:test";
import { buildFingerprintArgv } from "../../src/link/ssh-argv";
import { parseFingerprintLine } from "../../src/link/fingerprint";

describe("link fingerprint", () => {
  test("builds an argv with the path as one element", () => {
    expect(buildFingerprintArgv("/tmp/known hosts")).toEqual(["ssh-keygen", "-l", "-f", "/tmp/known hosts"]);
  });

  test("parses one ssh-keygen fingerprint line", () => {
    expect(parseFingerprintLine("256 SHA256:abcDEF0123+/= home.example (ED25519)"))
      .toEqual({ bits: 256, fingerprint: "SHA256:abcDEF0123+/=", alias: "home.example", keyType: "ED25519" });
  });

  test("rejects empty and multi-line output", () => {
    expect(() => parseFingerprintLine("")).toThrow();
    expect(() => parseFingerprintLine("256 SHA256:abcDEF0123456789 alias (ED25519)\nextra")).toThrow();
  });

  test("rejects a format that is not the ssh-keygen line contract", () => {
    expect(() => parseFingerprintLine("SHA256:abc alias ED25519")).toThrow();
    expect(() => parseFingerprintLine("256 MD5:abc alias (RSA)")).toThrow();
  });
});
