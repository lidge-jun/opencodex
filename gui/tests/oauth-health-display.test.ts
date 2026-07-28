import { describe, expect, mock, test } from "bun:test";
import {
  copyTextToClipboard,
  doctorCopyButtonLabel,
  formatOAuthHealthLabel,
  formatOAuthHealthSummary,
  accountNeedsReauth,
  oauthHealthBadgeClass,
  oauthHealthBadgeTone,
  oauthHealthIsCooldown,
  oauthHealthShowsDoctor,
  oauthHealthShowsReauth,
} from "../src/oauth-health-display";
import { displayAccountId, maskAccountId } from "../src/lib/privacy";
import type { TFn } from "../src/i18n";

const t: TFn = ((key: string, vars?: Record<string, string | number>) => {
  if (!vars) return key;
  return Object.entries(vars).reduce(
    (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
    key,
  );
}) as TFn;

describe("oauth health badge helpers", () => {
  test("maps statuses to badge tones and classes", () => {
    expect(oauthHealthBadgeTone("healthy")).toBe("ok");
    expect(oauthHealthBadgeTone("cooldown")).toBe("muted");
    expect(oauthHealthBadgeTone("reauth_required")).toBe("warn");
    expect(oauthHealthBadgeTone("warning")).toBe("warn");
    expect(oauthHealthBadgeClass("healthy")).toBe("badge badge-green");
    expect(oauthHealthBadgeClass("reauth_required")).toBe("badge badge-amber");
    expect(oauthHealthBadgeClass("cooldown")).toBe("badge badge-muted");
  });

  test("action gates: reauth and doctor, not during cooldown probe", () => {
    expect(oauthHealthShowsReauth("reauth_required")).toBe(true);
    expect(oauthHealthShowsReauth("cooldown")).toBe(false);
    expect(oauthHealthShowsDoctor("warning")).toBe(true);
    expect(oauthHealthShowsDoctor("reauth_required")).toBe(true);
    expect(oauthHealthShowsDoctor("cooldown")).toBe(false);
    expect(oauthHealthIsCooldown("cooldown")).toBe(true);
    expect(oauthHealthIsCooldown("healthy")).toBe(false);
  });

  test("accountNeedsReauth combines legacy flag with health-only reauth", () => {
    expect(accountNeedsReauth(undefined)).toBe(false);
    expect(accountNeedsReauth({ needsReauth: true })).toBe(true);
    expect(accountNeedsReauth({ health: { status: "reauth_required" } })).toBe(true);
    expect(accountNeedsReauth({ needsReauth: false, health: { status: "healthy" } })).toBe(false);
    expect(accountNeedsReauth({ health: { status: "cooldown" } })).toBe(false);
    expect(accountNeedsReauth({ health: { status: "warning" } })).toBe(false);
  });

  test("localizes labels and summaries from structured health", () => {
    expect(formatOAuthHealthLabel(t, { status: "healthy" })).toBeNull();
    expect(formatOAuthHealthLabel(t, { status: "cooldown", reason: "rate_limit", until: "2026-07-26T00:00:00.000Z" }))
      .toBe("pws.healthLabel.rateLimited");
    expect(formatOAuthHealthLabel(t, { status: "cooldown", reason: "quota", until: "2026-07-26T00:00:00.000Z" }))
      .toBe("pws.healthLabel.quotaLimited");
    expect(formatOAuthHealthLabel(t, { status: "warning", reason: "refresh_conflict" }))
      .toBe("pws.healthLabel.credentialConflict");
    expect(formatOAuthHealthSummary(t, "xai", "acct_abcd1234", { status: "reauth_required", reason: "refresh_failed" }))
      .toBe("pws.healthSummary.reauthRequired");
    expect(formatOAuthHealthSummary(t, "xai", "acct_abcd1234", { status: "warning", reason: "stale_credentials" }))
      .toContain("pws.healthSummary.staleCredentials");
  });

  // Scope resolution now belongs to useCopyFeedback; the label only maps an outcome.
  test("doctorCopyButtonLabel reflects the copy outcome", () => {
    expect(doctorCopyButtonLabel(t, null)).toBe("pws.copyDoctor");
    expect(doctorCopyButtonLabel(t, undefined)).toBe("pws.copyDoctor");
    expect(doctorCopyButtonLabel(t, "copied")).toBe("pws.doctorCopied");
    expect(doctorCopyButtonLabel(t, "unavailable")).toBe("pws.doctorCopyUnavailable");
  });

  test("copyTextToClipboard returns false when Clipboard API is missing", async () => {
    const hadClipboard = "clipboard" in navigator;
    const original = hadClipboard ? navigator.clipboard : undefined;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      expect(await copyTextToClipboard("ocx doctor")).toBe(false);
    } finally {
      if (hadClipboard) {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
      } else {
        // @ts-expect-error restore missing clipboard
        delete (navigator as { clipboard?: Clipboard }).clipboard;
      }
    }
  });

  test("copyTextToClipboard uses writeText when available", async () => {
    const hadClipboard = "clipboard" in navigator;
    const original = hadClipboard ? navigator.clipboard : undefined;
    const writeText = mock(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      expect(await copyTextToClipboard("ocx doctor")).toBe(true);
      expect(writeText).toHaveBeenCalledWith("ocx doctor");
    } finally {
      if (hadClipboard) {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
      } else {
        // @ts-expect-error restore missing clipboard
        delete (navigator as { clipboard?: Clipboard }).clipboard;
      }
    }
  });

  test("maskAccountId never returns the full raw id for long values", () => {
    const raw = "aaaa1111bbbb2222";
    const masked = maskAccountId(raw);
    expect(masked).toBe("account-…2222");
    expect(masked).not.toBe(raw);
    expect(masked!.includes(raw)).toBe(false);
  });

  test("displayAccountId never falls back to the raw id", () => {
    const raw = "acct_raw_should_not_leak";
    expect(displayAccountId(raw)).toBe("account-…leak");
    expect(displayAccountId(raw)).not.toBe(raw);
    expect(displayAccountId(null)).toBe("account-…");
    expect(displayAccountId("")).toBe("account-…");
    expect(displayAccountId("   ")).toBe("account-…");
  });
});
