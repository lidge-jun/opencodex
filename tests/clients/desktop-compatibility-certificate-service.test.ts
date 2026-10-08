import { describe, expect, test } from "bun:test";
import { createDesktopCertificateService } from "../../src/codex/desktop-compatibility/certificate-service";
import type { DesktopAuthorityInspection, StoredDesktopAuthority } from "../../src/codex/desktop-compatibility/certificate-store";

const fingerprint = "A".repeat(64);
const authority = { fingerprint } as StoredDesktopAuthority;
function fixture() {
  const calls: string[] = [];
  let stored: DesktopAuthorityInspection = { status: "missing" }, trusted = false;
  let appRunning: boolean | null = false, removalResult: "not-trusted" | "unknown" | "trusted" = "not-trusted";
  const present = () => { stored = { status: "present", fingerprint, certPem: "public-fixture", expiresAt: 123456, renewalDue: false }; };
  const service = createDesktopCertificateService("fixture-only", { platform: "win32",
    inspect: () => { calls.push("inspect"); return stored; },
    prepare: async () => { calls.push("prepare"); present(); return authority; },
    load: async expired => { calls.push(expired ? "load-removal" : "load"); return authority; },
    renew: async () => { calls.push("renew"); stored = { status: "present", fingerprint: "B".repeat(64), certPem: "renewed-public-fixture", expiresAt: 234567, renewalDue: false }; return { fingerprint: "B".repeat(64) } as StoredDesktopAuthority; },
    readTrust: async () => { calls.push("read-trust"); return trusted ? "trusted" : "not-trusted"; },
    changeTrust: async (_value, action) => { calls.push(action); trusted = action === "trust"; return trusted ? "trusted" : removalResult; },
    appRunning: async () => appRunning,
  });
  return { calls, service, present, setAppRunning: (value: boolean | null) => { appRunning = value; }, setRemovalResult: (value: typeof removalResult) => { removalResult = value; }, setStored: (value: DesktopAuthorityInspection) => { stored = value; } };
}

describe("compatibility certificate setup service", () => {
  test("legacy-purpose status stays renewal-required even when its old OS root is trusted", async () => {
    const io = fixture(); io.present(); await io.service.trust(fingerprint);
    io.setStored({ status: "renewal-required", fingerprint, certPem: "public-fixture", expiresAt: 123456, renewalDue: false });
    expect((await io.service.status()).state).toBe("renewal-required");
    expect((await io.service.renew(fingerprint)).state).toBe("prepared");
    expect(io.calls).toContain("load-removal");
  });

  test("renewal verifies removal before replacement and leaves the new root untrusted", async () => {
    const io = fixture(); io.present();
    const result = await io.service.renew(fingerprint);
    expect(result).toMatchObject({ state: "prepared", fingerprint: "B".repeat(64) });
    expect(io.calls.indexOf("remove")).toBeLessThan(io.calls.indexOf("renew"));
    expect(io.calls).toContain("load-removal"); expect(io.calls).not.toContain("trust");
    expect(io.calls).not.toContain("prepare");
  });
  test("renewal never loses an old trust identity after refusal, uncertainty or a running app", async () => {
    for (const result of ["unknown", "trusted"] as const) {
      const io = fixture(); io.present(); io.setRemovalResult(result);
      await expect(io.service.renew(fingerprint)).rejects.toMatchObject({ code: result === "unknown" ? "trust_unknown" : "trust_not_applied" });
      expect(io.calls).not.toContain("renew");
    }
    const io = fixture(); io.present(); io.setAppRunning(true);
    await expect(io.service.renew(fingerprint)).rejects.toMatchObject({ code: "app_running" });
    expect(io.calls).not.toContain("remove"); expect(io.calls).not.toContain("renew");
  });

  test("status and unsupported hosts never create a key or inspect trust unnecessarily", async () => {
    const io = fixture(); expect((await io.service.status()).state).toBe("missing"); expect(io.calls).toEqual(["inspect"]);
    const disabled = createDesktopCertificateService("unused", { platform: "linux", inspect: () => { throw new Error("must not run"); } });
    expect(await disabled.status()).toEqual({ supported: false, state: "missing", busy: null });
    await expect(disabled.prepare()).rejects.toMatchObject({ code: "unsupported" });
  });
  test("prepare does not register trust and trust loads only an already prepared key", async () => {
    const io = fixture();
    expect((await io.service.prepare()).state).toBe("prepared"); expect(io.calls).not.toContain("trust");
    io.calls.length = 0;
    expect((await io.service.trust(fingerprint)).state).toBe("trusted");
    expect(io.calls).toContain("load"); expect(io.calls).not.toContain("prepare");
  });
  test("missing or changed certificates cannot silently generate replacements during trust", async () => {
    const io = fixture();
    await expect(io.service.trust(fingerprint)).rejects.toMatchObject({ code: "not_prepared" });
    io.present(); await expect(io.service.trust("B".repeat(64))).rejects.toMatchObject({ code: "fingerprint_changed" });
    expect(io.calls).not.toContain("prepare"); expect(io.calls).not.toContain("trust");
  });
  test("removal waits until the app is absent and uses the removal-only existing-key load", async () => {
    const io = fixture(); io.present(); io.setAppRunning(true);
    await expect(io.service.removeTrust(fingerprint)).rejects.toMatchObject({ code: "app_running" });
    expect(io.calls).not.toContain("remove"); io.setAppRunning(false);
    expect((await io.service.removeTrust(fingerprint)).state).toBe("prepared");
    expect(io.calls).toContain("load-removal"); expect(io.calls).not.toContain("prepare");
  });
  test("the public status never includes the certificate body or private-key object", async () => {
    const io = fixture(); io.present();
    const json = JSON.stringify(await io.service.status());
    expect(json).not.toContain("certPem"); expect(json).not.toContain("public-fixture"); expect(json).not.toContain("authority");
  });
  test("unknown app state is reported distinctly and cannot remove trust", async () => {
    const io = fixture(); io.present(); io.setAppRunning(null);
    await expect(io.service.removeTrust(fingerprint)).rejects.toMatchObject({ code: "app_state_unknown" });
    expect(io.calls).not.toContain("remove"); expect(io.calls).not.toContain("load-removal");
  });
});
