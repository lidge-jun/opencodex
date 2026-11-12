import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { checkRouteTrust, keyFingerprint, withoutAliasLines } from "../../src/link/route-trust";

const KEY_A = Buffer.from("ssh-ed25519 pinned key blob for the test").toString("base64");
const KEY_B = Buffer.from("ssh-ed25519 another key blob for the test").toString("base64");
const FP_A = "SHA256:" + createHash("sha256").update(Buffer.from(KEY_A, "base64")).digest("base64").replace(/=+$/, "");

test("a key's fingerprint is OpenSSH's SHA256 form of its blob", () => {
  expect(keyFingerprint(KEY_A)).toBe(FP_A);
  expect(keyFingerprint(KEY_B)).not.toBe(FP_A);
});

test("exactly one line for the alias with the pinned key passes, other links' lines are only shape-checked", () => {
  const text = ["# comment", "", "beta-host ssh-ed25519 " + KEY_B, "pen-alpha ssh-ed25519 " + KEY_A + " a comment", ""].join("\n");
  expect(checkRouteTrust(text, "pen-alpha", FP_A)).toEqual({ ok: true, line: "pen-alpha ssh-ed25519 " + KEY_A + " a comment" });
});

test.each([
  ["no line for the alias", "beta-host ssh-ed25519 " + KEY_A, "pin_mismatch"],
  ["the alias with another key", "pen-alpha ssh-ed25519 " + KEY_B, "pin_mismatch"],
  ["two lines for the alias", "pen-alpha ssh-ed25519 " + KEY_A + "\npen-alpha ssh-rsa " + KEY_B, "pin_mismatch"],
  ["a case variant with another key", "pen-alpha ssh-ed25519 " + KEY_A + "\nPEN-ALPHA ssh-ed25519 " + KEY_B, "pin_mismatch"],
  ["a case variant with the same key", "pen-alpha ssh-ed25519 " + KEY_A + "\nPen-Alpha ssh-ed25519 " + KEY_A, "pin_mismatch"],
  ["a wildcard line", "pen-alpha ssh-ed25519 " + KEY_A + "\n* ssh-ed25519 " + KEY_B, "trust_file_unexpected"],
  ["a host list", "pen-alpha,other ssh-ed25519 " + KEY_A, "trust_file_unexpected"],
  ["a hashed line", "|1|abc=|def= ssh-ed25519 " + KEY_B + "\npen-alpha ssh-ed25519 " + KEY_A, "trust_file_unexpected"],
  ["a host:port form", "[pen-alpha]:2222 ssh-ed25519 " + KEY_B + "\npen-alpha ssh-ed25519 " + KEY_A, "trust_file_unexpected"],
  ["a cert-authority marker", "@cert-authority * ssh-ed25519 " + KEY_B + "\npen-alpha ssh-ed25519 " + KEY_A, "trust_file_unexpected"],
  ["a revoked marker", "@revoked pen-alpha ssh-ed25519 " + KEY_B + "\npen-alpha ssh-ed25519 " + KEY_A, "trust_file_unexpected"],
  ["a negated pattern", "!pen-beta ssh-ed25519 " + KEY_B + "\npen-alpha ssh-ed25519 " + KEY_A, "trust_file_unexpected"],
  ["a line without a key", "pen-alpha ssh-ed25519", "trust_file_unexpected"],
  ["a key that is not base64", "pen-alpha ssh-ed25519 not*base64", "trust_file_unexpected"],
] as const)("%s is refused", (_label, text, code) => {
  expect(checkRouteTrust(text, "pen-alpha", FP_A)).toEqual({ ok: false, code });
});

test("removing an alias's lines ignores case and keeps every other line", () => {
  const text = ["beta-host ssh-ed25519 " + KEY_B, "pen-alpha ssh-ed25519 " + KEY_A, "PEN-ALPHA ssh-ed25519 " + KEY_A, "pen-alpha-2 ssh-ed25519 " + KEY_B].join("\n");
  expect(withoutAliasLines(text, "Pen-Alpha")).toEqual(["beta-host ssh-ed25519 " + KEY_B, "pen-alpha-2 ssh-ed25519 " + KEY_B]);
});

