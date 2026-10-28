import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { spawnCodex, type CodexSpawnDeps } from "../../src/cli/codex-launcher";
import { validatedCodexExecInvocation } from "../../src/codex/exec-boundary";

const root = "/opt/ChatGPT Beta.app";
const member = `${root}/Contents/Resources/codex`;
type Link = readonly [string, string | null];
let errors: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => { errors = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); });

// Model realpath at its existing seam, including redirects of ancestor directories.
function harness(command: string, backing: boolean, links: readonly Link[], refusal: string | null = null) {
  const checks: string[][] = [], spawns: string[] = [];
  const deps: CodexSpawnDeps = {
    findOnPath: () => backing ? "/owned/codex-wrapper" : command,
    inspectShim: () => (backing
      ? { status: "matched", selectedRole: "wrapper", backingPath: command }
      : { status: "absent" }) as ReturnType<NonNullable<CodexSpawnDeps["inspectShim"]>>,
    execBoundary: {
      platform: "darwin", executable: () => true,
      realpath: path => {
        const link = links.find(([from]) => path === from || path.startsWith(from + "/"));
        return link ? link[1] === null ? null : link[1] + path.slice(link[0].length) : path;
      },
      macBundleTrustReasonAsync: async (bundle, binary) => { checks.push([bundle, binary]); return refusal; },
    },
    spawn: ((file: string) => {
      spawns.push(file);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    }) as typeof spawn,
  };
  return { deps, checks, spawns };
}

const escapes: Array<{ name: string; links: Link[] }> = [
  { name: "executable symlink", links: [[member, "/outside/codex"]] },
  { name: "Resources symlink", links: [[`${root}/Contents/Resources`, "/outside"]] },
  { name: "Contents symlink", links: [[`${root}/Contents`, "/outside"]] },
  { name: "member in another signed app", links: [[member, "/opt/Other.app/Contents/Resources/codex"]] },
  { name: "prefix sibling", links: [[member, `${root}-sibling/Contents/Resources/codex`]] },
  { name: "outside Contents", links: [[member, `${root}/MacOS/codex`]] },
  { name: "unresolvable lexical root", links: [[member, "/opt/Other.app/Contents/Resources/codex"], [root, null]] },
  { name: "aliased root with an escaped member", links: [[member, "/outside/codex"], [root, "/real/Bundle"]] },
  { name: "aliased inner root escaped within the outer app", links: [
    [member, "/real/Outer.app/Contents/Resources/codex"],
    [root, "/real/Outer.app/Contents/Resources/Inner.app"],
  ] },
];

for (const backing of [false, true]) for (const scenario of escapes) {
  test(`CLI refuses lexical bundle escape before an accepting verifier: ${scenario.name}, backing=${backing}`, async () => {
    const h = harness(member, backing, scenario.links);
    expect(await spawnCodex(["--version"], {}, h.deps)).toBe(1);
    expect(h.checks).toEqual([]);
    expect(h.spawns).toEqual([]);
    expect(errors.mock.calls.flat().join(" ")).toContain(
      scenario.name === "unresolvable lexical root" ? "cannot canonicalize the app bundle" : "outside bundle Contents",
    );
  });
}

for (const backing of [false, true]) for (const canonicalRoot of ["/real/Bundle", "/real/Renamed.APP"]) {
  test(`CLI verifies a whole-bundle symlink: ${canonicalRoot}, backing=${backing}`, async () => {
    const binary = `${canonicalRoot}/Contents/Resources/codex`;
    const h = harness(member, backing, [[root, canonicalRoot]], "signature revoked");
    expect(await spawnCodex(["--help"], {}, h.deps)).toBe(1);
    expect(h.checks).toEqual([[canonicalRoot, binary]]);
    expect(h.spawns).toEqual([]);
    const trusted = harness(member, backing, [[root, canonicalRoot]]);
    expect(await spawnCodex(["--help"], {}, trusted.deps)).toBe(0);
    expect(trusted.checks).toEqual([[canonicalRoot, binary]]);
    expect(trusted.spawns).toEqual([binary]);
  });
}

for (const backing of [false, true]) for (const from of [member, `${root}/Contents/Resources`]) {
  test(`CLI validates an in-bundle member alias: ${from}, backing=${backing}`, async () => {
    const target = from === member ? `${root}/Contents/MacOS/codex` : `${root}/Contents/MacOS`;
    const links: Link[] = [[from, target]];
    const canonical = `${root}/Contents/MacOS/codex`;
    const trusted = harness(member, backing, links);
    expect(await spawnCodex(["--version"], {}, trusted.deps)).toBe(0);
    expect(trusted.checks).toEqual([[root, canonical]]);
    expect(trusted.spawns).toEqual([canonical]);
    const rejected = harness(member, backing, links, "signature revoked");
    expect(await spawnCodex(["--version"], {}, rejected.deps)).toBe(1);
    expect(rejected.checks).toEqual([[root, canonical]]);
    expect(rejected.spawns).toEqual([]);
  });
}

for (const suffix of ["app", "APP", "ApP"]) {
  test(`CLI retains lexical .${suffix} classification when the canonical member escapes`, async () => {
    const binary = `/opt/Unrelated.${suffix}/Contents/Resources/codex`;
    const h = harness(binary, false, [[binary, "/outside/codex"]]);
    expect(await spawnCodex(["app-server"], {}, h.deps)).toBe(1);
    expect(h.checks).toEqual([]);
    expect(h.spawns).toEqual([]);
  });
}

for (const backing of [false, true]) {
  test(`CLI spawns the captured canonical member after lexical alias replacement, backing=${backing}`, async () => {
    const canonical = `${root}/Contents/MacOS/codex`;
    const links: Link[] = [[member, canonical]];
    const h = harness(member, backing, links);
    let entered!: () => void, release!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    h.deps.execBoundary!.macBundleTrustReasonAsync = async (bundle, binary) => {
      h.checks.push([bundle, binary]); entered();
      await pending;
      return null;
    };
    const launch = spawnCodex(["--help"], {}, h.deps);
    await checking;
    links[0] = [member, "/outside/replaced-codex"];
    release();
    expect(await launch).toBe(0);
    expect(h.checks).toEqual([[root, canonical]]);
    expect(h.spawns).toEqual([canonical]);
  });
}

test("CLI checks the outer canonical app when the lexical bundle root is an inner app alias", async () => {
  const outer = "/real/Outer.app";
  const inner = `${outer}/Contents/Resources/Inner.app`;
  const binary = `${inner}/Contents/Resources/codex`;
  const h = harness(member, true, [[root, inner]], "signature revoked");
  expect(await spawnCodex(["--help"], {}, h.deps)).toBe(1);
  expect(h.checks).toEqual([[outer, binary]]);
  expect(h.spawns).toEqual([]);
});

test("synchronous CLI validation applies the same lexical containment refusal", () => {
  let checks = 0;
  expect(() => validatedCodexExecInvocation(member, [], {
    platform: "darwin", verifyAnyAppBundle: true, executable: () => true,
    realpath: path => path === member ? "/outside/codex" : path,
    macBundleTrustReason: () => { checks++; return null; },
  })).toThrow("outside bundle Contents");
  expect(checks).toBe(0);
});
