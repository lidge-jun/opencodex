import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificateSha1, chatgptCaTrustCommand, inspectChatgptCaTrust } from "../../src/chatgpt/desktop-unblock/ca-trust";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { loginKeychainPath, type SecurityRunner } from "../../src/claude/intercept/picker-trust";

let dir: string;
let caPath: string;
let sha1: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-chatgpt-ca-trust-"));
  caPath = join(dir, "ca.pem");
  const ca = createLocalInterceptCa();
  writeFileSync(caPath, ca.certPem);
  sha1 = certificateSha1(ca.certPem);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** `security trust-settings-export <file>` stand-in that writes the given trusted fingerprints. */
function exporting(fingerprints: string[]): SecurityRunner {
  return async args => {
    if (args[0] === "find-certificate") {
      expect(args).toEqual(["find-certificate", "-a", "-Z", loginKeychainPath()]);
      return { code: 0, stdout: fingerprints.map(hash => `SHA-1 hash: ${hash}`).join("\n"), stderr: "" };
    }
    expect(args[0]).toBe("trust-settings-export");
    const entries = fingerprints.map(f => `<key>${f}</key><dict><key>trustSettings</key><array/></dict>`).join("");
    writeFileSync(args[1]!, `<plist><dict><key>trustList</key><dict>${entries}</dict></dict></plist>`);
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("a CA whose fingerprint has user trust settings is trusted", async () => {
  expect(await inspectChatgptCaTrust(caPath, exporting(["00".repeat(20), sha1]), "darwin")).toBe("trusted");
});

test("an explicit deny record for the current CA is never trusted", async () => {
  const run: SecurityRunner = async args => {
    expect(args[0]).toBe("trust-settings-export");
    writeFileSync(args[1]!, `<plist><dict><key>trustList</key><dict><key>${sha1}</key><dict>`
      + "<key>trustSettings</key><array><dict><key>kSecTrustSettingsResult</key><integer>3</integer>"
      + "</dict></array></dict></dict></dict></plist>");
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(await inspectChatgptCaTrust(caPath, run, "darwin")).toBe("untrusted");
});

test("trust for a different certificate does not count", async () => {
  expect(await inspectChatgptCaTrust(caPath, exporting(["AB".repeat(20)]), "darwin")).toBe("untrusted");
});

test("a user domain with no trust settings at all is untrusted, not unknown", async () => {
  const none: SecurityRunner = async () => ({ code: 1, stdout: "", stderr: "SecTrustSettingsCreateExternalRepresentation: No Trust Settings were found." });
  expect(await inspectChatgptCaTrust(caPath, none, "darwin")).toBe("untrusted");
});

test("any other export failure is reported as unknown, never as trusted", async () => {
  const failing: SecurityRunner = async () => ({ code: 1, stdout: "", stderr: "User interaction is not allowed." });
  expect(await inspectChatgptCaTrust(caPath, failing, "darwin")).toBe("unknown");
  const throwing: SecurityRunner = async () => { throw new Error("spawn failed"); };
  expect(await inspectChatgptCaTrust(caPath, throwing, "darwin")).toBe("unknown");
});

test("a CA that was never created is reported as missing", async () => {
  expect(await inspectChatgptCaTrust(join(dir, "absent.pem"), exporting([]), "darwin")).toBe("missing");
});

test("other platforms are not applicable", async () => {
  expect(await inspectChatgptCaTrust(caPath, exporting([sha1]), "linux")).toBe("unsupported");
});

test("the restore command trusts this CA for TLS as a root in the login keychain", () => {
  const command = chatgptCaTrustCommand(caPath);
  expect(command).toStartWith("security add-trusted-cert -r trustRoot -p ssl -k ");
  expect(command).toContain("login.keychain-db");
  expect(command).toEndWith(`'${caPath}'`);
});

function settingsPlist(settings: string, fingerprint = sha1): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0"><dict><key>trustList</key><dict><key>${fingerprint}</key><dict>`
    + `<key>trustSettings</key><array>${settings}</array></dict></dict></dict></plist>`;
}

function exportXml(xml: string, listed = sha1): { run: SecurityRunner; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, run: async args => {
    calls.push([...args]);
    if (args[0] === "trust-settings-export") writeFileSync(args[1]!, xml);
    else expect(args).toEqual(["find-certificate", "-a", "-Z", loginKeychainPath()]);
    return { code: 0, stdout: `SHA-1 hash: ${listed}\n`, stderr: "" };
  } };
}

const sslPolicy = "<key>kSecTrustSettingsPolicy</key><data>KoZIhvdjZAED</data>"
  + "<key>kSecTrustSettingsPolicyName</key><string>sslServer</string>";
const rootResult = "<key>kSecTrustSettingsResult</key><integer>1</integer>";

test("only ordinary, unscoped SSL or all-policy root settings count as configured trust", async () => {
  for (const settings of ["", "<dict/>", `<dict>${rootResult}</dict>`, `<dict>${sslPolicy}${rootResult}</dict>`,
    '<dict><key>kSecTrustSettingsPolicy</key><string>1.2.840.113635.100.1.3</string></dict>']) {
    const f = exportXml(settingsPlist(settings));
    expect(await inspectChatgptCaTrust(caPath, f.run, "darwin")).toBe("trusted");
    expect(f.calls.map(call => call[0])).toEqual(["trust-settings-export", "find-certificate"]);
  }
});

test("deny, unspecified, non-SSL and app/hostname-scoped settings never imply app trust", async () => {
  const denied = "<dict><key>kSecTrustSettingsResult</key><integer>3</integer></dict>";
  for (const settings of [denied, `<dict>${rootResult}</dict>${denied}`, `${denied}<dict>${rootResult}</dict>`,
    '<dict><key>kSecTrustSettingsResult</key><integer>4</integer></dict>',
    '<dict><key>kSecTrustSettingsResult</key><integer>2</integer></dict>',
    '<dict><key>kSecTrustSettingsPolicy</key><string>1.2.840.113635.100.1.16</string></dict>',
    `<dict>${sslPolicy}<key>kSecTrustSettingsApplication</key><data>AA==</data>${rootResult}</dict>`,
    `<dict>${sslPolicy}<key>kSecTrustSettingsPolicyString</key><string>chatgpt.com</string>${rootResult}</dict>`]) {
    const f = exportXml(settingsPlist(settings));
    expect(await inspectChatgptCaTrust(caPath, f.run, "darwin")).toBe("untrusted");
    expect(f.calls).toHaveLength(1);
  }
});

test("unknown constraints and malformed settings stay unknown", async () => {
  const valid = settingsPlist(`<dict>${rootResult}</dict>`);
  const malformed = [
    valid.slice(0, -8), `${valid}<dict/>`,
    valid.replace("<integer>1</integer>", "<string>1</string>"),
    valid.replace("<integer>1</integer>", "<integer>999</integer>"),
    valid.replace("<array>", "<dict>").replace("</array>", "</dict>"),
    valid.replace(rootResult, `${rootResult}${rootResult}`),
    valid.replace("<key>trustSettings</key>", "<key>other</key>"),
    valid.replace(rootResult, `${rootResult}<key>kSecTrustSettingsAllowedError</key><integer>-67818</integer>`),
    valid.replace(rootResult, `${rootResult}<key>kSecTrustSettingsKeyUsage</key><integer>1</integer>`),
    valid.replace(rootResult, `${rootResult}<key>futureConstraint</key><string>value</string>`),
    valid.replace(rootResult, `${rootResult}<key>kSecTrustSettingsPolicy</key><integer>1</integer>`),
    valid.replace(rootResult, `${rootResult}<key>kSecTrustSettingsPolicy</key><data>invalid!</data>`),
    valid.replace(rootResult, `${rootResult}<key>name</key><string>&unknown;</string>`),
    valid.replace(rootResult, `${rootResult}<key>name</key><string>${"&".repeat(100_000)}</string>`),
    valid.replace("<plist version=\"1.0\">", '<!DOCTYPE plist [<!ENTITY anything "value">]><plist>'),
    `<plist><dict><key>trustList</key><dict><key>${sha1}</key><dict/><key>${sha1}</key><dict/></dict></dict></plist>`,
    "x".repeat(8 * 1024 * 1024 + 1),
    `<plist>${"<array>".repeat(20)}${"</array>".repeat(20)}</plist>`,
  ];
  for (const xml of malformed) {
    expect(await inspectChatgptCaTrust(caPath, exportXml(xml).run, "darwin")).toBe("unknown");
  }
});

test("a fingerprint outside trustList or inside a comment is not a matching trust entry", async () => {
  for (const xml of [
    `<plist><dict><key>trustList</key><dict/><!-- <key>${sha1}</key> --></dict></plist>`,
    `<plist><dict><key>trustList</key><dict/><key>${sha1}</key><dict/></dict></plist>`,
    settingsPlist("", "AB".repeat(20)),
  ]) expect(await inspectChatgptCaTrust(caPath, exportXml(xml).run, "darwin")).toBe("untrusted");
});

test("settings for another certificate do not restrict the current root", async () => {
  const other = `<key>${"AB".repeat(20)}</key><dict><key>trustSettings</key><array><dict>`
    + "<key>kSecTrustSettingsResult</key><integer>3</integer></dict></array></dict>";
  const xml = settingsPlist(`<dict>${sslPolicy}${rootResult}</dict>`).replace("</array></dict>", `</array></dict>${other}`);
  expect(await inspectChatgptCaTrust(caPath, exportXml(xml).run, "darwin")).toBe("trusted");
});

test("a stale trust record requires the same certificate in the login keychain", async () => {
  const xml = settingsPlist("");
  for (const listed of ["", "AB".repeat(20), `${sha1} trailing text`]) {
    expect(await inspectChatgptCaTrust(caPath, exportXml(xml, listed).run, "darwin")).toBe("untrusted");
  }
  for (const code of [1, 2, null]) {
    const f = exportXml(xml);
    const run: SecurityRunner = async args => args[0] === "find-certificate"
      ? { code, stdout: `SHA-1 hash: ${sha1}`, stderr: "" } : f.run(args);
    expect(await inspectChatgptCaTrust(caPath, run, "darwin")).toBe(code === 1 ? "untrusted" : "unknown");
  }
});

test("expired and not-yet-valid roots are rejected without querying the keychain", async () => {
  const ca = createLocalInterceptCa();
  writeFileSync(caPath, ca.certPem);
  const cert = new X509Certificate(ca.certPem);
  const run: SecurityRunner = async () => { throw new Error("must not query OS trust"); };
  for (const now of [Date.parse(cert.validFrom) - 1, Date.parse(cert.validTo)]) {
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try { expect(await inspectChatgptCaTrust(caPath, run, "darwin")).toBe("untrusted"); }
    finally { clock.mockRestore(); }
  }
});

test("non-CA, corrupt-signature and malformed certificates cannot count as trusted", async () => {
  const ca = createLocalInterceptCa();
  const damaged = Buffer.from(new X509Certificate(ca.certPem).raw);
  damaged[damaged.length - 1]! ^= 1;
  const brokenSignature = `-----BEGIN CERTIFICATE-----\n${damaged.toString("base64")}\n-----END CERTIFICATE-----\n`;
  for (const pem of [issueLocalInterceptLeaf(ca, ["chatgpt.com"]).certPem, brokenSignature]) {
    writeFileSync(caPath, pem);
    expect(await inspectChatgptCaTrust(caPath, exporting([certificateSha1(pem)]), "darwin")).toBe("untrusted");
  }
  writeFileSync(caPath, "invalid certificate");
  expect(await inspectChatgptCaTrust(caPath, exporting([sha1]), "darwin")).toBe("unknown");
});

test.skipIf(process.platform === "win32")("printed trust commands preserve shell metacharacters as literal path bytes", async () => {
  const path = "/synthetic/space and 'quote' $(printf SUBSTITUTED) `printf SUBSTITUTED` $HOME.pem";
  // A shell function captures argv; no security command or trust operation runs.
  const child = Bun.spawn(["/bin/sh", "-c", `security() { printf '%s\\0' "$@"; }; ${chatgptCaTrustCommand(path)}`], {
    stdout: "pipe", stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output.split("\0")).toEqual(["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", loginKeychainPath(), path, ""]);
});
