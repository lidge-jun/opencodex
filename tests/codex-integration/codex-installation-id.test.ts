import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { codexInstallationIdForAccount } from "../../src/codex/installation-id";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ocx-installation-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("account HMAC has UUIDv4 layout and a persistent private 32-byte secret", () => {
  const first = codexInstallationIdForAccount("account-a", root);
  expect(first).toMatch(uuid);
  expect(codexInstallationIdForAccount("account-a", root)).toBe(first);
  expect(codexInstallationIdForAccount("account-b", root)).not.toBe(first);
  expect(codexInstallationIdForAccount("account-a", join(root, "other"))).not.toBe(first);
  const path = join(root, "codex-installation-secret");
  const secret = readFileSync(path);
  expect(secret.length).toBe(32);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  const bytes = createHmac("sha256", secret).update("opencodex-codex-installation-id-v1\0account-a").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  expect(first.replaceAll("-", "")).toBe(bytes.toString("hex"));
});

test("a corrupt secret is refused without overwrite or sensitive error details", () => {
  const path = join(root, "codex-installation-secret");
  writeFileSync(path, "bad", { mode: 0o600 });
  expect(() => codexInstallationIdForAccount("private-account", root)).toThrow("Codex installation identity unavailable");
  expect(readFileSync(path, "utf8")).toBe("bad");
});

test("concurrent processes publish one complete secret and retain the same identity", async () => {
  const modulePath = new URL("../../src/codex/installation-id.ts", import.meta.url).href;
  const script = `import { codexInstallationIdForAccount } from ${JSON.stringify(modulePath)}; process.stdout.write(codexInstallationIdForAccount("account-race", process.argv[1]));`;
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", script, root], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async child => ({ id: await new Response(child.stdout).text(), error: await new Response(child.stderr).text(), exit: await child.exited })));
  for (const result of results) { expect(result.exit, result.error).toBe(0); expect(result.error).toBe(""); expect(result.id).toMatch(uuid); }
  expect(new Set(results.map(result => result.id)).size).toBe(1);
  expect(readFileSync(join(root, "codex-installation-secret")).length).toBe(32);
});
