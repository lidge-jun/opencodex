import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPORT_CLIENTS, type ExportModel } from "../src/clients/config-export";
import { PARSE_FAILED, fileIO, loadTarget, parseConfig } from "../src/integrations/config-io";
import {
  canonicalContribution,
  fingerprint,
  writeRecord,
  type OwnershipRecord,
} from "../src/integrations/ownership";
import { INTEGRATION_CLIENT_IDS, isLoopbackOnly } from "../src/integrations/registry";
import { classifyIntegration, readIntegrationState } from "../src/integrations/state";
import { createIntegrationStateStore } from "../src/integrations/store";
import type { OcxConfig } from "../src/types";

/**
 * Activation coverage for devlog/_fin/260802_client_toggle_api/021 §6.
 *
 * Every fixture is built DIRECTLY on disk — write a config, write a record,
 * classify — because the writer does not exist until WP3 and a phase that
 * cannot verify itself is not a phase boundary.
 */
const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
];

const CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

let home: string;
let stateRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-integrations-state-"));
  stateRoot = join(home, "state", "integrations");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function store() {
  return createIntegrationStateStore(stateRoot);
}

function input(overrides: Partial<Parameters<typeof readIntegrationState>[0]> = {}) {
  return {
    clientId: "pi" as const,
    models: MODELS,
    config: CONFIG,
    port: 10100,
    home,
    store: store(),
    ...overrides,
  };
}

/** Write a Pi config carrying our provider entry, and return its exact text. */
function seedOurConfig(models: readonly ExportModel[] = MODELS): string {
  const document = EXPORT_CLIENTS.pi.build({
    baseUrl: "http://127.0.0.1:10100/v1",
    models,
    config: CONFIG,
  });
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const path = join(home, ".pi", "agent", "models.json");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(path, text);
  return text;
}

function seedRecord(
  fileText: string,
  blockOverride?: string,
  recordedModels: readonly ExportModel[] = MODELS,
): OwnershipRecord {
  const contribution = EXPORT_CLIENTS.pi.buildContribution({
    baseUrl: "http://127.0.0.1:10100/v1",
    models: recordedModels,
    config: CONFIG,
  });
  const record: OwnershipRecord = {
    clientId: "pi",
    configPath: join(home, ".pi", "agent", "models.json"),
    fileFingerprint: fingerprint(fileText),
    blockFingerprint: blockOverride ?? fingerprint(canonicalContribution(contribution)),
    fragmentPaths: contribution.fragments.map(fragment => fragment.path),
    appliedAt: "2026-08-02T00:00:00.000Z",
    opId: "seeded-op",
  };
  writeRecord(record, stateRoot);
  return record;
}

describe("the five states, each triggered directly", () => {
  test("absent: a clean config with no entry of ours", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "models.json"), "{}\n");
    expect(readIntegrationState(input()).state).toBe("absent");
  });

  test("absent: no file at all", () => {
    expect(readIntegrationState(input()).state).toBe("absent");
  });

  test("current: our entry, untouched, equal to a fresh build", () => {
    seedRecord(seedOurConfig());
    const status = readIntegrationState(input());
    expect(status.state).toBe("current");
    expect(status.lastOpId).toBe("seeded-op");
  });

  test("stale: untouched, but no longer what we would write now", () => {
    // The file still carries the contribution from the previous catalog. The
    // desired contribution has moved on, so this is drift rather than a user
    // edit to our fragment.
    const previousModels: ExportModel[] = [
      { namespaced: "anthropic/claude-opus-4-7", provider: "anthropic", id: "claude-opus-4-7", contextWindow: 200_000 },
    ];
    const text = seedOurConfig(previousModels);
    seedRecord(text, undefined, previousModels);
    expect(readIntegrationState(input()).state).toBe("stale");
  });

  test("conflict: an owned fragment changed after we wrote it", () => {
    const text = seedOurConfig();
    seedRecord(text);
    // A user edit inside our provider block must still win over the catalog
    // drift checks, even though unrelated siblings are allowed to change.
    const editedDocument = JSON.parse(text) as {
      providers: Record<string, Record<string, unknown>>;
    };
    editedDocument.providers.opencodex!.baseUrl = "http://user-edited.invalid/v1";
    writeFileSync(
      join(home, ".pi", "agent", "models.json"),
      `${JSON.stringify(editedDocument, null, 2)}\n`,
    );
    const status = readIntegrationState(input());
    expect(status.state).toBe("conflict");
    expect(status.reason).toBe("foreign-edit");
  });

  test("conflict: our key exists with no ownership record at all", () => {
    seedOurConfig();
    const status = readIntegrationState(input());
    expect(status.state).toBe("conflict");
    expect(status.reason).toBe("unowned-key");
  });

  test("unsafe: the config path is a directory", () => {
    mkdirSync(join(home, ".pi", "agent", "models.json"), { recursive: true });
    const status = readIntegrationState(input());
    expect(status.state).toBe("unsafe");
    expect(status.reason).toBe("not-regular-file");
  });

  test("unsafe: the file cannot be parsed", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "models.json"), "{{{\n");
    const status = readIntegrationState(input());
    expect(status.state).toBe("unsafe");
    expect(status.reason).toBe("unparseable");
  });
});

describe("ordering guards", () => {
  test("an unreadable file is never reported as absent", () => {
    // stat says file, read fails: a real file we cannot see.
    const io = {
      ...fileIO(),
      statKind: () => "file" as const,
      readText: () => ({ kind: "failed" as const, code: "EACCES" }),
      appendJournal: () => {},
      putRecord: () => {},
      dropRecord: () => {},
    };
    const status = readIntegrationState(input({ io }));
    expect(status.state).toBe("unsafe");
    expect(status.state).not.toBe("absent");
  });

  test("a foreign edit is never reported as stale", () => {
    // Both axes differ: the owned fragment changed AND the contribution moved
    // on. The foreign edit must win, because reporting drift here would let a
    // later disable delete the user's change.
    const previousModels: ExportModel[] = [
      { namespaced: "anthropic/claude-opus-4-7", provider: "anthropic", id: "claude-opus-4-7", contextWindow: 200_000 },
    ];
    const text = seedOurConfig(previousModels);
    seedRecord(text, undefined, previousModels);
    const editedDocument = JSON.parse(text) as {
      providers: Record<string, Record<string, unknown>>;
    };
    editedDocument.providers.opencodex!.baseUrl = "http://user-edited.invalid/v1";
    writeFileSync(
      join(home, ".pi", "agent", "models.json"),
      `${JSON.stringify(editedDocument, null, 2)}\n`,
    );
    const status = readIntegrationState(input());
    expect(status.state).toBe("conflict");
    expect(status.reason).toBe("foreign-edit");
  });

  test("a stat failure is not absence either", () => {
    const io = {
      ...fileIO(),
      statKind: () => "failed" as const,
      appendJournal: () => {},
      putRecord: () => {},
      dropRecord: () => {},
    };
    expect(loadTarget(io, "/nowhere").ok).toBe(false);
  });

  /**
   * The DEFAULT io is what ships. Substituting a fake statKind proves the
   * classifier's ordering but would pass even if fileIO collapsed EACCES into
   * "missing" — so exercise the real implementation against a real
   * unreadable path.
   */
  test("the default IO reports a real unreadable file as failed, not missing", () => {
    const io = fileIO();
    const secret = join(home, "locked", "models.json");
    mkdirSync(join(home, "locked"), { recursive: true });
    writeFileSync(secret, "{}\n");
    chmodSync(join(home, "locked"), 0o000);
    try {
      const kind = io.statKind(secret);
      // Some CI users (root, or a filesystem without POSIX modes) can still
      // stat it; only assert the distinction where the OS actually enforces it.
      if (kind !== "file") {
        expect(kind).toBe("failed");
        expect(loadTarget(io, secret)).toEqual({ ok: false, why: "read-failed" });
      }
      // A genuinely absent path is the other side of the distinction.
      expect(io.statKind(join(home, "definitely-not-there"))).toBe("missing");
    } finally {
      chmodSync(join(home, "locked"), 0o700);
    }
  });

  /**
   * A record proves ownership of ONE file. This is the case that would let a
   * disable delete fragments from a file we never wrote.
   */
  test("a record from another config path never grants ownership here", () => {
    const text = seedOurConfig();
    const record = seedRecord(text);
    // Same client, same bytes, same fingerprints — different file. That happens
    // whenever HOME or a client's own *_HOME variable moves.
    writeRecord({ ...record, configPath: join(home, "elsewhere", "models.json") }, stateRoot);
    const status = readIntegrationState(input());
    expect(status.state).toBe("conflict");
    expect(status.reason).toBe("unowned-key");
  });

  /**
   * The records file is keyed by client, so a mismatched `clientId` inside the
   * entry only arises from a hand-edited or half-migrated store. It still must
   * not grant ownership: the writer would then remove fragments on behalf of a
   * client that never applied anything here.
   */
  test("a record whose clientId disagrees with its key never grants ownership", () => {
    const text = seedOurConfig();
    const record = seedRecord(text);
    writeFileSync(
      join(stateRoot, "records.json"),
      `${JSON.stringify({ pi: { ...record, clientId: "kimi" } }, null, 2)}\n`,
    );
    const status = readIntegrationState(input());
    expect(status.state).toBe("conflict");
    expect(status.reason).toBe("unowned-key");
  });

  /**
   * An unreadable memory is never permission to delete. A corrupt records file
   * means "we remember nothing", and our block on disk then reads as someone
   * else's — not as ours to overwrite or remove.
   */
  test("a corrupt records file fails closed to conflict, never to current", () => {
    const text = seedOurConfig();
    seedRecord(text);
    writeFileSync(join(stateRoot, "records.json"), "{ this is not json\n");
    const status = readIntegrationState(input());
    expect(status.state).toBe("conflict");
    expect(status.reason).toBe("unowned-key");
    // No stale provenance leaks out of a memory we could not read.
    expect(status.appliedAt).toBeUndefined();
    expect(status.lastOpId).toBeUndefined();
  });

  /**
   * Retention is derived from what is ON DISK. When the snapshot directory
   * cannot be inspected the status must say so (-1, degraded) instead of
   * reporting a reassuring zero.
   */
  test("an uninspectable snapshot directory reports degraded retention", () => {
    const bound = store();
    bound.captureSnapshot("pi", "op-1", "bytes\n");
    const snapshots = join(stateRoot, "snapshots");
    chmodSync(snapshots, 0o000);
    try {
      // Running as root defeats the permission bit; assert only where the OS
      // enforces it.
      if (bound.countSnapshots("pi") === null) {
        const status = readIntegrationState(input({ store: bound }));
        expect(status.snapshotCount).toBe(-1);
        expect(status.retentionDegraded).toBe(true);
      }
    } finally {
      chmodSync(snapshots, 0o700);
    }
  });
});

describe("classifier unit behavior", () => {
  const contribution = EXPORT_CLIENTS.pi.buildContribution({
    baseUrl: "http://127.0.0.1:10100/v1",
    models: MODELS,
    config: CONFIG,
  });

  test("a document whose container is an array is unsafe, not absent", () => {
    /*
     * This used to assert `absent`, on the reasoning that not throwing was
     * enough. It is not: `absent` authorizes an apply, and `setPath` replaces
     * a non-object container with `{}` on its way to our leaf — so a user with
     * `providers: []` (legal in their schema, not in ours) had it silently
     * replaced by an operation that reported success.
     */
    const result = classifyIntegration({
      fileText: "{}",
      fileIsRegular: true,
      parsed: { providers: [] },
      record: null,
      contribution,
    });
    expect(result).toEqual({ state: "unsafe", reason: "blocked-container" });
  });

  test("a scalar where a container belongs is unsafe too", () => {
    const result = classifyIntegration({
      fileText: "{}",
      fileIsRegular: true,
      parsed: { providers: "not-an-object" },
      record: null,
      contribution,
    });
    expect(result).toEqual({ state: "unsafe", reason: "blocked-container" });
  });

  test("an ordinary empty container is still absent, not blocked", () => {
    // The guard must not turn a normal first-time apply into a refusal.
    const result = classifyIntegration({
      fileText: "{}",
      fileIsRegular: true,
      parsed: { providers: {} },
      record: null,
      contribution,
    });
    expect(result.state).toBe("absent");
  });

  test("PARSE_FAILED short-circuits before any fragment lookup", () => {
    const result = classifyIntegration({
      fileText: "{{{",
      fileIsRegular: true,
      parsed: PARSE_FAILED,
      record: null,
      contribution,
    });
    expect(result).toEqual({ state: "unsafe", reason: "unparseable" });
  });

  test("parseConfig treats an empty file as an empty document, not a failure", () => {
    expect(parseConfig("", "json")).toEqual({});
    expect(parseConfig(null, "yaml")).toEqual({});
    expect(parseConfig("{{{", "json")).toBe(PARSE_FAILED);
  });

  test("fragment order does not change the contribution fingerprint", () => {
    const reversed = { ...contribution, fragments: [...contribution.fragments].reverse() };
    expect(canonicalContribution(reversed)).toBe(canonicalContribution(contribution));
  });
});

describe("ownership is scoped to recorded fragments", () => {
  const ownedValue = {
    baseUrl: "http://127.0.0.1:10100/v1",
    api: "openai-chat",
  };
  const ownedContribution = {
    clientId: "omp" as const,
    fragments: [{ path: ["providers", "opencodex"], value: ownedValue }],
  };
  const extraValue = {
    baseUrl: "https://freebuff.invalid/v1",
    api: "openai-chat",
  };
  const documentWithExtra = {
    providers: { opencodex: ownedValue, freebuff: extraValue },
  };
  const originalText = "providers:\n  opencodex:\n    baseUrl: http://127.0.0.1:10100/v1\n    api: openai-chat\n";
  const textWithExtra = `${originalText}  freebuff:\n    baseUrl: https://freebuff.invalid/v1\n    api: openai-chat\n`;
  const record: OwnershipRecord = {
    clientId: "omp",
    configPath: "/tmp/models.yml",
    // The extra provider was added after this record was written. The
    // classifier must not use this whole-file hash to claim our block changed.
    fileFingerprint: fingerprint(originalText),
    blockFingerprint: fingerprint(canonicalContribution(ownedContribution)),
    fragmentPaths: [["providers", "opencodex"]],
    appliedAt: "2026-08-02T00:00:00.000Z",
    opId: "seeded-op",
  };

  test("an unrelated extra fragment remains current", () => {
    const result = classifyIntegration({
      fileText: textWithExtra,
      fileIsRegular: true,
      parsed: documentWithExtra,
      record,
      contribution: ownedContribution,
    });

    expect(result).toEqual({ state: "current" });
  });

  test("an unrelated extra fragment remains stale when our catalog moves", () => {
    const newerContribution = {
      ...ownedContribution,
      fragments: [
        {
          ...ownedContribution.fragments[0],
          value: { ...ownedValue, model: "new-model" },
        },
      ],
    };
    const result = classifyIntegration({
      fileText: textWithExtra,
      fileIsRegular: true,
      parsed: documentWithExtra,
      record,
      contribution: newerContribution,
    });

    expect(result).toEqual({ state: "stale" });
  });

  test("modifying an owned fragment remains a conflict", () => {
    const editedDocument = {
      providers: {
        opencodex: { ...ownedValue, baseUrl: "http://user-edited.invalid/v1" },
        freebuff: extraValue,
      },
    };
    const result = classifyIntegration({
      fileText: `${JSON.stringify(editedDocument, null, 2)}\n`,
      fileIsRegular: true,
      parsed: editedDocument,
      record,
      contribution: ownedContribution,
    });

    expect(result).toEqual({ state: "conflict", reason: "foreign-edit" });
  });

  test("whole-document serializers still conflict on an unrelated source edit", () => {
    const piContribution = { ...ownedContribution, clientId: "pi" as const };
    const piRecord: OwnershipRecord = {
      ...record,
      clientId: "pi",
      configPath: "/tmp/pi-models.json",
      blockFingerprint: fingerprint(canonicalContribution(piContribution)),
    };
    const result = classifyIntegration({
      fileText: textWithExtra,
      fileIsRegular: true,
      parsed: documentWithExtra,
      record: piRecord,
      contribution: piContribution,
    });

    expect(result).toEqual({ state: "conflict", reason: "foreign-edit" });
  });
});

describe("installation detection is independent of config state", () => {
  test("installed is false when the client's directory is absent", () => {
    expect(readIntegrationState(input()).installed).toBe(false);
  });

  test("installed is true once the directory exists, even with no config", () => {
    mkdirSync(join(home, ".pi"), { recursive: true });
    const status = readIntegrationState(input());
    expect(status.installed).toBe(true);
    expect(status.state).toBe("absent");
  });
});

/**
 * The loopback set decides whether we write a config that 401s, so it is pinned
 * at the seam WP3 actually calls — not only on the export registry it reads
 * from. Rationale and the per-client table: 020 §1 amendment.
 */
describe("the loopback-only set is one fact, read through one seam", () => {
  test("omp, pi, kimi and gajae are loopback-only and nobody else is", () => {
    const loopbackOnly = INTEGRATION_CLIENT_IDS.filter(id => isLoopbackOnly(id));
    expect(loopbackOnly).toEqual(["pi", "omp", "kimi", "gajae"]);
  });

  test("the registry restates nothing — it reads the export spec", () => {
    for (const id of INTEGRATION_CLIENT_IDS) {
      expect(isLoopbackOnly(id)).toBe(EXPORT_CLIENTS[id].loopbackOnly);
    }
  });
});
