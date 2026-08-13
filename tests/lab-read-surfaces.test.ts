import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { handleLabCommand } from "../src/cli/lab";
import { skipsCodexShimAutoRestore } from "../src/cli/codex-shim-autorestore";
import {
  appendLabEvent,
  assignEventId,
  observationFromConformanceResult,
  persistConformanceResult,
  rebuildLabProjection,
  subjectIdForSubject,
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  LAB_PROJECTION_SPEC_VERSION,
  LAB_SQLITE_SCHEMA_VERSION,
} from "../src/lab";
import { createArtifactStore } from "../src/lab/artifacts/store";
import { resolveProtocolExecutionContext } from "../src/lab/conformance/executor";
import type { CaseRecord } from "../src/lab/conformance/types";
import { discoverScenarios, loadCaseAuthority } from "../src/lab/conformance/manifest";
import {
  InvalidCursorError,
  LabProjectionIncompatibleError,
  LabProjectionUnavailableError,
  LAB_QUERY_MAX_PAGE_SIZE,
  openLabReadConnection,
  queryLabArtifactByDigest,
  queryLabArtifacts,
  queryLabCatalogEntries,
  queryLabEventById,
  queryLabEvents,
  queryLabObservations,
  queryLabStatus,
  queryLabSubjectById,
  queryLabSubjects,
  queryLabVerdicts,
  sanitizePublicText,
} from "../src/lab/query";
import { encodeLabCursor, verdictCursor } from "../src/lab/query/cursor";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";

const HOMES: string[] = [];

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-cl04-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.OPENCODEX_HOME;
});

function withHome<T>(fn: (home: string) => T): T {
  const home = tempHome();
  process.env.OPENCODEX_HOME = home;
  return fn(home);
}

function syntheticPassResult(caseRecord: CaseRecord) {
  return {
    scenarioId: caseRecord.id,
    suite: caseRecord.suite,
    passed: true,
    classification: "inconclusive" as const,
    assertionResults: caseRecord.assertions.map((a) => ({
      id: a.id,
      operator: a.operator,
      required: a.required,
      passed: true,
      observedSummary: "ok",
    })),
    diagnostics: [],
    executionContext: resolveProtocolExecutionContext(caseRecord),
    startedAt: 999,
    completedAt: 1000,
  };
}

function seedProjection(home: string, suiteId = "responses-core") {
  const authority = loadCaseAuthority();
  const scenarios = discoverScenarios(authority, [suiteId]);
  if (scenarios.length === 0) {
    throw new Error(`No Compatibility Lab scenarios discovered for suite ${suiteId}`);
  }
  let recordedAt = 1_700_000_000_000;
  for (const caseRecord of scenarios.slice(0, 2)) {
    const store = createArtifactStore(join(home, "lab", "artifacts"));
    persistConformanceResult(syntheticPassResult(caseRecord), caseRecord, authority, {
      configDir: home,
      recordedAt: recordedAt++,
      artifactStore: store,
    });
    store.close();
  }
  return rebuildLabProjection(home);
}

function config(home: string): OcxConfig {
  return { providers: {} } as OcxConfig;
}

async function apiGet(home: string, path: string): Promise<Response> {
  const req = new ManagementRequest(`http://127.0.0.1${path}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), config(home), {
    refreshCodexCatalog: async () => {},
  });
  expect(response).not.toBeNull();
  return response!;
}

describe("CL-04 query layer", () => {
  test("missing projection reports unavailable", () => {
    withHome((home) => {
      const status = queryLabStatus(home);
      expect(status.projectionAvailable).toBe(false);
      expect(() => queryLabVerdicts({}, undefined, undefined, home)).toThrow(LabProjectionUnavailableError);
    });
  });

  test("incompatible schema version fails explicitly", () => {
    withHome((home) => {
      seedProjection(home);
      const sqlitePath = join(home, "lab", "compatibility.sqlite");
      const db = new Database(sqlitePath);
      db.prepare("UPDATE schema_meta SET value = ? WHERE key = ?").run("999", "schema_version");
      db.close();
      expect(() => openLabReadConnection(home)).toThrow(LabProjectionIncompatibleError);
      const status = queryLabStatus(home);
      expect(status.projectionIncompatible).toBe(true);
    });
  });

  test("valid status and verdict filtering", () => {
    withHome((home) => {
      seedProjection(home);
      const status = queryLabStatus(home);
      expect(status.projectionAvailable).toBe(true);
      expect(status.sqliteSchemaVersion).toBe(LAB_SQLITE_SCHEMA_VERSION);
      expect(status.projectionSpecVersion).toBe(LAB_PROJECTION_SPEC_VERSION);
      expect(status.verdictCount).toBeGreaterThan(0);

      const page = queryLabVerdicts({ layer: "protocol_conformance" }, undefined, 10, home);
      expect(page.items.length).toBeGreaterThan(0);
      for (const item of page.items) {
        expect(item.evidenceLayer).toBe("protocol_conformance");
      }
    });
  });

  test("deterministic pagination and malformed cursor", () => {
    withHome((home) => {
      seedProjection(home);
      const first = queryLabVerdicts({}, undefined, 1, home);
      expect(first.items.length).toBe(1);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeTruthy();
      const second = queryLabVerdicts({}, first.nextCursor!, 1, home);
      expect(second.items[0]?.projectionKey).not.toBe(first.items[0]?.projectionKey);
      expect(() => queryLabVerdicts({}, "not-a-cursor", undefined, home)).toThrow(InvalidCursorError);
      const tampered = encodeLabCursor({
        v: 1,
        k: "verdicts",
        a: 1,
        p: "x",
        f: "tampered",
      });
      expect(() => queryLabVerdicts({}, tampered, undefined, home)).toThrow(InvalidCursorError);
    });
  });

  test("max limit enforcement", () => {
    withHome((home) => {
      seedProjection(home);
      const page = queryLabVerdicts({}, undefined, LAB_QUERY_MAX_PAGE_SIZE + 50, home);
      expect(page.items.length).toBeLessThanOrEqual(LAB_QUERY_MAX_PAGE_SIZE);
    });
  });

  test("subjects observations events artifacts catalogue", () => {
    withHome((home) => {
      seedProjection(home);
      const subjects = queryLabSubjects(undefined, undefined, undefined, home);
      expect(subjects.items.length).toBeGreaterThan(0);
      const subject = queryLabSubjectById(subjects.items[0]!.subjectId, home);
      expect(subject).not.toBeNull();

      const observations = queryLabObservations({}, undefined, undefined, home);
      expect(observations.items.length).toBeGreaterThan(0);

      const events = queryLabEvents({}, undefined, undefined, home);
      expect(events.items.length).toBeGreaterThan(0);
      const event = queryLabEventById(events.items[0]!.eventId, home);
      expect(event).not.toBeNull();
      expect(event).not.toHaveProperty("payload_json");

      const artifacts = queryLabArtifacts({}, undefined, undefined, home);
      expect(artifacts.items.length).toBeGreaterThan(0);
      const artifact = queryLabArtifactByDigest(artifacts.items[0]!.digest, home);
      expect(artifact).not.toBeNull();

      const catalog = queryLabCatalogEntries({ layer: "protocol_conformance" });
      expect(catalog.length).toBeGreaterThan(0);
    });
  });

  test("read calls do not mutate ledger sqlite artifacts", () => {
    withHome((home) => {
      seedProjection(home);
      const ledger = join(home, "lab", "compatibility.jsonl");
      const sqlite = join(home, "lab", "compatibility.sqlite");
      const ledgerBefore = readFileSync(ledger);
      const sqliteBefore = readFileSync(sqlite);
      const ledgerMtime = statSync(ledger).mtimeMs;
      const sqliteMtime = statSync(sqlite).mtimeMs;

      queryLabStatus(home);
      queryLabVerdicts({}, undefined, undefined, home);
      const subjectsForRead = queryLabSubjects(undefined, undefined, undefined, home);
      queryLabObservations({}, undefined, undefined, home);
      const eventsForRead = queryLabEvents({}, undefined, undefined, home);
      const artifactsForRead = queryLabArtifacts({}, undefined, undefined, home);
      expect(subjectsForRead.items.length).toBeGreaterThan(0);
      expect(eventsForRead.items.length).toBeGreaterThan(0);
      expect(artifactsForRead.items.length).toBeGreaterThan(0);
      queryLabSubjectById(subjectsForRead.items[0]!.subjectId, home);
      queryLabEventById(eventsForRead.items[0]!.eventId, home);
      queryLabArtifactByDigest(artifactsForRead.items[0]!.digest, home);
      queryLabCatalogEntries({ layer: "protocol_conformance" });

      expect(readFileSync(ledger).equals(ledgerBefore)).toBe(true);
      expect(readFileSync(sqlite).equals(sqliteBefore)).toBe(true);
      expect(statSync(ledger).mtimeMs).toBe(ledgerMtime);
      expect(statSync(sqlite).mtimeMs).toBe(sqliteMtime);
    });
  });
});

describe("CL-04 management API", () => {
  test("lab status and verdict routes", async () => {
    await withHome(async (home) => {
      seedProjection(home);
      const statusRes = await apiGet(home, "/api/lab/status");
      expect(statusRes.status).toBe(200);
      const statusBody = await statusRes.json() as { projectionAvailable: boolean };
      expect(statusBody.projectionAvailable).toBe(true);

      const verdictsRes = await apiGet(home, "/api/lab/verdicts?limit=5&layer=protocol_conformance");
      expect(verdictsRes.status).toBe(200);
      const verdictsBody = await verdictsRes.json() as { verdicts: unknown[]; hasMore: boolean };
      expect(verdictsBody.verdicts.length).toBeGreaterThan(0);
      for (const verdict of verdictsBody.verdicts) {
        expect(verdict).not.toHaveProperty("payload_json");
      }
    });
  });

  test("invalid filters and not found", async () => {
    await withHome(async (home) => {
      seedProjection(home);
      const badLayer = await apiGet(home, "/api/lab/verdicts?layer=bad");
      expect(badLayer.status).toBe(400);
      const body = await badLayer.json() as { error: { code: string } };
      expect(body.error.code).toBe("invalid_layer");

      const missing = await apiGet(home, "/api/lab/subjects/unknown-subject-id");
      expect(missing.status).toBe(404);

      const slash = await apiGet(home, "/api/lab/events/ev%2Fent");
      expect(slash.status).toBe(404);

      for (const path of ["/api/lab/subjects/%", "/api/lab/events/%", "/api/lab/artifacts/%"]) {
        const malformed = await apiGet(home, path);
        expect(malformed.status).toBe(404);
      }
    });
  });

  test("missing projection returns unavailable on data routes", async () => {
    await withHome(async (home) => {
      const res = await apiGet(home, "/api/lab/verdicts");
      expect(res.status).toBe(503);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe("lab_projection_unavailable");
    });
  });

  test("catalog route returns digest-backed metadata", async () => {
    await withHome(async (home) => {
      const res = await apiGet(home, "/api/lab/catalog?layer=protocol_conformance");
      expect(res.status).toBe(200);
      const body = await res.json() as { scenarios: Array<{ scenarioManifestDigest: string }> };
      expect(body.scenarios.length).toBeGreaterThan(0);
      expect(body.scenarios[0]?.scenarioManifestDigest).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});

describe("CL-04 CLI", () => {
  test("lab skips codex shim autorestore", () => {
    expect(skipsCodexShimAutoRestore("lab", [])).toBe(true);
  });

  test("lab status human and json without daemon", async () => {
    await withHome(async (home) => {
      seedProjection(home);
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try {
        const code = await handleLabCommand(["status"], { configDir: home });
        expect(code).toBe(0);
        expect(lines.join("\n")).toContain("Lab projection: available");

        lines.length = 0;
        const jsonCode = await handleLabCommand(["status", "--json"], { configDir: home });
        expect(jsonCode).toBe(0);
        expect(JSON.parse(lines.join("\n")).projectionAvailable).toBe(true);

        lines.length = 0;
        expect(await handleLabCommand([], { configDir: home })).toBe(0);
        expect(lines.join("\n")).toContain("Lab projection: available");

        lines.length = 0;
        expect(await handleLabCommand(["--json"], { configDir: home })).toBe(0);
        expect(JSON.parse(lines.join("\n")).projectionAvailable).toBe(true);
      } finally {
        console.log = originalLog;
      }
    });
  });

  test("lab verdicts and invalid args", async () => {
    await withHome(async (home) => {
      seedProjection(home);
      const lines: string[] = [];
      const errors: string[] = [];
      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
      console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
      try {
        expect(await handleLabCommand(["verdicts", "--limit", "1"], { configDir: home })).toBe(0);
        expect(lines.join("\n")).toContain("(more available; pass --cursor ");

        lines.length = 0;
        expect(await handleLabCommand(["verdicts", "--json", "--limit", "1"], { configDir: home })).toBe(0);
        expect(JSON.parse(lines.join("\n")).items.length).toBe(1);

        for (const command of ["subjects", "observations", "events", "artifacts", "catalog"]) {
          lines.length = 0;
          expect(await handleLabCommand([command], { configDir: home })).toBe(0);
          expect(lines.length).toBeGreaterThan(0);
        }

        const subjectId = queryLabSubjects(undefined, undefined, 1, home).items[0]!.subjectId;
        lines.length = 0;
        expect(await handleLabCommand(["subject", subjectId, "--json"], { configDir: home })).toBe(0);
        const subjectEnvelope = JSON.parse(lines.join("\n"));
        expect(subjectEnvelope.subject).toBeDefined();
        expect(subjectEnvelope).not.toHaveProperty("subjectId");

        errors.length = 0;
        expect(await handleLabCommand(["unknown-sub"], { configDir: home })).toBe(2);
        expect(errors.join("\n")).toContain("unknown lab subcommand");

        errors.length = 0;
        expect(await handleLabCommand(["verdicts", "--layer", "bogus"], { configDir: home })).toBe(2);
        expect(errors.join("\n")).toContain("supported evidence layer");

        errors.length = 0;
        expect(await handleLabCommand(["verdicts", "--from", "2000", "--to", "1000"], { configDir: home })).toBe(2);
        expect(errors.join("\n")).toContain("--from must not be greater than --to");

        errors.length = 0;
        expect(await handleLabCommand(["events", "--excluded", "yes"], { configDir: home })).toBe(2);
        expect(errors.join("\n")).toContain("--excluded must be true or false");
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }
    });
  });

  test("lab unavailable projection", async () => {
    await withHome(async (home) => {
      const lines: string[] = [];
      const errors: string[] = [];
      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
      console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
      try {
        expect(await handleLabCommand(["status", "--json"], { configDir: home })).toBe(0);
        expect(JSON.parse(lines.join("\n")).projectionAvailable).toBe(false);
        errors.length = 0;
        expect(await handleLabCommand(["verdicts"], { configDir: home })).toBe(1);
        expect(errors.join("\n")).toContain("lab projection is not available");
        expect(errors.join("\n")).not.toContain("Usage:");
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }
    });
  });
});

describe("CL-04 privacy boundary", () => {
  test("sanitizePublicText redacts secrets paths and urls", () => {
    const raw = "Bearer secret-token sk-abcdef1234567890 https://user:pass@example.com/path C:\\Users\\secret\\file.txt /home/user/secret";
    const sanitized = sanitizePublicText(raw, 512) ?? "";
    expect(sanitized).not.toContain("secret-token");
    expect(sanitized).not.toContain("sk-abcdef");
    expect(sanitized).not.toContain("user:pass");
    expect(sanitized).not.toContain("C:\\Users");
    expect(sanitized).not.toContain("/home/user");
  });

  test("corruption and artifact errors do not leak raw detail", () => {
    withHome((home) => {
      seedProjection(home);
      const eventId = queryLabEvents({}, undefined, 1, home).items[0]!.eventId;
      const sqlitePath = join(home, "lab", "compatibility.sqlite");
      const db = new Database(sqlitePath);
      const corruptionInsert = db.prepare(
        "INSERT INTO corruption(kind, line_number, event_id, detail) VALUES (?, ?, ?, ?)",
      ).run(
        "malformed_line",
        1,
        null,
        "Bearer access-token-value-REDTEST https://user:pw@chatgpt.com C:\\Users\\example\\secret\\path",
      );
      expect(corruptionInsert.changes).toBe(1);
      const artifactUpdate = db.prepare("UPDATE artifacts SET last_error = ? WHERE rowid = 1").run(
        "sk-test-1234567890abcdef",
      );
      expect(artifactUpdate.changes).toBe(1);
      const eventUpdate = db.prepare("UPDATE events SET exclusion_reason = ? WHERE event_id = ?").run(
        "Bearer detail-event-token C:\\Users\\detail\\secret",
        eventId,
      );
      expect(eventUpdate.changes).toBe(1);
      db.close();

      const status = queryLabStatus(home);
      expect(status.corruptionCount).toBeGreaterThan(0);
      expect(JSON.stringify(status)).not.toContain("access-token-value-REDTEST");

      const artifacts = queryLabArtifacts({}, undefined, undefined, home);
      expect(artifacts.items.length).toBeGreaterThan(0);
      for (const a of artifacts.items) {
        const serialized = JSON.stringify(a);
        expect(serialized).not.toContain("sk-test");
      }

      const event = queryLabEventById(eventId, home);
      expect(event).not.toBeNull();
      const serializedEvent = JSON.stringify(event);
      expect(serializedEvent).not.toContain("detail-event-token");
      expect(serializedEvent).not.toContain("C:\\Users");
    });
  });
});