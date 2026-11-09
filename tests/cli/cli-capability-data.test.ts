import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as facade from "../../src/cli/capabilities";
import * as base from "../../src/cli/capabilities-base";
import { PROVIDER_MODEL_CAPABILITIES } from "../../src/cli/capabilities-provider-models";
import { ACCOUNT_CAPABILITIES } from "../../src/cli/capabilities-accounts";
import { AGENT_ROUTING_CAPABILITIES } from "../../src/cli/capabilities-agents-routing";
import { INTEGRATION_CAPABILITIES } from "../../src/cli/capabilities-integrations";
import { OBSERVE_SYSTEM_CAPABILITIES } from "../../src/cli/capabilities-observe-system";
import { ACCESS_REMOTE_CAPABILITIES } from "../../src/cli/capabilities-access-remote";
import { LAB_CAPABILITIES } from "../../src/cli/capabilities-lab";
import { CAPABILITY_DATA_FILES, capabilityDataBoundary } from "../helpers/cli-capability-data";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const validFiles: Record<string, string> = {
  "capabilities.ts": `import { CAPABILITIES } from './capabilities-base';
    import type { Capability } from './capability-types';
    export { CAPABILITIES } from './capabilities-base';
    export type { Capability } from './capability-types';`,
  "capabilities-base.ts": `import type { Capability } from './capability-types';
    export const CAPABILITIES: readonly Capability[] = [];`,
  "capability-types.ts": `export interface Capability { readonly summary: string; }
    export type Mode = 'payload' | 'none';`,
};

function checkFixture(changes: Record<string, string | undefined> = {}): string[] {
  const leaves = Object.fromEntries(CAPABILITY_DATA_FILES.filter(name => !(name in validFiles))
    .map(name => [name, `import type { Capability } from "./capability-types"; export const ROWS: readonly Capability[] = [];`]));
  const files = { ...leaves, ...validFiles, ...changes };
  const directory = resolve("capability-graph-fixture");
  return capabilityDataBoundary(directory, path => {
    const source = files[basename(path)];
    if (source === undefined) throw new Error(`missing module ${path}`);
    return source;
  });
}

describe("checked capability dependency boundary", () => {
  test("real graph and static type/value fixtures use the same predicate", () => {
    expect(capabilityDataBoundary(repoPath("src", "cli"))).toEqual([]);
    expect(checkFixture()).toEqual([]);
    expect(checkFixture({
      "capabilities-base.ts": `import { type Capability as Row } from './capability-types.ts';
        export const CAPABILITIES: readonly Row[] = [];`,
    })).toEqual([]);
  });

  test("comments, strings, templates and regex lookalikes are not dependencies", () => {
    expect(checkFixture({ "capabilities-base.ts": validFiles["capabilities-base.ts"] + `
      // import { handler } from './capabilities-command'; require('bad');
      /* export * from '../config'; import('bad'); */
      const text = "import('bad'); require('bad');";
      const template = \`export * from '../lab'; import('bad')\`;
      const pattern = /require\('bad'\)/;
      const names = ["require", "import"];
      const quoted = 'module[\`require\`]("node:path"); {} as any / import("node:path") / 1';
      const templates = [\`require\`, \`module["require"]("node:path")\`];
      const nested = { values: [["require"], ["import"]] };
      const regexImport = /import\\("node:path"\\)/;
      // module[\`require\`]("node:path"); {} as any / import("node:path") / 1

    ` })).toEqual([]);
  });

  for (const [name, source] of Object.entries({
    handler: `import { runCapabilities } from './capabilities-command';`,
    config: `import { loadConfig } from '../config';`,
    lab: `export { activate } from '../lab/index';`,
    "type-only outside dependency": `import type { Settings } from '../config';`,
    "side-effect import": `import '../config';`,
    "side-effect allowed filename": `import './capability-types';`,
    "bare import": `import { readFile } from 'node:fs';`,
    "bare type import": `import type { Stats } from 'node:fs';`,
    "default import": `import data from './capabilities-base';`,
    "namespace import": `import * as data from './capabilities-base';`,
    "type re-export outside": `export type { Settings } from '../config';`,
    "bare re-export": `export { readFile } from 'node:fs';`,
    "star re-export": `export * from './capability-types';`,
    "type star re-export": `export type * from './capability-types';`,
    "unresolved file": `import { data } from './missing';`,
    "computed specifier": `import { data } from ('./capability-types');`,
    "dynamic literal": `import('./capability-types');`,
    "dynamic computed": `import('./capability-' + name);`,
    "type import query": `type Row = import('./capability-types').Capability;`,
    require: `require('./capability-types');`,
    "F1 R2 quoted destructuring loader": 'const { "require": load } = module; load("node:path");',
    "F1 template computed require": 'module[`require`]("node:path");',
    "F1 division hidden import": 'const ratio = {} as any / Number(import("node:path")) / 1;',
    "computed require": `module['require']('./capability-types');`,
    "aliased require": `const load = require; load('./capability-types');`,
    "import meta load": `import.meta.require('./capability-types');`,
    "template expression load": 'const text = `ignored ${import("../config")}`;',
    "value edge into types": `import { Capability } from './capability-types';`,
    "base re-export": `export type { Capability } from './capability-types';`,
    "malformed source": `export const data = [`,
  })) {
    test(`refuses ${name} reached transitively through base`, () => {
      expect(checkFixture({ "capabilities-base.ts": validFiles["capabilities-base.ts"] + source }).length).toBeGreaterThan(0);
    });
  }

  test("computed-member variants are outside the metadata grammar regardless of key spelling", () => {
    for (const expression of [
      'module[`requ\\u0069re`]("node:path")',
      'module[`req${"uire"}`]("node:path")',
      'module["req" + "uire"]("node:path")',
      '(module)[`require`]("node:path")',
      'module?.[`require`]("node:path")',
      'module![`require`]("node:path")',
      'const load = module[`require`]; load("node:path")',
      'const key = "require"; module[key]("node:path")',
      // A benign computed lookup is refused honestly as unsupported too.
      'const first = rows[0]',
    ]) {
      expect(checkFixture({ "capabilities-base.ts": validFiles["capabilities-base.ts"] + expression + ";" })
        .join("\n")).toContain("unsupported metadata expression: computed member or bracket position");
    }
  });

  test("division and ambiguous regex tokens cannot hide literal or computed loads", () => {
    for (const expression of [
      'const ratio = {} as any / Number(import("node:path")) / 1;',
      'const ratio = {} as unknown / Number(import(name)) / 1;',
      'const ratio = {} as never / Number(module[`require`]("node:path")) / 1;',
      'const ratio = 10 / Number(import("node:path")) / 1;',
      'let ratio = 10; ratio /= Number(import(name));',
      // These have no dependency; unsupported does not mean an actual load.
      'const ratio = 10 / 2;',
      'const pattern = true ? /harmless/ : /also-harmless/;',
    ]) {
      expect(checkFixture({ "capabilities-base.ts": validFiles["capabilities-base.ts"] + expression })
        .join("\n")).toContain("unsupported metadata expression: division or ambiguous regex position");
    }
  });

  test("host references are refused before nested, aliased or reassigned loaders escape", () => {
    for (const [source, host] of [
      ['const { "require": load } = module; load("node:path");', "module"],
      ['const host = module; const { "require": load } = host; load("node:path");', "module"],
      ['const { "host": { "require": load } } = { "host": module }; load("node:path");', "module"],
      ['let load; ({ "require": load } = module); load("node:path");', "module"],
      ['const { "require": load } = globalThis; load("node:path");', "globalThis"],
      ['const { "module": { "require": load } } = global; load("node:path");', "global"],
      ['const { "mainModule": { "require": load } } = process; load("node:path");', "process"],
      ['const { "require": load } = this; load("node:path");', "this"],
      ['(({ "require": load }) => load("node:path"))(module);', "module"],
      [String.raw`const { "requ\u0069re": load } = modu\u006ce; load("node:path");`, "module"],
      [String.raw`const { "require": load } = glo\u{62}alThis; load("node:path");`, "globalThis"],
      [String.raw`const load = requ\u{69}re; load("node:path");`, "require"],
    ]) {
      expect(checkFixture({ "capabilities-base.ts": validFiles["capabilities-base.ts"] + source })
        .join("\n")).toContain(`unsupported metadata host/loader identifier: ${host}`);
    }
  });

  test("reserved host vocabulary rejects even benign references and local shadowing", () => {
    for (const host of ["require", "module", "exports", "global", "globalThis", "Bun", "process", "Deno", "window", "self", "this"]) {
      expect(checkFixture({ "capabilities-base.ts": validFiles["capabilities-base.ts"] + `const host = ${host};` })
        .join("\n")).toContain(`unsupported metadata host/loader identifier: ${host}`);
    }
    for (const source of [
      'const module = "harmless";',
      'function copy(module: string) { return module; }',
      'const data = { module: "harmless" };',
      'type module = string;',
    ]) {
      expect(checkFixture({ "capabilities-base.ts": validFiles["capabilities-base.ts"] + source })
        .join("\n")).toContain("unsupported metadata host/loader identifier: module");
    }
  });

  test("quoted host/loader properties and inert spellings remain data", () => {
    expect(checkFixture({ "capabilities-base.ts": validFiles["capabilities-base.ts"] + String.raw`
      const data = {
        "require": "display text", "module": { "require": "still data" },
        "globalThis": "label", "global": "label", "Bun": "label", "process": "label",
        "Deno": "label", "window": "label", "self": "label", "exports": "label", "this": "label",
        "requ\u0069re": "escaped property", "modu\u006ce": "escaped property"
      };
      const { "require": text } = data;
      const { "module": { "require": nestedText } } = data;
      const quoted = "const host = modu\u006ce; globalThis; require";
      const pattern = /module|globalThis|require|Bun|process/;
      // module globalThis require; const { "require": load } = module;
      /* modu\u006ce glo\u{62}alThis requ\u0069re */
    ` })).toEqual([]);
  });

  test("does not confuse a mixed type/value clause with a type-only edge", () => {
    expect(checkFixture({ "capabilities-base.ts": `import { type Capability, value } from './capability-types';` })
      .join("\n")).toContain("forbidden edge import:value:capability-types.ts");
  });

  test("cycles, including type-only cycles, are reported", () => {
    for (const prefix of ["", "type "]) {
      expect(checkFixture({ "capabilities-base.ts": `import ${prefix}{ CAPABILITIES } from './capabilities';` })
        .join("\n")).toContain("cycle: capabilities.ts");
    }
  });

  test("missing allowlisted files fail closed", () => {
    expect(checkFixture({ "capability-types.ts": undefined }).join("\n")).toContain("missing module");
  });

  test("types cannot gain dependencies or runtime initializers", () => {
    for (const source of [
      `import type { Capability } from './capabilities';`,
      `export const state = 1;`,
      `export enum State { Active }`,
    ]) expect(checkFixture({ "capability-types.ts": source }).length).toBeGreaterThan(0);
  });
});

const completeUsage = "ocx models set-price <provider/model> (--auto | --input <rate> --output <rate>) [--cache-read <rate>] [--cache-write <rate>] [--json]";
const warning = "Capability metadata is incomplete; this is not the full operand grammar.";

type Discovery = {
  all: { schemaVersion: number; capabilities: Record<string, unknown>[]; headCapabilities: unknown[] };
  filtered: { capabilities: Record<string, unknown>[]; headCapabilities?: unknown[] };
  help: string;
  alias: string;
  legacy: string;
  parent: string;
  fallback: string;
  invocation: string;
  human: string;
};

function discovery(mode: "absent" | "present" | "undefined" | "empty"): Discovery {
  const home = mkdtempSync(join(tmpdir(), "ocx-capability-data-"));
  const codex = join(home, "codex");
  const ocx = join(home, "ocx");
  mkdirSync(codex);
  mkdirSync(ocx);
  // Only this child mutates a real row. No synthetic shipped command, shared global
  // mutation, production injection seam, proxy, credentials or upstream are involved.
  const script = `
    globalThis.fetch = () => { throw new Error('discovery attempted HTTP'); };
    const { CAPABILITIES, capabilityInvocation } = await import(${JSON.stringify(repoPath("src/cli/capabilities.ts"))});
    for (const row of CAPABILITIES) delete row.usage;
    const target = CAPABILITIES.find(cap => cap.command.join(' ') === 'models set-price');
    if (!target) throw new Error('missing fixture leaf');
    const mode = ${JSON.stringify(mode)};
    if (mode !== 'absent') Object.defineProperty(target, 'usage', {
      value: mode === 'undefined' ? undefined : mode === 'empty' ? '' : ${JSON.stringify(completeUsage)},
      enumerable: true,
    });
    const { runCapabilities } = await import(${JSON.stringify(repoPath("src/cli/capabilities-command.ts"))});
    const { printSubcommandUsage } = await import(${JSON.stringify(repoPath("src/cli/help.ts"))});
    async function output(args) {
      const lines = [];
      const original = console.log;
      console.log = text => lines.push(text);
      try {
        if (await runCapabilities(args) !== 0) throw new Error('capabilities failed');
        return lines.join('\\n');
      } finally { console.log = original; }
    }
    function help(path, fallbackToParent = false) {
      const lines = [];
      printSubcommandUsage(path[0], path, { write: line => lines.push(line), fallbackToParent });
      return lines.join('\\n');
    }
    console.log(JSON.stringify({
      all: JSON.parse(await output(['--json'])),
      filtered: JSON.parse(await output(['--json', '--route', '/api/providers/{provider}/model-costs', '--mutating-only'])),
      human: await output(['--route', '/api/providers/{provider}/model-costs', '--mutating-only']),
      help: help(['models', 'set-price']), alias: help(['model', 'set-price']),
      legacy: help(['models', 'price']), parent: help(['models']),
      fallback: help(['model', 'set-price', 'example/model'], true),
      invocation: capabilityInvocation(target),
    }));`;
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: home, USERPROFILE: home, CODEX_HOME: codex, OPENCODEX_HOME: ocx,
        TMPDIR: home, TMP: home, TEMP: home },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(readdirSync(codex)).toEqual([]);
    expect(readdirSync(ocx)).toEqual([]);
    return JSON.parse(result.stdout) as Discovery;
  } finally {
    removeTreeWithRetry(home);
    expect(existsSync(home)).toBe(false);
  }
}

describe("capability facade and optional usage consumers", () => {
  test("public runtime exports and base array/row identities remain stable", () => {
    expect(Object.keys(facade).sort()).toEqual([
      "CAPABILITIES", "HEAD_CAPABILITIES", "capabilitiesForRoute", "capabilityInvocation", "capabilityRouteKeys",
    ].sort());
    expect(facade.CAPABILITIES.slice(0, base.CAPABILITIES.length)).toEqual(base.CAPABILITIES);
    base.CAPABILITIES.forEach((row, index) => expect(facade.CAPABILITIES[index]).toBe(row));
    expect(new Set(facade.CAPABILITIES.map(row => row.command.join(" "))).size).toBe(facade.CAPABILITIES.length);
    expect(facade.CAPABILITIES.slice(base.CAPABILITIES.length)).toEqual([
      ...PROVIDER_MODEL_CAPABILITIES,
      ...ACCOUNT_CAPABILITIES,
      ...AGENT_ROUTING_CAPABILITIES,
      ...INTEGRATION_CAPABILITIES,
      ...OBSERVE_SYSTEM_CAPABILITIES,
      ...ACCESS_REMOTE_CAPABILITIES,
      ...LAB_CAPABILITIES,
    ]);
    expect(facade.HEAD_CAPABILITIES).toBe(base.HEAD_CAPABILITIES);
    const matches = facade.capabilitiesForRoute("/api/providers/{provider}/model-costs");
    expect(matches.map(facade.capabilityInvocation)).toEqual(["ocx models price", "ocx models set-price"]);
    for (const row of matches) expect(base.CAPABILITIES.includes(row)).toBe(true);
    expect(facade.capabilityRouteKeys().has("PUT /api/providers/{provider}/model-costs")).toBe(true);
    expect(facade.CAPABILITIES.some(row => Object.hasOwn(row, "usage"))).toBe(true);
  });

  test("absent usage preserves exact legacy JSON shape, help and alias output", () => {
    const result = discovery("absent");
    expect(result.all.schemaVersion).toBe(1);
    expect(result.all.headCapabilities).toEqual(base.HEAD_CAPABILITIES);
    expect(result.all.capabilities).toEqual(facade.CAPABILITIES.map(cap => ({
      command: cap.command, invocation: `ocx ${cap.command.join(" ")}`, summary: cap.summary,
      routes: cap.routes, flags: cap.flags, mutates: cap.mutates, json: cap.json,
      ...(cap.details ? { details: cap.details } : {}),
    })));
    expect(result.legacy).toBe([
      "Command: ocx models price\n\nRead the saved manual price for an exact provider/model selector.",
      "\nDeclared flags:",
      "  --json  Emit provider, modelId, and cost (null for automatic pricing).",
      "\nThe provider must be configured; everything after the first slash is the exact upstream model ID.",
      `\n${warning}`, "\nParent help: ocx help models",
    ].join("\n"));
    expect(result.help).toStartWith("Command: ocx models set-price\n\n");
    expect(result.help).toContain(warning);
    expect(result.alias).toBe(result.help);
  }, SPAWN_BUDGET_MS);

  test("present usage reaches real full/filtered JSON and leaf/alias/fallback help only", () => {
    const before = discovery("absent");
    const after = discovery("present");
    const target = after.all.capabilities.find(cap => cap.invocation === "ocx models set-price");
    expect(target?.usage).toBe(completeUsage);
    expect(after.filtered.capabilities).toEqual([target!]);
    expect(after.filtered).not.toHaveProperty("headCapabilities");
    expect(after.all.capabilities.filter(cap => Object.hasOwn(cap, "usage"))).toHaveLength(1);
    expect(after.all.capabilities.map(({ usage: _usage, ...cap }) => cap)).toEqual(before.all.capabilities);
    expect(after.help).toBe(before.help
      .replace("Command: ocx models set-price", `Usage: ${completeUsage}`)
      .replace(`\n\n${warning}`, ""));
    expect(after.alias).toBe(after.help);
    expect(after.fallback).toBe(after.help);
    expect(after.legacy).toBe(before.legacy);
    expect(after.parent).toBe(before.parent);
    expect(after.human).toBe(before.human);
    expect(after.invocation).toBe("ocx models set-price");
  }, SPAWN_BUDGET_MS);

  test("undefined remains absent while a defined empty string follows the defined-value contract", () => {
    const absent = discovery("absent");
    expect(discovery("undefined")).toEqual(absent);
    const empty = discovery("empty");
    expect(empty.filtered.capabilities[0].usage).toBe("");
    expect(empty.help).toStartWith("Usage: \n\n");
    expect(empty.help).not.toContain(warning);
    expect(empty.alias).toBe(empty.help);
  }, SPAWN_BUDGET_MS);
});
