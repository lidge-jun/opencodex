/**
 * The link known_hosts file as a route edit must find it (structure/remote-link.md, "Routes"). It is
 * private and written only by putKnownHost, one "<alias> <keytype> <base64>" line per alias. With
 * HostKeyAlias=<alias>, OpenSSH looks a key up under the alias alone and compares host names without
 * case, so a link trusts exactly its record's key only when one line matches the alias in any case and
 * no line is a pattern, list, hashed entry, [host]:port form or marker that could match it too.
 */
import { createHash } from "node:crypto";
import { isSshAlias } from "./ssh-argv";

export type RouteTrustCheck = { ok: true; line: string } | { ok: false; code: "pin_mismatch" | "trust_file_unexpected" };

const KEY_TYPE = /^[a-z0-9][a-z0-9@.-]{0,63}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** OpenSSH's SHA256 fingerprint of a public key blob given in base64. */
export function keyFingerprint(base64: string): string {
  return "SHA256:" + createHash("sha256").update(Buffer.from(base64, "base64")).digest("base64").replace(/=+$/, "");
}

function hostField(line: string): string {
  return line.trim().split(/\s+/)[0] ?? "";
}

function meaningful(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#");
}

/** Whole-file check, then exactly one case-insensitive match for alias, whose key has the pinned fingerprint. */
export function checkRouteTrust(text: string, alias: string, fingerprint: string | null): RouteTrustCheck {
  const lines = text.split(/\r?\n/).filter(meaningful);
  for (const line of lines) {
    const [host, type, key] = line.trim().split(/\s+/);
    // isSshAlias admits no * ? ! , | and no leading [ or @, so a valid host field is one literal name.
    if (!host || !type || !key || !isSshAlias(host) || !KEY_TYPE.test(type) || !BASE64.test(key)) return { ok: false, code: "trust_file_unexpected" };
  }
  const wanted = alias.toLowerCase();
  const matches = lines.filter(line => hostField(line).toLowerCase() === wanted);
  if (matches.length !== 1 || fingerprint === null) return { ok: false, code: "pin_mismatch" };
  const key = matches[0]!.trim().split(/\s+/)[2]!;
  return keyFingerprint(key) === fingerprint ? { ok: true, line: matches[0]!.trim() } : { ok: false, code: "pin_mismatch" };
}

/** The file's meaningful lines without any line whose host field names alias in any case. */
export function withoutAliasLines(text: string, alias: string): string[] {
  const wanted = alias.toLowerCase();
  return text.split(/\r?\n/).filter(line => line && hostField(line).toLowerCase() !== wanted && !line.startsWith(alias + ","));
}

/**
 * Does the file still trust exactly the line a confirmation wrote for alias? The line must be there,
 * and no other line may name the alias in any case (OpenSSH would accept its key too).
 */
export function confirmedLineTrustedIn(text: string, alias: string, confirmedLine: string): boolean {
  const lines = text.split(/\r?\n/).filter(meaningful).map(line => line.trim());
  const target = confirmedLine.trim();
  if (!lines.includes(target)) return false;
  const wanted = alias.toLowerCase();
  return lines.every(line => line === target || hostField(line).toLowerCase() !== wanted);
}

