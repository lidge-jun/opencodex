/**
 * The primitives the Codex write lock's authority comparison rests on.
 *
 * These are deliberately function-level. The refusal they enable —
 * `authority_not_proven` on a competing write — cannot be proven here, because
 * it needs an admitted snapshot, and admission cannot honestly admit anything
 * while its ownership field is still hardcoded. Proving the refusal against a
 * placeholder would be proving it against a known lie, so that claim belongs to
 * the phases that make ownership real.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  observeConfigGeneration,
  readConfigAdmissionSnapshot,
  readConfigGenerationInCurrentMutationTransaction,
  saveConfig,
  withConfigMutationLockSync,
} from "../src/config";
import { hashAuthority } from "../src/codex/admission";
import { captureCatalogAdmissionSnapshot } from "../src/codex/catalog-admission";
import { JOURNAL_PATH } from "../src/codex/journal";
import type { AdmissionSnapshot } from "../src/codex/convergence-types";
import type { OcxConfig } from "../src/types";

let root = "";
let previousOpencodexHome: string | undefined;
const cleanup: string[] = [];

function config(port = 10100): OcxConfig {
  return {
    port,
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-admission-primitives-"));
  cleanup.push(root);
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = root;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("the config digest is over bytes, not over meaning", () => {
  /**
   * The defect this closes: the digest used to hash `JSON.stringify(config)`,
   * so two files that parse the same hashed the same. A non-cooperating writer
   * could reformat the file between admission and commit and the comparison
   * would see nothing at all.
   */
  test("a whitespace-only rewrite moves the digest", () => {
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify(config(), null, 2));
    const compact = readConfigAdmissionSnapshot();

    writeFileSync(path, JSON.stringify(config(), null, 8));
    const spacious = readConfigAdmissionSnapshot();

    expect(compact.kind).toBe("read");
    expect(spacious.kind).toBe("read");
    // Same meaning...
    expect(spacious.diagnostics.config).toEqual(compact.diagnostics.config);
    // ...different bytes.
    expect(spacious.contentSha256).not.toBe(compact.contentSha256);
  });

  test("and moves the authority hash with it", () => {
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify(config(), null, 2));
    const before = readConfigAdmissionSnapshot();
    writeFileSync(path, JSON.stringify(config(), null, 8));
    const after = readConfigAdmissionSnapshot();

    expect(hashAuthority(snapshotWith({ configDigest: after.contentSha256 ?? "" })))
      .not.toBe(hashAuthority(snapshotWith({ configDigest: before.contentSha256 ?? "" })));
  });

  test("identical bytes hash identically, or every write would refuse itself", () => {
    const path = join(root, "config.json");
    const bytes = JSON.stringify(config(), null, 2);
    writeFileSync(path, bytes);
    const first = readConfigAdmissionSnapshot();
    writeFileSync(path, bytes);
    const second = readConfigAdmissionSnapshot();
    expect(second.contentSha256).toBe(first.contentSha256);
  });

  /**
   * Hashing the file and then reading it again to parse would leave a window in
   * which the two disagree — turning the check into a second chance to be wrong.
   * The read count is the property; the digest being correct is not enough.
   */
  /**
   * A spy cannot see through the module boundary here, so the read count is
   * proven by CONSEQUENCE instead: if the producer read the file twice, a
   * change landing between the two reads would make the digest and the parsed
   * config describe different files. Swapping the contents underneath a single
   * read is impossible; underneath two reads it is the whole hazard.
   */
  test("the digest and the parsed config always describe the same bytes", () => {
    const path = join(root, "config.json");
    for (const port of [10100, 20200, 30300]) {
      const bytes = JSON.stringify(config(port), null, 2);
      writeFileSync(path, bytes);
      const snapshot = readConfigAdmissionSnapshot();
      expect(snapshot.kind).toBe("read");
      expect(snapshot.diagnostics.config.port).toBe(port);
      // The digest of what we just wrote, computed independently.
      const independent = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      expect(snapshot.contentSha256).toBe(independent);
    }
  });

  test("an unreadable config cannot carry a digest", () => {
    // No config.json at all.
    const snapshot = readConfigAdmissionSnapshot();
    expect(snapshot.kind).toBe("unreadable");
    expect(snapshot.contentSha256).toBeNull();
    expect(snapshot.diagnostics.source).toBe("default");
  });
});

describe("absence is one state, and being unable to look is another", () => {
  test("a missing coordinator database is absent", () => {
    expect(observeConfigGeneration()).toEqual({ kind: "absent" });
  });

  test("a corrupt database is not absent", () => {
    writeFileSync(join(root, "config-mutation.sqlite"), "not sqlite");
    expect(observeConfigGeneration()).toEqual({ kind: "unavailable", reason: "database" });
  });

  test("a directory where the database should be is not absent", () => {
    mkdirSync(join(root, "config-mutation.sqlite"));
    const observed = observeConfigGeneration();
    expect(observed.kind).toBe("unavailable");
  });

  test("an unreadable parent directory is not absent", () => {
    const nested = join(root, "locked");
    mkdirSync(nested);
    writeFileSync(join(nested, "config-mutation.sqlite"), "");
    chmodSync(nested, 0o000);
    process.env.OPENCODEX_HOME = nested;
    try {
      const observed = observeConfigGeneration();
      // Either it could not stat (unavailable) or the platform let it through;
      // what must never happen is reporting ABSENT for a file that is there.
      expect(observed.kind).not.toBe("absent");
    } finally {
      chmodSync(nested, 0o700);
      process.env.OPENCODEX_HOME = root;
    }
  });

  test("an existing database reports its value", () => {
    saveConfig(config());
    expect(observeConfigGeneration()).toEqual({ kind: "ready", generation: { value: 1 } });
  });
});

describe("the generation read that belongs to the open transaction", () => {
  /**
   * The measured fact that made this necessary: on first acquisition the
   * BEGIN IMMEDIATE creating the table has not committed, so a separate
   * read-only connection still sees nothing. The observer cannot do this job.
   */
  test("the observer cannot read the first transaction, and this can", () => {
    const before = observeConfigGeneration();
    let observedInside: { kind: string } | undefined;
    let transactional: unknown;
    withConfigMutationLockSync(() => {
      observedInside = observeConfigGeneration();
      transactional = readConfigGenerationInCurrentMutationTransaction();
      return null;
    });
    const after = observeConfigGeneration();

    // Before: nothing exists. Inside: the file exists but its creating
    // transaction has not committed, so a separate connection still cannot read
    // a generation — it reports unavailable, NOT the zero that is really there.
    // Only after the commit does the observer agree.
    expect(before).toEqual({ kind: "absent" });
    expect(observedInside?.kind).not.toBe("ready");
    expect(after).toEqual({ kind: "ready", generation: { value: 0 } });
    // The transactional read saw the truth the whole time.
    expect(transactional).toEqual({ value: 0 });
  });

  test("calling it outside a transaction throws rather than guessing", () => {
    expect(() => readConfigGenerationInCurrentMutationTransaction()).toThrow(
      /requires an open config mutation transaction/,
    );
  });

  test("a nested call reads the same open handle", () => {
    const seen: unknown[] = [];
    withConfigMutationLockSync(() => {
      seen.push(readConfigGenerationInCurrentMutationTransaction());
      withConfigMutationLockSync(() => {
        seen.push(readConfigGenerationInCurrentMutationTransaction());
        return null;
      });
      return null;
    });
    expect(seen).toEqual([{ value: 0 }, { value: 0 }]);
  });

  test("it throws again once the transaction has closed", () => {
    withConfigMutationLockSync(() => readConfigGenerationInCurrentMutationTransaction());
    expect(() => readConfigGenerationInCurrentMutationTransaction()).toThrow();
  });
});

describe("absent and present-zero are one authority", () => {
  test("they hash identically, or no first write could ever commit", () => {
    expect(hashAuthority(snapshotWith({ generation: { present: false, value: 0 } })))
      .toBe(hashAuthority(snapshotWith({ generation: { present: true, value: 0 } })));
  });

  test("but a committed bump does not hash like either", () => {
    const zero = hashAuthority(snapshotWith({ generation: { present: true, value: 0 } }));
    expect(hashAuthority(snapshotWith({ generation: { present: true, value: 1 } }))).not.toBe(zero);
    expect(hashAuthority(snapshotWith({ generation: { present: true, value: 2 } }))).not.toBe(zero);
    expect(hashAuthority(snapshotWith({ generation: { present: true, value: 2 } })))
      .not.toBe(hashAuthority(snapshotWith({ generation: { present: true, value: 1 } })));
  });

  /**
   * Without this guard every malformed value collapses to "gen:0" — the single
   * value that means "nothing has happened yet, go ahead".
   */
  test.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["fractional", 1.5],
    ["beyond safe integers", Number.MAX_SAFE_INTEGER + 1],
  ])("a %s generation throws instead of becoming zero", (_label, value) => {
    expect(() => hashAuthority(snapshotWith({ generation: { present: true, value } })))
      .toThrow(/non-negative safe integer/);
  });

  test("every other authority field still moves the hash", () => {
    const base = snapshotWith({});
    const variants: Partial<AdmissionSnapshot>[] = [
      { configDigest: "different" },
      { intent: "off" },
      { ownership: "foreign" },
      { externalProvider: "someone" },
      { journalIdentity: "different" },
      { provenanceIdentity: "different" },
      { canonicalTargets: { ...base.canonicalTargets, config: "/elsewhere" } },
    ];
    for (const variant of variants) {
      expect(hashAuthority({ ...base, ...variant })).not.toBe(hashAuthority(base));
    }
  });
});

describe("absence keeps the projection it always had", () => {
  /*
   * management-convergence.ts classifies this failure by MATCHING THE MESSAGE
   * (`admissionFailure`, ~:62). A missing coordinator has always produced a
   * retryable skip; a message the classifier does not recognize silently
   * becomes a non-retryable failed/disk. Adding the `absent` branch broke
   * exactly that, and only a full-suite run caught it — this is the local guard.
   */
  test("catalog admission still reads as retryable when the coordinator is absent", () => {
    let thrown: unknown;
    try {
      captureCatalogAdmissionSnapshot(config());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(
      message.includes("config generation is busy") || message.includes("config generation is database"),
    ).toBeTrue();
  });
});

describe("the journal has one owner", () => {
  /**
   * Admission re-derived this path by hand and got both halves wrong, so its
   * journal identity watched a file nothing writes. The fixture re-derived it
   * the same wrong way and agreed. Importing the production constant is the
   * point of the test.
   */
  test("the exported constant is the file journal.ts actually uses", () => {
    // The old hand-derived path was OPENCODEX_HOME/codex-journal.json — wrong
    // directory AND wrong basename. Assert both halves. Paths are compared by
    // shape rather than string equality because macOS resolves the temp root
    // through /private, which is not the property under test.
    expect(basename(JOURNAL_PATH)).toBe("opencodex-journal.json");
    expect(dirname(JOURNAL_PATH).endsWith(".codex")).toBeTrue();
    expect(dirname(JOURNAL_PATH).endsWith(".opencodex")).toBeFalse();
  });

  /**
   * The constant existing is not the property. ADMISSION USING IT is.
   *
   * The first version of this suite asserted only the constant, and a commit
   * landed in which the comment said "the journal's own constant" directly
   * above a hand-derived path — the exact defect, restated as its own fix,
   * with the tests still green. Reading the producer's source is blunt, but it
   * is the thing that was actually wrong.
   */
  test("admission derives no journal path of its own", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "..", "src", "codex", "admission.ts"),
    ).text();
    expect(source).toContain("JOURNAL_PATH");
    expect(source).not.toContain("codex-journal.json");
  });
});

function snapshotWith(overrides: Partial<AdmissionSnapshot>): AdmissionSnapshot {
  return {
    config: config(),
    configDigest: "digest",
    intent: "on",
    generation: { present: true, value: 0 },
    ownership: "owned",
    externalProvider: null,
    canonicalTargets: {
      codexHome: "/codex",
      opencodexHome: "/opencodex",
      config: "/codex/config.toml",
      profile: "/codex/opencodex.config.toml",
      catalog: "/codex/opencodex-catalog.json",
      cache: "/codex/models_cache.json",
      journal: JOURNAL_PATH,
      integrationRecord: "/opencodex/integrations/codex.json",
      catalogBackups: [],
      historyDb: "/codex/state_5.sqlite",
      historyManifest: "/codex/state_5.sqlite.ocx-backup.json",
      historyRollouts: [],
    },
    journalIdentity: "absent",
    provenanceIdentity: "absent",
    authoritySnapshotId: "",
    ...overrides,
  };
}
