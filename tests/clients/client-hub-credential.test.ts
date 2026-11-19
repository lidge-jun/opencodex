import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hubSessionFilePath, parseHubCredential, readHubCredential, removeHubCredential, writeHubCredential,
} from "../../src/client/hub-session";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const session = {
  kind: "relay" as const,
  token: `ocx_hub_relay_${"s".repeat(43)}`,
};

const owner = {
  managementUrl: "https://hub.example.test",
  apiKeyId: "fixture-key",
  tokenFingerprint: "a".repeat(64),
  connectedAt: "2026-08-28T00:00:00.000Z",
};

let root = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-hub-credential-"));
  process.env.OPENCODEX_HOME = root;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (root) removeTreeWithRetry(root);
});

describe("stored hub management credential", () => {
  test("round-trips a relay credential at 0600 and removes it", () => {
    expect(readHubCredential(owner)).toEqual({ kind: "absent" });
    writeHubCredential(session, owner);
    expect(readHubCredential(owner)).toEqual({ kind: "present", credential: session });
    if (process.platform !== "win32") expect(statSync(hubSessionFilePath()).mode & 0o777).toBe(0o600);
    removeHubCredential();
    expect(readHubCredential(owner)).toEqual({ kind: "absent" });
  });

  test("refuses to persist or admit the hub root credential", () => {
    const admin = { kind: "admin", token: `ocx_admin_${"a".repeat(43)}` };
    expect(() => writeHubCredential(admin as unknown as typeof session, owner)).toThrow();
    writeFileSync(hubSessionFilePath(), JSON.stringify(admin), { mode: 0o600 });
    expect(readHubCredential(owner).kind).toBe("unsafe");
  });

  test.each([
    { managementUrl: "https://other.example.test" },
    { apiKeyId: "replacement-key" },
    { tokenFingerprint: "b".repeat(64) },
    { connectedAt: "2026-08-29T00:00:00.000Z" },
  ])("refuses a session from another connection (%j)", change => {
    writeHubCredential(session, owner);
    expect(readHubCredential({ ...owner, ...change }).kind).toBe("unsafe");
  });

  test("refuses a session file whose POSIX permissions allow another user to read it", () => {
    if (process.platform === "win32") return;
    writeHubCredential(session, owner);
    chmodSync(hubSessionFilePath(), 0o644);
    expect(readHubCredential(owner).kind).toBe("unsafe");
  });

  test("reports a malformed file as unsafe rather than absent", () => {
    writeFileSync(hubSessionFilePath(), JSON.stringify({ kind: "session", token: "ocx_session_short" }));
    expect(readHubCredential(owner).kind).toBe("unsafe");
  });

  test("refuses shapes a later reader would misread", () => {
    for (const value of [
      null, [], "x", { ...session, extra: 1 }, { ...session, token: "short" },
      { kind: "admin", token: "not-an-admin-token" },
      { kind: "session", token: `ocx_session_${"s".repeat(43)}`, csrfToken: "c".repeat(43), browserOrigin: "http://localhost:10100" },
    ]) expect(parseHubCredential(value)).toBeNull();
  });
});
