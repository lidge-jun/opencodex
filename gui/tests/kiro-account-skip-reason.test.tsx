import { expect, test } from "bun:test";
import { kiroSkipReasonKey, kiroVerificationLink, parseKiroDeviceView } from "../src/kiro-device-login-helpers";

test("Kiro exclusion labels appear only for eligible rows and avoid duplicate health badges", () => {
  expect(kiroSkipReasonKey({ autoSelectable: false, skipReason: "suspended" }, "kiro")).toBe("kiroSelection.suspended");
  expect(kiroSkipReasonKey({ autoSelectable: false, skipReason: "quota_exhausted" }, "kiro")).toBe("kiroSelection.quotaExhausted");
  expect(kiroSkipReasonKey({ autoSelectable: false, skipReason: "needs_reauth" }, "kiro")).toBeNull();
  expect(kiroSkipReasonKey({ autoSelectable: false, skipReason: "paused" }, "kiro")).toBeNull();
  expect(kiroSkipReasonKey({ autoSelectable: false, skipReason: "cooldown", health: { status: "cooldown" } }, "kiro")).toBeNull();
  expect(kiroSkipReasonKey({ autoSelectable: false, skipReason: "cooldown" }, "kiro")).toBe("kiroSelection.cooldown");
  expect(kiroSkipReasonKey({ autoSelectable: false, skipReason: "future_reason" }, "kiro")).toBe("kiroSelection.generic");
  expect(kiroSkipReasonKey({ autoSelectable: true, skipReason: "suspended" }, "kiro")).toBeNull();
  expect(kiroSkipReasonKey({ autoSelectable: false, skipReason: "suspended" }, "claude")).toBeNull();
});

test("verification links accept only exact Builder ID and Kiro-owned https hosts", () => {
  expect(kiroVerificationLink("https://device.sso.us-east-1.amazonaws.com/start")).toBe("https://device.sso.us-east-1.amazonaws.com/start");
  expect(kiroVerificationLink("https://kiro.dev/verify")).toBe("https://kiro.dev/verify");
  expect(kiroVerificationLink("https://auth.kiro.dev/verify")).toBe("https://auth.kiro.dev/verify");
  for (const url of [
    "https://evil.s3.amazonaws.com/", "https://x.awsapps.com/", "https://kiro.dev.evil.com/",
    "https://evilkiro.dev/", ["https://user", "kiro.dev/"].join("@"), "https://kiro.dev:444/",
    "https://kiro.dev:443/", "http://kiro.dev/", "https://kiro.dev/\nattack", "javascript:alert(1)",
  ]) expect(kiroVerificationLink(url)).toBeNull();
});

test("device parser ignores unknown fields and keeps only public view", () => {
  expect(parseKiroDeviceView({ flowId: "f", method: "github", state: "pending", token: "secret", warning: "alien" }))
    .toEqual({ flowId: "f", method: "github", state: "pending" });
});
