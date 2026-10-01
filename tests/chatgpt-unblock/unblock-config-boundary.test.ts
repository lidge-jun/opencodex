import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  validateConfigCandidate,
} from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * The write-boundary regression for the chatgptDesktop block. The read path degrades a
 * malformed block to absent (`.catch(undefined)` in the schema), which is right for a
 * hand-edited file — but the same silence at the write boundary would accept
 * `{ unblockSend: true, port: 65536 }`, report success, and persist a config whose
 * integration is silently gone. The boundary must reject instead, naming the field.
 */

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-chatgpt-desktop-config-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function candidate(chatgptDesktop: unknown) {
  return {
    ...getDefaultConfig(),
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
        note: "keep me",
      },
    },
    ...(chatgptDesktop === undefined ? {} : { chatgptDesktop }),
  };
}

test("validateConfigCandidate rejects an out-of-range port naming the field", () => {
  const result = validateConfigCandidate(candidate({ unblockSend: true, port: 65536 }));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error).toContain("schema_invalid: chatgptDesktop.port");
});

test("validateConfigCandidate rejects a typo'd key and a wrong-typed flag", () => {
  // .strict(): a typo'd key must surface as a rejected write rather than a silently
  // ignored key that leaves the operator believing they enabled something.
  const typo = validateConfigCandidate(candidate({ unblockSend: true, unblocksend: true }));
  expect(typo.ok).toBe(false);

  const wrongType = validateConfigCandidate(candidate({ unblockSend: "yes" }));
  expect(wrongType.ok).toBe(false);
});

test("validateConfigCandidate accepts a well-formed block and its absence", () => {
  expect(validateConfigCandidate(candidate({ unblockSend: true, pacFallback: true, appServerShim: true, port: 10300 })).ok).toBe(true);
  expect(validateConfigCandidate(candidate({ unblockSend: true, appServerShim: "yes" })).ok).toBe(false);
  expect(validateConfigCandidate(candidate({})).ok).toBe(true);
  expect(validateConfigCandidate(candidate(undefined)).ok).toBe(true);
});

test("a rejected write leaves the persisted config unchanged", () => {
  // Seed the on-disk config with a valid block, attempt the save a caller would make
  // with an invalid one, and prove the boundary verdict is what stands between them:
  // the file still carries the previous valid block afterwards.
  writeFileSync(getConfigPath(), JSON.stringify(candidate({ unblockSend: true })), "utf8");

  const rejected = validateConfigCandidate(candidate({ unblockSend: true, port: 65536 }));
  expect(rejected.ok).toBe(false);
  // A caller that persists only on ok never rewrote the file.
  const loaded = loadConfig();
  expect(loaded.chatgptDesktop).toEqual({ unblockSend: true });
  expect(loaded.providers.xai.note).toBe("keep me");

  const onDisk = JSON.parse(readFileSync(getConfigPath(), "utf8")) as { chatgptDesktop?: unknown };
  expect(onDisk.chatgptDesktop).toEqual({ unblockSend: true });
});

test("load drops only a malformed block and preserves the rest of the config", () => {
  // The read path keeps its degrade-to-off behavior: a hand-edited typo costs the
  // operator the desktop integration, never their providers.
  writeFileSync(getConfigPath(), JSON.stringify(candidate({ unblockSend: true, port: 99999 })), "utf8");

  const loaded = loadConfig();
  expect(loaded.chatgptDesktop).toBeUndefined();
  expect(loaded.providers.xai.note).toBe("keep me");
});
