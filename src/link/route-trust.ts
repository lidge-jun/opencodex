/**
 * The link known_hosts file as a route edit must find it (structure/remote-link.md, "Routes"). It is
 * private and written only by putKnownHost, one "<alias> <keytype> <base64>" line per alias; releases
 * before HashKnownHosts=no was passed to the probe (#6891) recorded that line hashed ("|1|salt|hash")
 * on a Home whose ssh_config hashes known_hosts. With HostKeyAlias=<alias>, OpenSSH looks a key up
 * under the alias alone: it compares plain names without case, and it lowercases the alias before
 * hashing it, so a hashed line matches exactly when it is HMAC-SHA1(salt, lowercased alias). A link
 * trusts exactly its record's key only when every line matching the alias that way carries that key
 * and no line is a pattern, list, [host]:port form or marker that could match it too.
 */
import { createHash, createHmac } from "node:crypto";
import { isSshAlias } from "./ssh-argv";

export type RouteTrustCheck = { ok: true; line: string } | { ok: false; code: "pin_mismatch" | "trust_file_unexpected" };

const KEY_TYPE = /^[a-z0-9][a-z0-9@.-]{0,63}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// OpenSSH's hashed host field: a 20-byte salt and a 20-byte HMAC-SHA1, both in base64.
const HASHED = /^\|1\|([A-Za-z0-9+/]{27}=)\|([A-Za-z0-9+/]{27}=)$/;

/** OpenSSH's SHA256 fingerprint of a public key blob given in base64. */
export function keyFingerprint(base64: string): string {
  return "SHA256:" + createHash("sha256").update(Buffer.from(base64, "base64")).digest("base64").replace(/=+$/, "");
}

function hostField(line: string): string {
  return line.trim().split(/\s+/)[0] ?? "";
}

/** Does this host field name alias for an OpenSSH lookup with HostKeyAlias=<alias>? */
function hostMatches(host: string, alias: string): boolean {
  const hashed = HASHED.exec(host);
  if (!hashed) return host.toLowerCase() === alias.toLowerCase();
  return createHmac("sha1", Buffer.from(hashed[1]!, "base64")).update(alias.toLowerCase()).digest("base64") === hashed[2];
}

function meaningful(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#");
}

/**
 * Whole-file check, then the lines that match alias (plain without case, or hashed), which must all
 * carry one key: the key OpenSSH will accept for it. Any pattern, host list, [host]:port form, marker
 * or malformed hashed field fails the whole file; a well-formed hashed line for another name is
 * another host's line.
 */
export function aliasTrustLine(text: string, alias: string): RouteTrustCheck {
  const lines = text.split(/\r?\n/).filter(meaningful);
  for (const line of lines) {
    const [host, type, key] = line.trim().split(/\s+/);
    // isSshAlias admits no * ? ! , | and no leading [ or @, so a valid host field is one literal name.
    if (!host || !type || !key || !(isSshAlias(host) || HASHED.test(host)) || !KEY_TYPE.test(type) || !BASE64.test(key)) return { ok: false, code: "trust_file_unexpected" };
  }
  const matches = lines.filter(line => hostMatches(hostField(line), alias));
  if (matches.length === 0) return { ok: false, code: "pin_mismatch" };
  // OpenSSH accepts any matching line, so several lines are one pin only when they all carry the same
  // key: legacy files hold a hashed line per confirmation, or a hashed line beside a later plain one.
  const keyOf = (line: string) => line.trim().split(/\s+/).slice(1, 3).join(" ");
  const pinned = keyOf(matches[0]!);
  return matches.every(line => keyOf(line) === pinned) ? { ok: true, line: matches[0]!.trim() } : { ok: false, code: "pin_mismatch" };
}

/** aliasTrustLine, and that one line's key has the pinned fingerprint. */
export function checkRouteTrust(text: string, alias: string, fingerprint: string | null): RouteTrustCheck {
  const found = aliasTrustLine(text, alias);
  if (!found.ok) return found;
  if (fingerprint === null) return { ok: false, code: "pin_mismatch" };
  const key = found.line.split(/\s+/)[2]!;
  return keyFingerprint(key) === fingerprint ? found : { ok: false, code: "pin_mismatch" };
}

/** The file's meaningful lines without any line OpenSSH would use for alias (any case, or hashed). */
export function withoutAliasLines(text: string, alias: string): string[] {
  // Every line OpenSSH would use for the alias goes, a hashed one included, so a confirmation replaces it.
  return text.split(/\r?\n/).filter(line => line && !hostMatches(hostField(line), alias) && !line.startsWith(alias + ","));
}

export type ConfirmedLineTrust = "trusted" | "trust_file_unexpected" | "key_changed";

/**
 * Does the file still trust exactly the key a confirmation wrote for alias? It must pass the same
 * whole-file check as a route edit (`trust_file_unexpected` otherwise: OpenCodex writes this file
 * only with plain one-alias lines, so another shape is a hand edit this check cannot rule out), and
 * every line for the alias, which may be several (a legacy hashed line beside a later plain one),
 * must carry the confirmed key type and key (`key_changed` otherwise). The probe computed the
 * confirmed fingerprint from the line it wrote (ssh-keygen -l), so that line carries it.
 */
export function confirmedLineTrust(text: string, alias: string, confirmedLine: string): ConfirmedLineTrust {
  const found = aliasTrustLine(text, alias);
  if (!found.ok) return found.code === "trust_file_unexpected" ? "trust_file_unexpected" : "key_changed";
  // The host field may be another spelling of the alias (putKnownHost replaces every case variant);
  // the key type and key are what OpenSSH will accept.
  return found.line.split(/\s+/).slice(1, 3).join(" ") === confirmedLine.trim().split(/\s+/).slice(1, 3).join(" ") ? "trusted" : "key_changed";
}

