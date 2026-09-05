import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AtomicWriteSecretResidualError,
  getConfigPath,
  initializePersistedConfigIfMissing,
  loadConfig,
  setPersistedConfigInitializationBeforePublishForTests,
} from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let previous: string | undefined;
const config = (port = 10100): OcxConfig => ({ port, providers: {}, defaultProvider: "openai" });

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(import.meta.dir, ".tmp-config-initialize-"));
  process.env.OPENCODEX_HOME = root;
});

afterEach(() => {
  setPersistedConfigInitializationBeforePublishForTests(null);
  if (previous === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(root);
});

test("creates a missing config exclusively", () => {
  expect(initializePersistedConfigIfMissing(config(12000))).toBe("created");
  expect(loadConfig().port).toBe(12000);
  expect(initializePersistedConfigIfMissing(config(13000))).toBe("exists");
  expect(loadConfig().port).toBe(12000);
});

test("preserves valid and malformed existing bytes", () => {
  const valid = '{"port": 14000, "providers": {}, "defaultProvider": "openai"}\n';
  writeFileSync(getConfigPath(), valid);
  expect(initializePersistedConfigIfMissing(config(15000))).toBe("exists");
  expect(readFileSync(getConfigPath(), "utf8")).toBe(valid);

  const malformed = "not-json\n";
  writeFileSync(getConfigPath(), malformed);
  expect(initializePersistedConfigIfMissing(config(16000))).toBe("invalid");
  expect(readFileSync(getConfigPath(), "utf8")).toBe(malformed);
});

test("a competing creator wins and losing staged bytes are scrubbed", () => {
  const winner = '{"port": 17000, "providers": {}, "defaultProvider": "openai"}\n';
  setPersistedConfigInitializationBeforePublishForTests(() => writeFileSync(getConfigPath(), winner));
  expect(initializePersistedConfigIfMissing(config(18000))).toBe("exists");
  expect(readFileSync(getConfigPath(), "utf8")).toBe(winner);
  expect(readdirSync(root).filter(name => name.includes(".ocx.") && name.endsWith(".tmp"))).toEqual([]);
});

test("rejects pathname replacement of the staged temporary file", () => {
  setPersistedConfigInitializationBeforePublishForTests(() => {
    const staged = readdirSync(root).find(name => name.endsWith(".tmp"));
    if (!staged) throw new Error("staged temp not found");
    const path = join(root, staged);
    unlinkSync(path);
    writeFileSync(path, "attacker-bytes");
  });
  expect(() => initializePersistedConfigIfMissing(config(19000))).toThrow(/identity changed/);
  expect(existsSync(getConfigPath())).toBe(false);
});

test("surfaces publication cleanup failure", () => {
  const io = {
    createExclusive: (path: string) => writeFileSync(path, "", { flag: "wx" }),
    write: (path: string, bytes: string) => writeFileSync(path, bytes),
    harden: () => {},
    publishNoReplace: () => {},
    truncate: () => { throw new Error("truncate failed"); },
    unlink: (() => { throw new Error("unlink failed"); }) as (path: string) => void,
  };
  expect(() => initializePersistedConfigIfMissing(config(), io)).toThrow();
  expect(existsSync(getConfigPath())).toBe(false);
});

test("reports secret residual when staged bytes cannot be scrubbed or removed", () => {
  let writes = 0;
  const io = {
    createExclusive: (path: string) => writeFileSync(path, "", { flag: "wx" }),
    write: (path: string, bytes: string) => { writes += 1; if (writes > 1) throw new Error("write blocked"); writeFileSync(path, bytes); },
    harden: () => {},
    publishNoReplace: () => { throw Object.assign(new Error("race"), { code: "EEXIST" }); },
    truncate: () => { throw new Error("truncate blocked"); },
    unlink: (() => { throw new Error("unlink blocked"); }) as (path: string) => void,
  };
  expect(() => initializePersistedConfigIfMissing(config(), io)).toThrow(AtomicWriteSecretResidualError);
});
