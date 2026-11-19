import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig } from "../../src/config";
import { codexWsIncrementalUploadEnabled } from "../../src/config/codex-ws-incremental-setting";
import { codexWsReuseAcrossTurnsEnabled } from "../../src/config/codex-ws-reuse-setting";
import { reconcileLiveStateStores, setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type WsFlags = Pick<OcxConfig, "codexWsReuseAcrossTurns" | "codexWsIncrementalUpload">;
const flags = () => ({ reuse: codexWsReuseAcrossTurnsEnabled(), incremental: codexWsIncrementalUploadEnabled() });

afterAll(() => { setLiveStateStoreConfig(getDefaultConfig()); });

test.each([
  { label: "disk enables both while live has both off", live: {}, disk: { codexWsReuseAcrossTurns: true, codexWsIncrementalUpload: true },
    expected: { reuse: false, incremental: false } },
  { label: "disk disables both while live has both on", live: { codexWsReuseAcrossTurns: true, codexWsIncrementalUpload: true }, disk: {},
    expected: { reuse: true, incremental: true } },
  { label: "disk drops reuse that live incremental implies", live: { codexWsIncrementalUpload: true }, disk: { codexWsReuseAcrossTurns: false },
    expected: { reuse: true, incremental: true } },
  { label: "disk enables reuse while live keeps it off", live: { codexWsReuseAcrossTurns: false }, disk: { codexWsReuseAcrossTurns: true },
    expected: { reuse: false, incremental: false } },
] satisfies { label: string; live: WsFlags; disk: WsFlags; expected: ReturnType<typeof flags> }[])(
  "detached loadConfig leaves live WS flags alone when $label", ({ live, disk, expected }) => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-codex-ws-live-bind-"));
    process.env.OPENCODEX_HOME = home;
    try {
      const liveConfig = { ...getDefaultConfig(), ...live };
      setLiveStateStoreConfig(liveConfig);
      expect(flags()).toEqual(expected);
      writeFileSync(getConfigPath(), JSON.stringify({ ...getDefaultConfig(), ...disk }), "utf8");
      const detached = loadConfig();
      expect(detached.codexWsReuseAcrossTurns ?? false).toBe(disk.codexWsReuseAcrossTurns ?? false);
      expect(detached.codexWsIncrementalUpload ?? false).toBe(disk.codexWsIncrementalUpload ?? false);
      expect(flags()).toEqual(expected);
      reconcileLiveStateStores();
      expect(flags()).toEqual(expected);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });
