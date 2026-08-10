/**
 * The AdmissionSnapshot producer.
 *
 * `AdmissionSnapshot` was a TYPE for this entire unit while nothing built one,
 * so the write lock's API could only be exercised with a fabricated object. What
 * these tests hold down is the two properties that make a real one worth having:
 * it REFUSES rather than guessing, and it CREATES NOTHING while doing so — an
 * admission that manufactures the state it is admitting cannot refuse.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { admitCodexWrite as admitRaw, hashAuthority } from "../src/codex/admission";

/*
 * Ownership is proven by shelling out to the platform service manager, and a
 * fixture that reached the real one would assert against whatever this developer
 * has installed. These cases are about the OTHER authorities, so ownership is
 * pinned; the tri-state itself has its own suite.
 */
const admitCodexWrite = (): ReturnType<typeof admitRaw> =>
  admitRaw({ inspectOwnership: () => ({ ownership: "owned", reason: "pinned by fixture" }) });
import { JOURNAL_PATH } from "../src/codex/journal";
import type { OcxConfig } from "../src/types";

let root = "";
let codexHome = "";
let opencodexHome = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;
const cleanup: string[] = [];

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    } as OcxConfig["providers"],
    defaultProvider: "openai",
  };
}

/** Everything the producer may read, and nothing it may create. */
function seed(config: OcxConfig = baseConfig(), codexToml = 'model = "gpt-5"\n'): void {
  writeFileSync(join(opencodexHome, "config.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(codexHome, "config.toml"), codexToml);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-admission-"));
  cleanup.push(root);
  codexHome = join(root, ".codex");
  opencodexHome = join(root, ".opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(opencodexHome, { recursive: true });
  /*
   * An OWNED environment. `bun test` isolates CODEX_HOME to a temp dir, so the
   * real service-state.json under ~/.opencodex names a different home and every
   * admission refuses on service-home — the preflight working exactly as
   * designed, against the wrong fixture. Same reason the Grok toggle tests write
   * this file.
   */
  writeFileSync(join(opencodexHome, "service-state.json"), JSON.stringify({
    version: 2,
    codexHome,
    opencodexHome,
    backend: "scheduler",
  }));
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("it refuses rather than guessing", () => {
  test("a missing config refuses on config authority", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    const result = admitCodexWrite();
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.authority).toBe("config");
  });

  test("a malformed config refuses rather than falling back to defaults", () => {
    writeFileSync(join(opencodexHome, "config.json"), "{ not json");
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    const result = admitCodexWrite();
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.authority).toBe("config");
  });

  /**
   * An external owner is its own authority, separate from service-home. The two
   * need different messages because they need different actions: one is "another
   * install owns this home", the other is "you pointed Codex somewhere else".
   */
  test("an external model_provider refuses on its own authority", () => {
    seed(baseConfig(), [
      'model_provider = "someone-else"',
      "",
      "[model_providers.someone-else]",
      'name = "someone-else"',
      'base_url = "https://example.invalid/v1"',
      "",
    ].join("\n"));
    const result = admitCodexWrite();
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.authority).toBe("external-provider");
    expect(result.kind === "refused" && result.message).toContain("someone-else");
  });
});

describe("it creates nothing", () => {
  /**
   * The failure this guards is specific and has bitten this codebase: a status
   * read that mkdirs its own library, so merely ASKING manufactures the state
   * being asked about.
   */
  test("a refusal leaves the filesystem exactly as it found it", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    const before = [...readdirSync(codexHome), ...readdirSync(opencodexHome)].sort();

    expect(admitCodexWrite().kind).toBe("refused");

    const after = [...readdirSync(codexHome), ...readdirSync(opencodexHome)].sort();
    expect(after).toEqual(before);
  });

  test("a successful admission also creates nothing", () => {
    seed();
    const before = [...readdirSync(codexHome), ...readdirSync(opencodexHome)].sort();

    expect(admitCodexWrite().kind).toBe("admitted");

    const after = [...readdirSync(codexHome), ...readdirSync(opencodexHome)].sort();
    expect(after).toEqual(before);
    // Named explicitly, because these are the two an eager producer would make.
    expect(existsSync(join(opencodexHome, "integrations"))).toBe(false);
    expect(existsSync(join(codexHome, "opencodex.config.toml"))).toBe(false);
  });
});

describe("the snapshot describes one decision", () => {
  test("intent follows the persisted switch", () => {
    seed();
    const on = admitCodexWrite();
    expect(on.kind === "admitted" && on.snapshot.intent).toBe("on");

    seed({ ...baseConfig(), clientIntegrations: { codex: false } });
    const off = admitCodexWrite();
    expect(off.kind === "admitted" && off.snapshot.intent).toBe("off");
  });

  test("absence of the journal is evidence, not a hole", () => {
    seed();
    const absent = admitCodexWrite();
    expect(absent.kind === "admitted" && absent.snapshot.journalIdentity).toBe("absent");

    // The journal's own path, imported rather than re-derived. This fixture used
    // to build OPENCODEX_HOME/codex-journal.json by hand and agreed with a
    // producer that did the same — both wrong, and green because they matched.
    writeFileSync(JOURNAL_PATH, "{}");
    const present = admitCodexWrite();
    expect(present.kind === "admitted" && present.snapshot.journalIdentity).not.toBe("absent");
  });

  /**
   * The lock compares authoritySnapshotId and NOTHING else, so a field left out
   * of the hash is a field that can change under the lock unnoticed.
   */
  test("every authority field moves the id", () => {
    seed();
    const admitted = admitCodexWrite();
    expect(admitted.kind).toBe("admitted");
    if (admitted.kind !== "admitted") return;
    const base = admitted.snapshot;

    const variants = [
      { ...base, configDigest: "different" },
      { ...base, intent: "off" as const },
      { ...base, generation: { present: true, value: base.generation.value + 1 } },
      { ...base, ownership: "foreign" as const },
      { ...base, externalProvider: "someone" },
      { ...base, journalIdentity: "different" },
      { ...base, provenanceIdentity: "different" },
      { ...base, canonicalTargets: { ...base.canonicalTargets, config: "/elsewhere" } },
    ];
    for (const variant of variants) {
      expect(hashAuthority(variant)).not.toBe(hashAuthority(base));
    }
    // And an identical snapshot hashes identically, or the comparison would
    // refuse every write for no reason.
    expect(hashAuthority({ ...base })).toBe(hashAuthority(base));
  });
});

describe("ownership is an authority, not a formality", () => {
  /*
   * The mutation that exposed the gap: flipping admission's ownership guard to
   * `if (false)` left every test green, because the fixtures pin ownership to
   * `owned` and nothing exercised the refusal. A guard with no test is a guard
   * someone can delete.
   */
  test("foreign ownership refuses on the service-home authority", () => {
    seed();
    const result = admitRaw({
      inspectOwnership: () => ({ ownership: "foreign", reason: "installed for /elsewhere" }),
    });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.authority).toBe("service-home");
    expect(result.kind === "refused" && result.message).toContain("/elsewhere");
  });

  test("unknown ownership refuses too, and says the proof is missing", () => {
    seed();
    const result = admitRaw({
      inspectOwnership: () => ({ ownership: "unknown", reason: "the plist could not be read" }),
    });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.authority).toBe("service-home");
    // The two refusals must not read alike: one is someone else's home, the
    // other is a question nobody could answer, and they need different actions.
    expect(result.kind === "refused" && result.message).toContain("could not be proven");
  });

  test("neither refusal creates anything", () => {
    seed();
    const before = [...readdirSync(codexHome), ...readdirSync(opencodexHome)].sort();
    for (const ownership of ["foreign", "unknown"] as const) {
      expect(admitRaw({ inspectOwnership: () => ({ ownership, reason: "x" }) }).kind).toBe("refused");
    }
    expect([...readdirSync(codexHome), ...readdirSync(opencodexHome)].sort()).toEqual(before);
  });

  test("the admitted snapshot carries the observed value, not a constant", () => {
    seed();
    const result = admitRaw({ inspectOwnership: () => ({ ownership: "owned", reason: "probe" }) });
    expect(result.kind === "admitted" && result.snapshot.ownership).toBe("owned");
  });
});
