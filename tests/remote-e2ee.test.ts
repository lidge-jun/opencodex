import { expect, test } from "bun:test";
import {
  createRemoteE2eeProfile,
  rewrapRemoteE2eeProfile,
  unlockRemoteE2eeProfile,
} from "../src/remote/e2ee";

test("remote vault stays decryptable across a password rewrap without reusing auth material", async () => {
  const initial = await createRemoteE2eeProfile("correct horse battery staple", "github:186453546");
  const unlocked = await unlockRemoteE2eeProfile("correct horse battery staple", "github:186453546", initial.envelope);
  expect(Buffer.from(unlocked.vault.vaultKey, "base64url")).toHaveLength(32);
  expect(unlocked.authSecret).toBe(initial.authSecret);

  const changed = await rewrapRemoteE2eeProfile(
    "correct horse battery staple",
    "new correct horse battery staple",
    "github:186453546",
    initial.envelope,
  );
  expect(changed.oldAuthSecret).toBe(initial.authSecret);
  expect(changed.newAuthSecret).not.toBe(initial.authSecret);
  expect(changed.envelope.ciphertext).not.toBe(initial.envelope.ciphertext);
  const after = await unlockRemoteE2eeProfile(
    "new correct horse battery staple",
    "github:186453546",
    changed.envelope,
  );
  expect(after.vault.vaultKey).toBe(unlocked.vault.vaultKey);
}, 60_000);

test("remote vault rejects a wrong password and a different account binding", async () => {
  const initial = await createRemoteE2eeProfile("correct horse battery staple", "github:186453546");
  await expect(unlockRemoteE2eeProfile("totally incorrect password", "github:186453546", initial.envelope)).rejects.toThrow();
  await expect(unlockRemoteE2eeProfile("correct horse battery staple", "github:999999", initial.envelope)).rejects.toThrow();
}, 60_000);
