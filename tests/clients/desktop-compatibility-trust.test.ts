import { describe, expect, test } from "bun:test";
import { randomUUID, X509Certificate } from "node:crypto";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import type { StoredDesktopAuthority } from "../../src/codex/desktop-compatibility/certificate-store";
import { createWindowsCertificateTrust, inspectWindowsCertificateTrust, type DesktopCertificateTrust, type TrustOperation } from "../../src/codex/desktop-compatibility/windows-certificate-trust";

function fixture(serverAuthOnly = true): StoredDesktopAuthority {
  const commonName = `OpenCodex Codex Desktop ${randomUUID()}`;
  const authority = createCertificateAuthority({ commonName, validityDays: 1, permittedDnsNames: ["chatgpt.com"], excludeAllIpAddresses: true, serverAuthOnly });
  const certificate = new X509Certificate(authority.certPem);
  return { authority, commonName, fingerprint: certificate.fingerprint256.replaceAll(":", ""), expiresAt: Date.parse(certificate.validTo), renewalDue: true, reused: false };
}

describe("exact Windows compatibility certificate trust", () => {
  test("legacy purpose refuses trust before an OS write but allows exact removal", async () => {
    const value = fixture(false), calls: TrustOperation[] = []; let state: DesktopCertificateTrust = "trusted";
    const controller = createWindowsCertificateTrust(value, value.fingerprint, async operation => {
      calls.push(operation); if (operation === "remove") state = "not-trusted"; return state;
    });
    await expect(controller.trust()).rejects.toThrow("desktop_compatibility_authority_renewal_required");
    expect(calls).toHaveLength(0);
    expect(await controller.remove()).toBe("not-trusted");
    expect(calls).toEqual(["inspect", "remove", "inspect"]);
  });

  test("repeated trust and removal do not repeat OS mutations", async () => {
    const value = fixture(), calls: TrustOperation[] = []; let state: DesktopCertificateTrust = "not-trusted";
    const controller = createWindowsCertificateTrust(value, value.fingerprint, async (operation, publicDer, fingerprint) => {
      calls.push(operation); expect(fingerprint).toBe(value.fingerprint);
      expect(Buffer.from(publicDer, "base64")).toEqual(new X509Certificate(value.authority.certPem).raw);
      if (operation === "trust") state = "trusted";
      if (operation === "remove") state = "not-trusted";
      return state;
    });
    expect(await controller.trust()).toBe("trusted"); expect(await controller.trust()).toBe("trusted");
    expect(await controller.remove()).toBe("not-trusted"); expect(await controller.remove()).toBe("not-trusted");
    expect(calls.filter(call => call === "trust")).toHaveLength(1);
    expect(calls.filter(call => call === "remove")).toHaveLength(1);
  });

  test("an uncertain command result is settled by store readback, not a second mutation", async () => {
    const value = fixture(), calls: TrustOperation[] = []; let state: DesktopCertificateTrust = "not-trusted";
    const controller = createWindowsCertificateTrust(value, value.fingerprint, async operation => {
      calls.push(operation);
      if (operation === "trust") { state = "trusted"; throw new Error("lost acknowledgement"); }
      return state;
    });
    expect(await controller.trust()).toBe("trusted");
    expect(calls).toEqual(["inspect", "trust", "inspect"]);
  });

  test("unknown trust state never authorizes a write", async () => {
    const value = fixture(), calls: TrustOperation[] = [];
    const controller = createWindowsCertificateTrust(value, value.fingerprint, async operation => { calls.push(operation); return "unknown"; });
    expect(await controller.trust()).toBe("unknown"); expect(await controller.remove()).toBe("unknown");
    expect(calls).toEqual(["inspect", "inspect"]);
  });

  test("a stale fingerprint or an unrelated private key is refused before any OS request", () => {
    const value = fixture(), other = fixture();
    expect(() => createWindowsCertificateTrust(value, other.fingerprint)).toThrow("desktop_compatibility_certificate_mismatch");
    expect(() => createWindowsCertificateTrust({ ...value, authority: { ...value.authority, privateKey: other.authority.privateKey } }, value.fingerprint))
      .toThrow("desktop_compatibility_certificate_mismatch");
  });

  test("concurrent mutations are not queued into duplicate certificate prompts", async () => {
    const value = fixture(); let release!: (state: DesktopCertificateTrust) => void;
    let reads = 0;
    const controller = createWindowsCertificateTrust(value, value.fingerprint, async () => ++reads === 1
      ? await new Promise<DesktopCertificateTrust>(resolve => { release = resolve; }) : "trusted");
    const first = controller.trust();
    await expect(controller.remove()).rejects.toThrow("desktop_compatibility_trust_busy");
    release("trusted"); expect(await first).toBe("trusted");
  });

  test.skipIf(process.platform !== "win32")("real CurrentUser Root inspection remains read-only for an unregistered synthetic CA", async () => {
    const value = fixture();
    expect(await inspectWindowsCertificateTrust(value.authority.certPem, value.fingerprint)).toBe("not-trusted");
  }, 15_000);
});
