import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hubSessionFilePath, parseHubCredential, readHubCredential, removeHubCredential, writeHubCredential,
} from "../../src/client/hub-session";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const session = {
  kind: "session" as const,
  token: `ocx_session_${"s".repeat(43)}`,
  csrfToken: "c".repeat(43),
  browserOrigin: "http://localhost:10100",
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
  test("round-trips a session at 0600 and removes it", () => {
    expect(readHubCredential()).toEqual({ kind: "absent" });
    writeHubCredential(session);
    expect(readHubCredential()).toEqual({ kind: "present", credential: session });
    expect(statSync(hubSessionFilePath()).mode & 0o077).toBe(0);
    removeHubCredential();
    expect(readHubCredential()).toEqual({ kind: "absent" });
  });

  test("round-trips an admin token without inventing a browser origin", () => {
    const admin = { kind: "admin" as const, token: `ocx_admin_${"a".repeat(43)}` };
    writeHubCredential(admin);
    expect(readHubCredential()).toEqual({ kind: "present", credential: admin });
  });

  test("reports a malformed file as unsafe rather than absent", () => {
    writeFileSync(hubSessionFilePath(), JSON.stringify({ kind: "session", token: "ocx_session_short" }));
    expect(readHubCredential().kind).toBe("unsafe");
  });

  test("refuses shapes a later reader would misread", () => {
    for (const value of [
      null, [], "x", { ...session, extra: 1 }, { ...session, browserOrigin: "http://localhost:10100/path" },
      { ...session, csrfToken: "short" }, { kind: "admin", token: "not-an-admin-token" },
    ]) expect(parseHubCredential(value)).toBeNull();
  });
});
