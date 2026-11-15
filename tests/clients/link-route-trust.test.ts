import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { checkRouteTrust, confirmedLineTrust, keyFingerprint, withoutAliasLines } from "../../src/link/route-trust";

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


test("apply trusts the confirmed line only when it is the one line OpenSSH can use for the alias", () => {
  const confirmed = "home ssh-ed25519 " + KEY_A;
  expect(confirmedLineTrust(confirmed + "\nbeta-host ssh-ed25519 " + KEY_B + "\n", "home", confirmed)).toBe("trusted");
  // Another spelling written by a later confirmation of the same key.
  expect(confirmedLineTrust("HOME ssh-ed25519 " + KEY_A + "\n", "home", confirmed)).toBe("trusted");
  // Shapes OpenCodex never writes, even naming another host: this check cannot rule them out.
  for (const extra of ["* ssh-ed25519 " + KEY_B, "home,other ssh-ed25519 " + KEY_B, "beta,gamma ssh-ed25519 " + KEY_B, "|1|c2FsdA==|aGFzaA== ssh-ed25519 " + KEY_B, "@cert-authority * ssh-ed25519 " + KEY_B]) {
    expect(confirmedLineTrust(confirmed + "\n" + extra + "\n", "home", confirmed)).toBe("trust_file_unexpected");
  }
  expect(confirmedLineTrust(confirmed + "\nHOME ssh-ed25519 " + KEY_B + "\n", "home", confirmed)).toBe("key_changed");
  expect(confirmedLineTrust("home ssh-ed25519 " + KEY_B + "\n", "home", confirmed)).toBe("key_changed");
  expect(confirmedLineTrust("", "home", confirmed)).toBe("key_changed");
});

function hashedHost(name: string, salt = Buffer.alloc(20, 7)): string {
  return "|1|" + salt.toString("base64") + "|" + createHmac("sha1", salt).update(name).digest("base64");
}

test("a hashed line written by an older release counts for the alias it hashes, lowercased as OpenSSH does", () => {
  // Releases before HashKnownHosts=no recorded the probe's line hashed on Homes whose ssh_config hashes.
  const pin = hashedHost("pen-alpha") + " ssh-ed25519 " + KEY_A;
  expect(checkRouteTrust(pin + "\n", "pen-alpha", FP_A)).toEqual({ ok: true, line: pin });
  expect(checkRouteTrust(pin + "\n", "Pen-Alpha", FP_A)).toEqual({ ok: true, line: pin });
  // Another link's hashed line is another host's line.
  const other = hashedHost("beta-host", Buffer.alloc(20, 9)) + " ssh-ed25519 " + KEY_B;
  expect(checkRouteTrust(other + "\npen-alpha ssh-ed25519 " + KEY_A + "\n", "pen-alpha", FP_A)).toEqual({ ok: true, line: "pen-alpha ssh-ed25519 " + KEY_A });
  expect(confirmedLineTrust(other + "\nhome ssh-ed25519 " + KEY_A + "\n", "home", "home ssh-ed25519 " + KEY_A)).toBe("trusted");
  // A hashed line for the alias beside a plain one is a second key OpenSSH would accept.
  const extra = hashedHost("pen-alpha", Buffer.alloc(20, 3)) + " ssh-ed25519 " + KEY_B;
  expect(checkRouteTrust("pen-alpha ssh-ed25519 " + KEY_A + "\n" + extra + "\n", "pen-alpha", FP_A)).toEqual({ ok: false, code: "pin_mismatch" });
  expect(confirmedLineTrust("home ssh-ed25519 " + KEY_A + "\n" + hashedHost("home") + " ssh-ed25519 " + KEY_B + "\n", "home", "home ssh-ed25519 " + KEY_A)).toBe("key_changed");
  // A line hashed from another spelling never matches: OpenSSH hashes the lowercased alias.
  expect(checkRouteTrust(hashedHost("PEN-ALPHA") + " ssh-ed25519 " + KEY_B + "\npen-alpha ssh-ed25519 " + KEY_A + "\n", "pen-alpha", FP_A).ok).toBe(true);
  // A malformed hashed field still fails the whole file.
  expect(checkRouteTrust("|1|c2FsdA==|aGFzaA== ssh-ed25519 " + KEY_B + "\npen-alpha ssh-ed25519 " + KEY_A + "\n", "pen-alpha", FP_A)).toEqual({ ok: false, code: "trust_file_unexpected" });
});

test("removing an alias's lines also removes a hashed line for it, and keeps another host's", () => {
  const mine = hashedHost("pen-alpha") + " ssh-ed25519 " + KEY_A;
  const theirs = hashedHost("beta-host", Buffer.alloc(20, 9)) + " ssh-ed25519 " + KEY_B;
  expect(withoutAliasLines(mine + "\n" + theirs + "\n", "PEN-ALPHA")).toEqual([theirs]);
});

test("a case variant with the same key is the same pin", () => {
  expect(checkRouteTrust("pen-alpha ssh-ed25519 " + KEY_A + "\nPen-Alpha ssh-ed25519 " + KEY_A, "pen-alpha", FP_A)).toEqual({ ok: true, line: "pen-alpha ssh-ed25519 " + KEY_A });
});

test("several lines for the alias pass when they all carry the pinned key, as legacy files hold them", () => {
  // Releases before 2.89 appended a hashed line on every confirmation, and a later release appends a plain one beside it.
  const first = hashedHost("pen-alpha") + " ssh-ed25519 " + KEY_A;
  const second = hashedHost("pen-alpha", Buffer.alloc(20, 3)) + " ssh-ed25519 " + KEY_A;
  const plain = "pen-alpha ssh-ed25519 " + KEY_A;
  expect(checkRouteTrust(first + "\n" + second + "\n", "pen-alpha", FP_A)).toEqual({ ok: true, line: first });
  expect(checkRouteTrust(first + "\n" + plain + "\n", "pen-alpha", FP_A)).toEqual({ ok: true, line: first });
  expect(confirmedLineTrust(first + "\n" + plain + "\n", "pen-alpha", plain)).toBe("trusted");
  // A second, different key for the alias still fails, whatever its form.
  expect(checkRouteTrust(first + "\n" + hashedHost("pen-alpha", Buffer.alloc(20, 4)) + " ssh-ed25519 " + KEY_B + "\n", "pen-alpha", FP_A)).toEqual({ ok: false, code: "pin_mismatch" });
  expect(checkRouteTrust(first + "\npen-alpha ssh-rsa " + KEY_A + "\n", "pen-alpha", FP_A)).toEqual({ ok: false, code: "pin_mismatch" });
});
