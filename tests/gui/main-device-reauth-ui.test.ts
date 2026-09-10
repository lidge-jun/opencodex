import { describe, expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";

/**
 * #3898 L3 source contracts: the main-card device reauth drives ONLY the
 * dedicated native-main namespace, every shipped locale carries the new copy,
 * and the pool login surface is never touched for __main__.
 */

const LOCALES = ["en", "de", "fr", "ja", "ko", "ru", "tr", "zh", "zh-TW"] as const;
const NEW_KEYS = [
  "codexAuth.mainReauthDevice",
  "codexAuth.mainReauthPending",
  "codexAuth.mainReauthOpen",
  "codexAuth.mainReauthCode",
  "codexAuth.mainReauthCancel",
  "codexAuth.mainReauthFailed",
  "codexAuth.mainReauthSucceeded",
] as const;

describe("main device reauth UI contracts (#3898)", () => {
  test("the hook drives only the dedicated namespace and never the pool login route", async () => {
    const hook = await Bun.file(repoPath("gui/src/components/use-main-device-reauth.ts")).text();
    expect(hook).toContain("/api/codex-auth/main/reauth-device");
    expect(hook).not.toContain(String.fromCharCode(96) + "/api/codex-auth/login" + String.fromCharCode(96));
    expect(hook).not.toContain("/api/codex-auth/login?");
    expect(hook).toContain("https://auth.openai.com/codex/device");
    // No token-shaped fields are ever read off a payload.
    expect(hook).not.toContain("access_token");
    expect(hook).not.toContain("refresh_token");
    expect(hook).not.toContain("id_token");
  });

  test("the main card renders the CTA through the hook, wired by the pool page", async () => {
    const [card, pool] = await Promise.all([
      Bun.file(repoPath("gui/src/components/codex-account-pool-main-card.tsx")).text(),
      Bun.file(repoPath("gui/src/components/CodexAccountPool.tsx")).text(),
    ]);
    expect(card).toContain("mainReauth");
    expect(card).toContain("codexAuth.mainReauthDevice");
    expect(card).toContain("codexAuth.mainTokenExpired");
    expect(pool).toContain("useMainDeviceReauth");
    expect(pool).toContain("mainReauth={mainReauth}");
    // The pool modal/add path stays untouched: no reauthAccountId=__main__ anywhere.
    expect(pool).not.toContain('reauthAccountId="__main__"');
  });

  test("every shipped locale carries the new copy", async () => {
    for (const locale of LOCALES) {
      const text = await Bun.file(repoPath("gui/src/i18n/" + locale + ".ts")).text();
      for (const key of NEW_KEYS) {
        expect(text, locale + " missing " + key).toContain(String.fromCharCode(34) + key + String.fromCharCode(34) + ": ");
      }
      expect(text, locale + " mainTokenExpired").toContain("codexAuth.mainTokenExpired");
    }
  });
});
