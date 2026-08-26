import { describe, expect, test } from "bun:test";
import { shouldShowLoginHint } from "../gui/src/components/provider-catalog/login-hint-visibility";

/**
 * A first-time provider add is the one moment the operator has no other way in.
 * Once a provider exists its workspace panel shows the authorization URL with a
 * copy button; during the first login no panel is mounted, so the hint has to
 * render inside the add-provider dialog or it renders nowhere — which is what
 * used to happen: the URL was fetched, stored in page state, and never drawn.
 *
 * The predicate is extracted from the JSX so the leak case is testable without
 * a DOM. That case is not hypothetical: the page holds ONE hint for whichever
 * login is in flight, and the Accounts tab renders many rows from it.
 */

const hint = { provider: "xai", url: "https://accounts.x.ai/oauth/authorize?x=1", deviceCode: "WDJB-MJHT" };
const oauthRow = (id: string) => ({ id, kind: "oauth" as const });

describe("first-add login hint visibility", () => {
  test("renders on the row whose login is in flight", () => {
    expect(shouldShowLoginHint(oauthRow("xai"), "xai", hint)).toBe(true);
  });

  test("never renders another provider's authorization URL", () => {
    // The busy row is anthropic, but the hint belongs to xai: a late or
    // superseded response must not paint under the wrong provider.
    expect(shouldShowLoginHint(oauthRow("anthropic"), "anthropic", hint)).toBe(false);
    // And xai's own row stays quiet while a different provider is the busy one.
    expect(shouldShowLoginHint(oauthRow("xai"), "anthropic", hint)).toBe(false);
  });

  test("renders nothing when no login is in flight", () => {
    expect(shouldShowLoginHint(oauthRow("xai"), null, hint)).toBe(false);
    expect(shouldShowLoginHint(oauthRow("xai"), "xai", null)).toBe(false);
    expect(shouldShowLoginHint(oauthRow("xai"), "xai", undefined)).toBe(false);
  });

  test("a Codex row never shows an OAuth hint, even while the page is busy on it", () => {
    // A codex row opens the Codex account modal instead of /api/oauth, and the
    // page marks itself busy while enabling the OpenAI provider. A stale hint
    // must not paint an authorization URL onto a row whose flow is elsewhere.
    const stale = { provider: "openai", url: "https://auth.openai.com/authorize?x=1" };
    expect(shouldShowLoginHint({ id: "openai", kind: "codex" }, "openai", stale)).toBe(false);
    // Key rows have no login button at all.
    expect(shouldShowLoginHint({ id: "xai", kind: "key" }, "xai", hint)).toBe(false);
  });
});
