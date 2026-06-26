import { describe, expect, test } from "bun:test";
import { buildInitProviders } from "../src/init";
import {
  CURSOR_OAUTH_DISABLED_MESSAGE,
  CursorOAuthDisabledError,
  loginCursor,
  refreshCursorToken,
} from "../src/oauth/cursor";
import { isOAuthProvider, listOAuthProviders } from "../src/oauth/index";
import { deriveProviderPresets } from "../src/providers/derive";

async function expectCursorDisabled(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CursorOAuthDisabledError);
    expect((err as CursorOAuthDisabledError).code).toBe("cursor_oauth_disabled");
    expect((err as Error).message).toBe(CURSOR_OAUTH_DISABLED_MESSAGE);
    return;
  }
  throw new Error("Expected CursorOAuthDisabledError");
}

describe("Cursor disabled OAuth shell", () => {
  test("login and refresh fail closed", async () => {
    await expectCursorDisabled(loginCursor({}));
    await expectCursorDisabled(refreshCursorToken("refresh-token"));
  });

  test("cursor is not exposed through OAuth provider routing yet", () => {
    expect(isOAuthProvider("cursor")).toBe(false);
    expect(listOAuthProviders()).not.toContain("cursor");
  });

  test("cursor is exposed through init and dashboard preset as an experimental local provider", () => {
    const cursor = buildInitProviders().find(provider => provider.id === "cursor");

    expect(cursor).toMatchObject({
      id: "cursor",
      adapter: "cursor",
      kind: "local",
      defaultModel: "auto",
    });
    expect(cursor?.label.toLowerCase()).toContain("experimental");
    expect(deriveProviderPresets().find(preset => preset.id === "cursor")).toMatchObject({
      id: "cursor",
      adapter: "cursor",
      auth: "local",
      defaultModel: "auto",
    });
  });

  test("disabled shell has no live transport or local file execution path", async () => {
    const source = await Bun.file("src/oauth/cursor.ts").text();

    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("node:fs");
    expect(source).not.toContain("node:http2");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("spawn(");
    expect(source).not.toContain("exec(");
  });
});
