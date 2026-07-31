# 030 — WP3: region-aware Alibaba provider recovery (issue #457)

History, the refused override fix, the registry asymmetry, and the full
provider-reference inventory: `002_research_alibaba_region_split.md`.
The reference rewriter this phase consumes: `020_wp2_provider_id_rewrite.md`.
This document is the implementation design.

## What this phase does

Repair a config whose `alibaba-token-plan` entry holds an international
endpoint, by moving it to `alibaba-token-plan-intl` — the id whose registry
entry actually serves that endpoint — and rewriting every reference to the old
id. This is the shape the maintainer named when closing PR #459; teaching the
Beijing entry to serve Singapore is out of scope and explicitly refused.

## Design

Two modules, mirroring the OpenAI tier migration: a pure projection and a
startup wrapper that backs up before saving. The reference rewriter already
shipped in WP2. The projection is pure so the failure mode that matters here —
losing config — is testable without touching a filesystem.

### NEW `src/providers/alibaba-region-migration.ts`

```ts
import { ALIBABA_INTL_BASE_URL_CHOICES } from "./base-url-choices";
import { providerConfigSeed } from "./derive";
import { PROVIDER_REGISTRY } from "./registry";
import { rewriteProviderReferences } from "./provider-id-rewrite";
import type { OcxConfig, OcxProviderConfig } from "../types";

const BEIJING_ID = "alibaba-token-plan";
const INTL_ID = "alibaba-token-plan-intl";

/**
 * Credentials and switches the user owns directly. Everything else on the moved
 * row is registry-derived Beijing metadata (`ocx provider add` and the GUI persist
 * it, and registry enrichment only fills absent fields) and must NOT travel to the
 * international id — carrying it would leave the intl provider serving Singapore
 * while advertising the six-model Beijing Personal Edition catalog.
 *
 * `baseUrl` is carried deliberately: the migration only fires for a URL that
 * `ALIBABA_INTL_BASE_URL_CHOICES` recognises, so it is nonblank and
 * placeholder-free and satisfies the override guard at `src/router.ts:227`.
 * `authMode` is NOT carried — both entries are key-auth, and the seed's value is
 * the one that matches the destination's registry contract.
 * `liveModels` IS carried: it is directly user-editable through
 * `src/server/management/provider-routes.ts:231`, so resetting it to the seed's
 * `false` would silently undo a deliberate choice.
 * `defaultModel` and `note` are user-editable too
 * (`provider-routes.ts:197`) and are handled below rather than dropped.
 */
const USER_OWNED_FIELDS = ["apiKey", "apiKeyPool", "disabled", "baseUrl", "allowPrivateNetwork", "liveModels"] as const;

export interface AlibabaRegionMigrationProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

const normalize = (url: string): string => url.trim().replace(/\/+$/, "").toLowerCase();

/** True when the saved URL is one the international entry actually serves. */
function isInternationalEndpoint(baseUrl: string): boolean {
  return ALIBABA_INTL_BASE_URL_CHOICES.some(
    choice => choice.baseUrl && normalize(choice.baseUrl) === normalize(baseUrl),
  );
}

/**
 * Seed the destination from the international registry entry, then overlay only
 * what the user owns. `providerConfigSeed` (`src/providers/derive.ts:102`) is the
 * same function `ocx provider add` uses, so the migrated row is indistinguishable
 * from one the user had created against the international provider directly —
 * default model, model list, `liveModels: false`, context windows, modality maps
 * and reasoning metadata all come from the intl contract.
 */
function buildIntlRow(source: OcxProviderConfig): OcxProviderConfig {
  const entry = PROVIDER_REGISTRY.find(e => e.id === INTL_ID);
  // Fail fast rather than fabricate a row: a missing registry entry means the
  // destination this migration targets no longer exists.
  if (!entry) throw new Error(`registry entry "${INTL_ID}" not found; cannot migrate "${BEIJING_ID}"`);
  const seeded = providerConfigSeed(entry);
  // `OcxProviderConfig` has no index signature, so the write goes through
  // `unknown` — a direct `as Record<string, unknown>` is TS2352 under strict.
  const writable = seeded as unknown as Record<string, unknown>;
  const readable = source as unknown as Record<string, unknown>;
  for (const field of USER_OWNED_FIELDS) {
    if (readable[field] !== undefined) writable[field] = readable[field];
  }
  const servable = new Set(entry.models ?? []);
  // A user-chosen default survives only when the destination can actually serve it;
  // otherwise the international default (already on the seed) stands.
  if (source.defaultModel && servable.has(source.defaultModel)) seeded.defaultModel = source.defaultModel;
  // Same rule for the allowlist. Handled here, where the destination catalog is
  // known — never by the generic reference rewriter.
  const selected = source.selectedModels?.filter(id => servable.has(id));
  if (selected && selected.length > 0) seeded.selectedModels = selected;
  else delete seeded.selectedModels;
  // A note the user wrote is theirs; the registry's own note is replaced by the seed.
  // `providerConfigSeed` does not carry `note`, so seed the destination's registry
  // note explicitly, then let a genuinely user-authored note win. Comparing against
  // the SOURCE registry note is what distinguishes "the user typed this" from
  // "the Beijing entry's stock note came along for the ride".
  const beijingNote = PROVIDER_REGISTRY.find(e => e.id === BEIJING_ID)?.note;
  if (entry.note) seeded.note = entry.note;
  if (source.note && source.note !== beijingNote) seeded.note = source.note;
  return seeded;
}
```

The projection itself:

```ts
export function projectAlibabaRegionMigration(config: OcxConfig): AlibabaRegionMigrationProjection {
  const beijing = config.providers[BEIJING_ID];
  const savedBaseUrl = typeof beijing?.baseUrl === "string" ? beijing.baseUrl : "";
  if (!beijing || !savedBaseUrl || !isInternationalEndpoint(savedBaseUrl)) {
    return { config, changed: false, warnings: [] };
  }
  if (config.providers[INTL_ID]) {
    return {
      config,
      changed: false,
      warnings: [
        `provider "${BEIJING_ID}" is configured with an international endpoint, but "${INTL_ID}" `
        + `already exists. Both were left untouched: merging two credential sets is not a decision `
        + `this migration can make. Move the key to "${INTL_ID}" and delete the unused entry.`,
      ],
    };
  }

  const projected = structuredClone(config);
  delete projected.providers[BEIJING_ID];
  projected.providers[INTL_ID] = buildIntlRow(beijing);
  const { changed: rewritten, collisions } = rewriteProviderReferences(projected, BEIJING_ID, INTL_ID);
  // A destination key that already holds a value is the same class of problem as a
  // destination provider row that already exists: merging is a user decision. Abort
  // on the ORIGINAL config rather than leave a half-migrated one.
  if (collisions.length > 0) {
    return {
      config,
      changed: false,
      warnings: [
        `provider "${BEIJING_ID}" needs to move to "${INTL_ID}", but ${collisions.join(", ")} `
        + `already hold values for the destination. Nothing was changed: choosing which value `
        + `survives is not a decision this migration can make. Resolve those entries and restart.`,
      ],
    };
  }

  return {
    config: projected,
    changed: true,
    warnings: [
      `moved provider "${BEIJING_ID}" to "${INTL_ID}": its saved endpoint is the international one, `
      + `which the Beijing entry cannot serve. ${rewritten} reference(s) were re-pointed; the `
      + `international model catalog now applies.`,
    ],
  };
}
```

### NEW `src/providers/alibaba-region-startup.ts`

```ts
import type { OcxConfig } from "../types";
import { saveConfig } from "../config";
import { backupConfigBeforeAlibabaRegionMigration } from "./alibaba-region-backup";
import { projectAlibabaRegionMigration } from "./alibaba-region-migration";

export interface AlibabaRegionStartupDeps {
  project: typeof projectAlibabaRegionMigration;
  backup: () => void;
  save: (config: OcxConfig) => void;
}

export function runAlibabaRegionStartupMigration(
  config: OcxConfig,
  deps: AlibabaRegionStartupDeps = {
    project: projectAlibabaRegionMigration,
    backup: () => { backupConfigBeforeAlibabaRegionMigration(); },
    save: saveConfig,
  },
): OcxConfig {
  const projection = deps.project(config);
  // Warnings are emitted even on a no-op: the collision case IS the warning.
  for (const warning of projection.warnings) console.warn(`[alibaba-region-migration] ${warning}`);
  if (!projection.changed) return projection.config;
  // Strictly before the save: the snapshot must describe the config as it was.
  deps.backup();
  deps.save(projection.config);
  return projection.config;
}
```

### NEW `src/providers/alibaba-region-backup.ts`

Relying on the OpenAI tier backup was tried and rejected on audit, correctly:
`runOpenAiTierStartupMigration` returns before backing up whenever its own
projection is unchanged (`src/providers/openai-tier-startup.ts:22`), which is the
*normal* state for an installed config. So in the common case an Alibaba
migration would run with no snapshot at all, or with a stale
`.pre-openai-tiers-v2.bak` describing an unrelated historical config. An
automatic migration that deletes a provider row and rewrites credentials must
leave the user a way back.

What is *not* done is extracting the OpenAI mechanism — that refactor was
rejected twice for good reason (`src/config.ts:231` onward is entangled with
`original`, `_atomicSeq`, and OpenAI-named error types). This phase writes a
small, self-contained snapshot instead. It needs far less than the OpenAI one:
there is no stale/rollback classification to make, because the migration is a
one-shot per config.

```ts
import { copyFileSync, existsSync, linkSync, readFileSync, rmSync } from "node:fs";
import { getConfigPath } from "../config";

export interface AlibabaBackupIO {
  exists: (path: string) => boolean;
  read: (path: string) => Buffer;
  copy: (source: string, destination: string) => void;
  /** Publish with no-replace semantics: fails with EEXIST if the destination exists. */
  publishNoReplace: (temp: string, destination: string) => void;
  remove: (path: string) => void;
}

const DEFAULT_IO: AlibabaBackupIO = {
  exists: existsSync,
  read: path => readFileSync(path),
  copy: (source, destination) => copyFileSync(source, destination),
  publishNoReplace: linkSync,
  remove: path => rmSync(path, { force: true }),
};

export class AlibabaBackupIntegrityError extends Error {}

/**
 * Immutable pre-migration snapshot of `config.json`.
 *
 * Written to a temp file first and published by `link`, which fails with EEXIST
 * rather than replacing. `COPYFILE_EXCL` alone was rejected on audit: it makes
 * *creation* exclusive but not *publication* atomic, so a crash mid-copy can
 * leave a truncated destination that the next run would happily accept as a
 * valid rollback point. Copy-then-link means a published snapshot is always a
 * complete one.
 *
 * An existing snapshot is NOT required to equal the current config. Demanding
 * that was tempting — this runs before `save`, so the config on disk is still
 * unmigrated — but the equality rule has a false positive that would brick a
 * working install: a run that created the snapshot and then aborted for an
 * unrelated reason (a collision, a crash after backup) leaves a perfectly valid
 * snapshot; the user then edits `config.json` legitimately, and every subsequent
 * start would throw out of `startServer` and refuse to boot. A safety net must
 * never become the thing that stops the product.
 *
 * So an existing snapshot is reused as-is. Publication carries the integrity
 * guarantee instead: a snapshot only becomes visible through `link` after its
 * bytes were verified, so a published snapshot is complete by construction and a
 * crashed run leaves nothing but an orphan temp file.
 *
 * Deliberately not built on `backupConfigBeforeOpenAiTierMigration` — that
 * function's stale/rollback classification exists for a repeatable migration and
 * would be wrong here.
 */
export function backupConfigBeforeAlibabaRegionMigration(
  configPath = getConfigPath(),
  io: AlibabaBackupIO = DEFAULT_IO,
): "absent" | "created" | "reused" {
  if (!io.exists(configPath)) return "absent";
  const backup = `${configPath}.pre-alibaba-region-v1.bak`;
  // The earliest snapshot is the most valuable one: it predates every migration
  // this config has been through.
  if (io.exists(backup)) return "reused";

  const source = io.read(configPath);
  const temp = `${backup}.${process.pid}.tmp`;
  try {
    io.copy(configPath, temp);
    // Verify before publishing: a short copy must never become the snapshot.
    if (!io.read(temp).equals(source)) {
      throw new AlibabaBackupIntegrityError(`failed to write a complete backup to ${temp}`);
    }
    io.publishNoReplace(temp, backup);
    return "created";
  } catch (error) {
    // Another process published between our `exists` check and the link. Its
    // snapshot went through the same copy-verify-link sequence, so it is complete
    // by construction — the only way to reach this path is another instance of
    // this function, since nothing else writes this filename. Reading it back to
    // re-verify would only re-introduce the equality rule rejected above.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "reused";
    throw error;
  } finally {
    io.remove(temp);
  }
}
```

### Where the integrity guarantee actually comes from

Worth stating plainly, because two audit rounds pushed in opposite directions
here. The guarantee is **publication**, not validation:

| Failure | Outcome |
|---------|---------|
| Crash while copying | Only an orphan temp exists; the backup path is untouched, and the next run creates it properly |
| Short/partial copy | Caught by the byte comparison before `link`; never published |
| Two processes racing | Both copy-verify; one links, the other gets `EEXIST` and reuses a snapshot produced by the same verified path |
| Snapshot exists from an earlier run | Reused as-is — it predates every migration, which is exactly what a rollback point should be |

No reachable sequence publishes an incomplete snapshot, so no reader-side
validation is needed — and adding one would resurrect the false positive that
refused to boot the proxy after a legitimate config edit.

`src/config.ts` is **not modified**: `getConfigPath` is already exported.

### Failure posture

`runAlibabaRegionStartupMigration` does not catch, and nothing between it and
`startServer` does either — `src/cli/index.ts:176` retries only on
`EADDRINUSE` and rethrows everything else. So a throw here does not merely skip
the migration; it stops the proxy from starting.

That is the right trade for a genuine *write* failure — an incomplete backup
means the migration must not proceed, and proceeding silently would be worse
than not booting. It is emphatically the wrong trade for a *validation opinion*
about a pre-existing file, which is why the equality rule was abandoned above.
The only throws left are real IO failures: disk full, permissions, a short copy.
Those already prevent a healthy start for other reasons.

Tests, `tests/alibaba-region-backup.test.ts`, against a real temp directory
because the value of this module is its filesystem semantics:

```ts
import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlibabaBackupIntegrityError,
  backupConfigBeforeAlibabaRegionMigration,
} from "../src/providers/alibaba-region-backup";

test("absent source produces no backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-bak-"));
  try {
    expect(backupConfigBeforeAlibabaRegionMigration(join(dir, "config.json"))).toBe("absent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("creates a snapshot, then never replaces it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-bak-"));
  const configPath = join(dir, "config.json");
  const backupPath = `${configPath}.pre-alibaba-region-v1.bak`;
  try {
    writeFileSync(configPath, '{"before":true}', "utf8");
    expect(backupConfigBeforeAlibabaRegionMigration(configPath)).toBe("created");
    expect(readFileSync(backupPath, "utf8")).toBe('{"before":true}');
    expect(backupConfigBeforeAlibabaRegionMigration(configPath)).toBe("reused");
    expect(readFileSync(backupPath, "utf8")).toBe('{"before":true}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an existing snapshot is kept even after the config legitimately changes", () => {
  // The false positive an equality rule would have created: a snapshot from an
  // earlier aborted run plus ordinary later edits must not stop the proxy.
  const dir = mkdtempSync(join(tmpdir(), "ocx-bak-"));
  const configPath = join(dir, "config.json");
  const backupPath = `${configPath}.pre-alibaba-region-v1.bak`;
  try {
    writeFileSync(configPath, '{"before":true}', "utf8");
    expect(backupConfigBeforeAlibabaRegionMigration(configPath)).toBe("created");
    writeFileSync(configPath, '{"edited-by-the-user":true}', "utf8");
    expect(backupConfigBeforeAlibabaRegionMigration(configPath)).toBe("reused");
    // The earliest snapshot survives: it predates every migration.
    expect(readFileSync(backupPath, "utf8")).toBe('{"before":true}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a short copy is never published", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-bak-"));
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(configPath, '{"before":true}', "utf8");
    expect(() => backupConfigBeforeAlibabaRegionMigration(configPath, {
      exists: existsSync,
      read: path => readFileSync(path),
      copy: (_source, destination) => { writeFileSync(destination, '{"bef', "utf8"); },
      publishNoReplace: linkSync,
      remove: path => rmSync(path, { force: true }),
    })).toThrow(AlibabaBackupIntegrityError);
    expect(existsSync(`${configPath}.pre-alibaba-region-v1.bak`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed copy leaves no snapshot and no temp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-bak-"));
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(configPath, '{"before":true}', "utf8");
    const removed: string[] = [];
    expect(() => backupConfigBeforeAlibabaRegionMigration(configPath, {
      exists: existsSync,
      read: path => readFileSync(path),
      copy: () => { throw new Error("disk full"); },
      publishNoReplace: linkSync,
      remove: path => { removed.push(path); rmSync(path, { force: true }); },
    })).toThrow("disk full");
    expect(existsSync(`${configPath}.pre-alibaba-region-v1.bak`)).toBe(false);
    expect(removed).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

```

The "a backup failure must prevent the save" case belongs at the startup layer
and lives in `tests/alibaba-region-startup.test.ts` below, where the startup
imports and fixtures already exist.

### MODIFY `src/server/index.ts`

Line 238, before:

```ts
  const config = runOpenAiTierStartupMigration(loadConfig());
```

After:

```ts
  const config = runAlibabaRegionStartupMigration(runOpenAiTierStartupMigration(loadConfig()));
```

plus the import beside the existing one at `src/server/index.ts:22`.

## Regression tests

### NEW `tests/alibaba-region-migration.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { projectAlibabaRegionMigration } from "../src/providers/alibaba-region-migration";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

const INTL_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

/** A config exhibiting the #457 mismatch: Beijing id, international endpoint. */
function migratableConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "alibaba-token-plan",
    providers: {
      "alibaba-token-plan": { adapter: "openai-chat", apiKey: "sk-intl-key", baseUrl: INTL_URL },
    },
  } as unknown as OcxConfig;
}

/** The same mismatch, but the destination provider row already exists. */
function collidingConfig(): OcxConfig {
  const config = migratableConfig();
  config.providers["alibaba-token-plan-intl"] = { adapter: "openai-chat", apiKey: "sk-other" } as never;
  return config;
}

test("moves a Beijing entry holding an international endpoint", () => {
  const projection = projectAlibabaRegionMigration({
    port: 10100,
    defaultProvider: "alibaba-token-plan",
    providers: {
      "alibaba-token-plan": {
        adapter: "openai-chat",
        apiKey: "sk-intl-key",
        baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        models: ["qwen3.8-max-preview", "qwen3.7-max"],   // Beijing catalog, must NOT travel
        defaultModel: "qwen3.8-max-preview",
      },
    },
  } as unknown as OcxConfig);

  expect(projection.changed).toBe(true);
  expect(projection.config.providers["alibaba-token-plan"]).toBeUndefined();
  const moved = projection.config.providers["alibaba-token-plan-intl"]!;
  expect(moved.apiKey).toBe("sk-intl-key");
  expect(projection.config.defaultProvider).toBe("alibaba-token-plan-intl");
  // The Beijing catalog did not come along: the intl registry contract applies,
  // so a Team-Edition-only model is present and routes.
  expect(moved.models).toContain("kimi-k2.7-code");
  expect(routeModel(projection.config, "alibaba-token-plan-intl/kimi-k2.7-code").provider.baseUrl)
    .toContain("ap-southeast-1");
});

test("the migrated config survives a reload", () => {
  // A stale combo target would fail validation and make loadConfig fall back to
  // defaults (src/config.ts:764) — this is the assertion that catches it.
  const home = mkdtempSync(join(tmpdir(), "ocx-alibaba-"));
  const projection = projectAlibabaRegionMigration({
    port: 10100,
    defaultProvider: "alibaba-token-plan",
    providers: {
      "alibaba-token-plan": {
        adapter: "openai-chat",
        apiKey: "sk-intl-key",
        baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      },
    },
    combos: { fast: { targets: [{ provider: "alibaba-token-plan", model: "qwen3.7-max" }] } },
  } as unknown as OcxConfig);

  const prev = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    saveConfig(projection.config);
    const reloaded = loadConfig();
    expect(reloaded.providers["alibaba-token-plan-intl"]?.apiKey).toBe("sk-intl-key");
    expect(reloaded.combos?.fast?.targets[0]?.provider).toBe("alibaba-token-plan-intl");
  } finally {
    process.env.OPENCODEX_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a genuine Beijing config is untouched", () => {
  for (const baseUrl of ["https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", undefined]) {
    const config = {
      port: 10100,
      defaultProvider: "alibaba-token-plan",
      providers: { "alibaba-token-plan": { adapter: "openai-chat", apiKey: "sk-cn", ...(baseUrl ? { baseUrl } : {}) } },
    } as unknown as OcxConfig;
    const before = structuredClone(config);
    const projection = projectAlibabaRegionMigration(config);
    expect(projection.changed).toBe(false);
    expect(projection.warnings).toEqual([]);
    expect(projection.config).toEqual(before);
  }
});

test("refuses to merge when the intl entry exists, and says why", () => {
  const config = {
    port: 10100,
    defaultProvider: "alibaba-token-plan",
    providers: {
      "alibaba-token-plan": { adapter: "openai-chat", apiKey: "sk-a", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" },
      "alibaba-token-plan-intl": { adapter: "openai-chat", apiKey: "sk-b" },
    },
  } as unknown as OcxConfig;
  const before = structuredClone(config);
  const projection = projectAlibabaRegionMigration(config);
  expect(projection.changed).toBe(false);
  expect(projection.config).toEqual(before);
  expect(projection.warnings).toHaveLength(1);
  expect(projection.warnings[0]).toContain("already exists");
});

test("is idempotent across repeated startups", () => {
  const first = projectAlibabaRegionMigration(migratableConfig());
  const second = projectAlibabaRegionMigration(first.config);
  expect(first.changed).toBe(true);
  expect(second.changed).toBe(false);
  expect(second.config).toEqual(first.config);
});

test("aborts without changing anything when a destination key is occupied", () => {
  const config = migratableConfig();
  config.providerContextCaps = { "alibaba-token-plan": 500_000, "alibaba-token-plan-intl": 900_000 };
  const before = structuredClone(config);
  const projection = projectAlibabaRegionMigration(config);
  expect(projection.changed).toBe(false);
  expect(projection.config).toEqual(before);
  expect(projection.warnings[0]).toContain("providerContextCaps.alibaba-token-plan-intl");
});

test("carries liveModels and a user-authored note, but not the Beijing catalog", () => {
  const config = migratableConfig();
  config.providers["alibaba-token-plan"]!.liveModels = true;
  config.providers["alibaba-token-plan"]!.note = "my own note";
  const moved = projectAlibabaRegionMigration(config).config.providers["alibaba-token-plan-intl"]!;
  expect(moved.liveModels).toBe(true);
  expect(moved.note).toBe("my own note");
  expect(moved.models).toContain("kimi-k2.7-code");
});
```

### NEW `tests/alibaba-region-startup.test.ts`

```ts
import { expect, test } from "bun:test";
import { AlibabaBackupIntegrityError } from "../src/providers/alibaba-region-backup";
import { projectAlibabaRegionMigration } from "../src/providers/alibaba-region-migration";
import { runAlibabaRegionStartupMigration } from "../src/providers/alibaba-region-startup";
import type { OcxConfig } from "../src/types";

// Same two fixtures as tests/alibaba-region-migration.test.ts; duplicated rather
// than shared because tests/ is flat and a helper module for two callers is more
// indirection than it saves.
const INTL_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

function migratableConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "alibaba-token-plan",
    providers: {
      "alibaba-token-plan": { adapter: "openai-chat", apiKey: "sk-intl-key", baseUrl: INTL_URL },
    },
  } as unknown as OcxConfig;
}

function collidingConfig(): OcxConfig {
  const config = migratableConfig();
  config.providers["alibaba-token-plan-intl"] = { adapter: "openai-chat", apiKey: "sk-other" } as never;
  return config;
}

test("backs up strictly before saving, exactly once, when the projection changed", () => {
  const order: string[] = [];
  const saved: OcxConfig[] = [];
  const result = runAlibabaRegionStartupMigration(migratableConfig(), {
    project: projectAlibabaRegionMigration,
    backup: () => { order.push("backup"); },
    save: config => { order.push("save"); saved.push(config); },
  });
  expect(order).toEqual(["backup", "save"]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toBe(result);
  expect(result.providers["alibaba-token-plan-intl"]).toBeDefined();
});

test("a no-op never backs up or saves, but a collision still warns", () => {
  const order: string[] = [];
  const saved: OcxConfig[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    runAlibabaRegionStartupMigration(collidingConfig(), {
      project: projectAlibabaRegionMigration,
      backup: () => { order.push("backup"); },
      save: config => { saved.push(config); },
    });
  } finally {
    console.warn = originalWarn;
  }
  expect(order).toEqual([]);
  expect(saved).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("[alibaba-region-migration]");
});

test("a backup failure prevents the migration from saving", () => {
  // The fail-closed posture: no rollback point, no credential rewrite. The throw
  // propagates out of startServer, which is the same stance the OpenAI tier
  // migration takes.
  const saved: OcxConfig[] = [];
  expect(() => runAlibabaRegionStartupMigration(migratableConfig(), {
    project: projectAlibabaRegionMigration,
    backup: () => { throw new AlibabaBackupIntegrityError("disk full"); },
    save: config => { saved.push(config); },
  })).toThrow(AlibabaBackupIntegrityError);
  expect(saved).toEqual([]);
});
```

## Activation scenarios (C-ACTIVATION-GROUNDING-01)

| Branch | Reachable from | C triggers it via | Observable effect |
|--------|----------------|-------------------|-------------------|
| migrate | a config migrated across regions (the #457 report) | migration test 1 | provider moved, routing hits `ap-southeast-1` |
| provider-row collision | user created the intl entry manually before restarting | migration test "refuses to merge…" | config unchanged, one named warning |
| destination-key collision | caps or Desktop routes set on both ids | migration test "aborts without changing anything…" | config deep-equal to before, warning names the site |
| no-op (genuine Beijing) | every ordinary Beijing user, every start | migration test "a genuine Beijing config is untouched" | config deep-equal, no warning, no save |
| idempotence | the second and every later start | migration test "is idempotent…" | `changed=false` |
| reload survival | migrated config that used a combo | migration test "survives a reload" | `loadConfig` returns the migrated row, not defaults |
| user-owned field carry | user enabled `liveModels` or wrote a note | migration test "carries liveModels…" | both survive, Beijing catalog does not |

## Scope boundary

IN: `src/providers/alibaba-region-migration.ts`,
`src/providers/alibaba-region-startup.ts`,
`src/providers/alibaba-region-backup.ts`, one line plus one import in
`src/server/index.ts`, and three new test files.

`src/providers/provider-id-rewrite.ts` shipped in WP2 and is only consumed here.
`src/config.ts` is not modified: the backup module needs only the already-exported
`getConfigPath`, and the OpenAI backup mechanism is deliberately left alone.

OUT: touching either registry entry (the refused fix); the GUI; splitting
`apiKeyPool` between regions; and the
`config.json.bak-before-alibaba-provider-rename-*` backups named in #457 — no
code in this repository produces that filename, so the original rename remains
unattributed and this phase repairs the end state rather than the unknown path
that produced it.

## Accept criteria

- Every rewrite test fails on the pre-change tree (module absent) and passes after.
- A genuine Beijing config and an already-migrated config are byte-identical
  after projection, proven by a second projection reporting `changed=false`.
- The migrated config reloads through `loadConfig` without falling back to
  defaults, and `routeModel` resolves the international endpoint.
- The collision case changes nothing and emits exactly one actionable warning.
- Backup strictly precedes save, and neither runs on a no-op.
- Full gates green.
