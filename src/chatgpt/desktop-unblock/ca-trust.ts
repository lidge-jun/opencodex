import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSecurityRunner, loginKeychainPath, type SecurityRunner } from "../../claude/intercept/picker-trust";

/**
 * Conservative inspection of the current CA's user-domain TLS trust configuration.
 *
 * Missing usable trust can leave intercepted account, usage and settings pages empty.
 * `ocx chatgpt status` inspects the documented login-keychain setup. Trust is matched by
 * the CA's SHA-1 fingerprint in both the login keychain and exported trust settings. This
 * does not evaluate the running app's leaf or prove that a particular app build accepts it.
 */

export type ChatgptCaTrust = "trusted" | "untrusted" | "missing" | "unknown" | "unsupported";

export function certificateSha1(pem: string): string {
  return new X509Certificate(pem).fingerprint.replace(/:/g, "").toUpperCase();
}

interface PlistNode { tag: string; text: string; children: PlistNode[] }
const MAX_TRUST_SETTINGS_BYTES = 8 * 1024 * 1024;

/** Only Apple's XML plist vocabulary; no entity declarations, external resolution or recovery. */
function parseTrustPlist(xml: string): PlistNode {
  if (Buffer.byteLength(xml) > MAX_TRUST_SETTINGS_BYTES) throw new Error("oversized trust settings");
  let offset = 0;
  let nodes = 0;
  const skip = () => {
    while (true) {
      const space = /^\s+/.exec(xml.slice(offset));
      if (space) offset += space[0].length;
      if (!xml.startsWith("<!--", offset)) return;
      const end = xml.indexOf("-->", offset + 4);
      if (end < 0 || xml.slice(offset + 4, end).includes("--")) throw new Error("invalid comment");
      offset = end + 3;
    }
  };
  skip();
  const declaration = /^<\?xml\s+[^?<>]*\?>/.exec(xml.slice(offset));
  if (declaration) offset += declaration[0].length;
  skip();
  const doctype = /^<!DOCTYPE plist PUBLIC "[^"<>\[\]]*" "[^"<>\[\]]*">/.exec(xml.slice(offset));
  if (doctype) offset += doctype[0].length;
  skip();
  const root = /^<plist(?:\s+version=["']1\.0["'])?\s*>/.exec(xml.slice(offset));
  if (!root) throw new Error("invalid plist");
  offset += root[0].length;
  const parse = (depth: number): PlistNode => {
    skip();
    if (depth > 16 || ++nodes > 100_000) throw new Error("trust settings complexity limit");
    const open = /^<(dict|array|key|string|integer|data|date|real|true|false)\s*(\/?)>/.exec(xml.slice(offset));
    if (!open) throw new Error("invalid plist value");
    offset += open[0].length;
    const node: PlistNode = { tag: open[1]!, text: "", children: [] };
    if (!open[2]) {
      const close = `</${node.tag}>`;
      if (node.tag === "dict" || node.tag === "array") {
        skip();
        while (!xml.startsWith(close, offset)) { node.children.push(parse(depth + 1)); skip(); }
      } else {
        const end = xml.indexOf("<", offset);
        if (end < 0 || !xml.startsWith(close, end)) throw new Error("invalid plist text");
        const raw = xml.slice(offset, end);
        node.text = raw.replace(/&(?:amp|lt|gt|quot|apos);|&/g, entity => {
          const decoded = ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" } as Record<string, string>)[entity];
          if (decoded === undefined) throw new Error("unsupported XML entity");
          return decoded;
        });
        offset = end;
      }
      offset += close.length;
    }
    if (node.tag === "dict") plistDictionary(node);
    if (node.tag === "array" && node.children.some(child => child.tag === "key")) throw new Error("key outside dictionary");
    return node;
  };
  const value = parse(0);
  skip();
  if (!xml.startsWith("</plist>", offset)) throw new Error("invalid plist ending");
  offset += "</plist>".length;
  skip();
  if (offset !== xml.length) throw new Error("trailing plist data");
  return value;
}

function plistDictionary(node: PlistNode): Map<string, PlistNode> {
  if (node.tag !== "dict" || node.children.length % 2) throw new Error("invalid plist dictionary");
  const result = new Map<string, PlistNode>();
  for (let i = 0; i < node.children.length; i += 2) {
    const key = node.children[i]!;
    const value = node.children[i + 1]!;
    if (key.tag !== "key" || value.tag === "key" || result.has(key.text)) throw new Error("invalid or duplicate plist key");
    result.set(key.text, value);
  }
  return result;
}

function configuredTlsTrust(xml: string, sha1: string): ChatgptCaTrust {
  const trustList = plistDictionary(parseTrustPlist(xml)).get("trustList");
  if (!trustList) return "unknown";
  const entry = plistDictionary(trustList).get(sha1);
  if (!entry) return "untrusted";
  const settings = plistDictionary(entry).get("trustSettings");
  if (!settings || settings.tag !== "array") return "unknown";
  if (settings.children.length === 0) return "trusted";
  let positive = false;
  for (const setting of settings.children) {
    const record = plistDictionary(setting);
    // Chromium ignores application- and hostname-scoped settings. Do not infer that
    // a successful native security evaluation would make those usable by the app.
    if (record.has("kSecTrustSettingsApplication") || record.has("kSecTrustSettingsPolicyString")) continue;
    const policy = record.get("kSecTrustSettingsPolicy");
    if (policy) {
      // kSecPolicyAppleSSL, as a string OID or legacy CSSM OID bytes in Apple's export.
      if (policy.tag !== "string" && policy.tag !== "data") return "unknown";
      if (policy.tag === "data" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(policy.text.replace(/\s/g, ""))) return "unknown";
      const ssl = policy.tag === "string" ? policy.text === "1.2.840.113635.100.1.3"
        : policy.tag === "data" ? policy.text.replace(/\s/g, "") === "KoZIhvdjZAED" : false;
      if (!ssl) continue;
    }
    const policyName = record.get("kSecTrustSettingsPolicyName");
    if (policyName && (policyName.tag !== "string" || policyName.text !== "sslServer")) return "unknown";
    // Error exceptions and usage restrictions need native policy evaluation. They are
    // not positive proof of ordinary TLS trust, even when a root result is present.
    if ([...record.keys()].some(key => !["kSecTrustSettingsPolicy", "kSecTrustSettingsPolicyName", "kSecTrustSettingsResult"].includes(key))) return "unknown";
    const result = record.get("kSecTrustSettingsResult");
    if (result && (result.tag !== "integer" || !/^[1-4]$/.test(result.text.trim()))) return "unknown";
    const value = result ? Number(result.text) : 1;
    if (value === 3) return "untrusted";
    if (value === 1) positive = true;
    // trustAsRoot applies to non-root certificates; this helper requires a self-signed CA.
  }
  return positive ? "trusted" : "untrusted";
}

export async function inspectChatgptCaTrust(
  caPath: string,
  run: SecurityRunner = defaultSecurityRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<ChatgptCaTrust> {
  if (platform !== "darwin") return "unsupported";
  if (!existsSync(caPath)) return "missing";
  let dir: string | undefined;
  try {
    const certificate = new X509Certificate(readFileSync(caPath, "utf8"));
    const now = Date.now();
    if (!certificate.ca || certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey)
      || !(Date.parse(certificate.validFrom) <= now && now < Date.parse(certificate.validTo))) return "untrusted";
    const sha1 = certificate.fingerprint.replace(/:/g, "").toUpperCase();
    dir = mkdtempSync(join(tmpdir(), "ocx-chatgpt-trust-"));
    const file = join(dir, "trust-settings.plist");
    const exported = await run(["trust-settings-export", file]);
    if (exported.code !== 0) {
      // A user domain with no trust settings at all cannot be exported; that is plain "untrusted".
      return /no trust settings/i.test(`${exported.stdout}${exported.stderr}`) ? "untrusted" : "unknown";
    }
    if (statSync(file).size > MAX_TRUST_SETTINGS_BYTES) return "unknown";
    const configured = configuredTlsTrust(readFileSync(file, "utf8"), sha1);
    if (configured !== "trusted") return configured;
    // A trust-settings record can outlive the certificate item. Require its exact
    // fingerprint in the documented login keychain, not a same-name replacement.
    const found = await run(["find-certificate", "-a", "-Z", loginKeychainPath()]);
    if (found.code !== 0) return found.code === 1 ? "untrusted" : "unknown";
    return found.stdout.split(/\r?\n/).some(line => /^SHA-1 hash:\s*([0-9A-Fa-f]{40})\s*$/.exec(line.trim())?.[1]?.toUpperCase() === sha1)
      ? "trusted" : "untrusted";
  } catch { // no-excuse-ok: catch -- unreadable certificate or trust settings are no evidence of trust.
    return "unknown";
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** The command that restores trust; it prompts for the login password, so only the user runs it. */
export function chatgptCaTrustCommand(caPath: string): string {
  const quote = (path: string) => `'${path.replace(/'/g, "'\\''")}'`;
  return `security add-trusted-cert -r trustRoot -p ssl -k ${quote(loginKeychainPath())} ${quote(caPath)}`;
}
