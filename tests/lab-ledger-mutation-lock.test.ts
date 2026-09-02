import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendLabEvent,
  appendLabEventIfAbsent,
  assignEventId,
  createArtifactStore,
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  LAB_PRODUCER_VERSION,
  persistConformanceResult,
  purgeSensitiveEvidence,
  replayLabLedger,
  withLedgerMutation,
} from "../src/lab";
import type { ArtifactStore } from "../src/lab/artifacts/store";
import { discoverScenarios, loadCaseAuthority } from "../src/lab/conformance/manifest";
import { resolveProtocolExecutionContext } from "../src/lab/conformance/executor";
import type { CaseRecord } from "../src/lab/conformance/types";
import type { InvalidationEvent } from "../src/lab/events/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const HOMES: string[] = [];

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-ledger-lock-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    try {
      removeTreeWithRetry(dir);
    } catch {
      /* ignore */
    }
  }
});

function hash(value: string): string {
  return Bun.CryptoHasher.hash("sha256", value, "hex");
}

function invalidation(seed: string, recordedAt = 1_700_000_000_000): InvalidationEvent {
  return assignEventId({
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventKind: "invalidation" as const,
    recordedAt,
    producer: LAB_PRODUCER,
    producerVersion: LAB_PRODUCER_VERSION,
    targetEventIds: [hash(`target:${seed}`)],
    reason: "manual_correction" as const,
  }) as InvalidationEvent;
}

function syntheticPassResult(caseRecord: CaseRecord) {
  return {
    scenarioId: caseRecord.id,
    suite: caseRecord.suite,
    passed: true,
    classification: "inconclusive" as const,
    assertionResults: caseRecord.assertions.map((assertion) => ({
      id: assertion.id,
      operator: assertion.operator,
      required: assertion.required,
      passed: true,
      observedSummary: "ok",
    })),
    diagnostics: [],
    executionContext: resolveProtocolExecutionContext(caseRecord),
    startedAt: 999,
    completedAt: 1000,
  };
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for child marker ${path}`);
}

async function waitForChild(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const result = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode })),
    Bun.sleep(5_000).then(() => null),
  ]);
  if (!result) {
    child.kill();
    await child.exited;
    throw new Error("timed out waiting for ledger-lock child");
  }
  if (result.exitCode !== 0) {
    const stderr = await new Response(child.stderr).text().catch(() => "");
    throw new Error(`ledger-lock child exited ${result.exitCode}: ${stderr}`);
  }
}

function spawnLiveLock(
  ledgerPath: string,
  readyPath: string,
  releaseMarkerPath: string,
): ReturnType<typeof Bun.spawn> {
  const lockPath = `${ledgerPath}.lock`;
  const childSource = `
    import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    mkdirSync(dirname(${JSON.stringify(lockPath)}), { recursive: true, mode: 0o700 });
    writeFileSync(
      ${JSON.stringify(lockPath)},
      JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "live-holder" }),
      { mode: 0o600 },
    );
    writeFileSync(${JSON.stringify(readyPath)}, "ready");
    Bun.sleepSync(250);
    writeFileSync(${JSON.stringify(releaseMarkerPath)}, "releasing");
    unlinkSync(${JSON.stringify(lockPath)});
  `;
  return Bun.spawn([process.execPath, "-e", childSource], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("appendLabEvent waits for the shared ledger mutation lock", async () => {
  const home = tempHome();
  const ledgerPath = join(home, "lab", "compatibility.jsonl");
  const readyPath = join(home, "holder-ready");
  const releaseMarkerPath = join(home, "holder-releasing");
  const child = spawnLiveLock(ledgerPath, readyPath, releaseMarkerPath);

  try {
    await waitForPath(readyPath);
    const event = invalidation("append-lock");
    appendLabEvent(ledgerPath, event);
    expect(existsSync(releaseMarkerPath)).toBe(true);
    expect(replayLabLedger(ledgerPath).events.some((row) => row.eventId === event.eventId)).toBe(true);
  } finally {
    await waitForChild(child);
  }
});

test("appendLabEventIfAbsent immediately recovers a lock owned by an exited process", async () => {
  const home = tempHome();
  const ledgerPath = join(home, "lab", "compatibility.jsonl");
  const lockPath = `${ledgerPath}.lock`;
  const readyPath = join(home, "dead-lock-written");
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });

  const childSource = `
    import { writeFileSync } from "node:fs";
    writeFileSync(
      ${JSON.stringify(lockPath)},
      JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "dead-holder" }),
      { mode: 0o600 },
    );
    writeFileSync(${JSON.stringify(readyPath)}, "ready");
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForPath(readyPath);
  await waitForChild(child);

  const event = invalidation("dead-lock");
  expect(appendLabEventIfAbsent(ledgerPath, event)).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
  expect(existsSync(`${lockPath}.recovery`)).toBe(false);
  expect(replayLabLedger(ledgerPath).events.some((row) => row.eventId === event.eventId)).toBe(true);
});

test("withLedgerMutation rejects async callbacks and invalidates their context", async () => {
  const home = tempHome();
  const ledgerPath = join(home, "lab", "compatibility.jsonl");
  const event = invalidation("async-callback");
  let continuation: Promise<void> | undefined;
  let continuationError: unknown;

  expect(() => withLedgerMutation(ledgerPath, (mutation) => {
    continuation = (async () => {
      await Bun.sleep(1);
      mutation.append(event);
    })().catch((error) => {
      continuationError = error;
    });
    return continuation;
  })).toThrow("ledger mutation callback must be synchronous");

  await continuation;
  expect(continuationError).toBeInstanceOf(Error);
  expect((continuationError as Error).message).toContain("after its lock was released");
  expect(replayLabLedger(ledgerPath).events.some((row) => row.eventId === event.eventId)).toBe(false);
});

test("canonical persistence publishes artifacts while holding the ledger mutation lock", () => {
  const home = tempHome();
  const ledgerPath = join(home, "lab", "compatibility.jsonl");
  const authority = loadCaseAuthority();
  const caseRecord = discoverScenarios(authority, ["responses-core"]).find(
    (candidate) => candidate.id === "responses-core.protocol.request-shape",
  )!;
  const realStore = createArtifactStore(join(home, "lab", "artifacts"));
  const guardedStore: ArtifactStore = {
    ...realStore,
    put(input) {
      expect(existsSync(`${ledgerPath}.lock`)).toBe(true);
      return realStore.put(input);
    },
  };

  try {
    const { event } = persistConformanceResult(
      syntheticPassResult(caseRecord),
      caseRecord,
      authority,
      { configDir: home, recordedAt: 1000, artifactStore: guardedStore },
    );
    expect(replayLabLedger(ledgerPath).events.some((row) => row.eventId === event.eventId)).toBe(true);
    expect(existsSync(`${ledgerPath}.lock`)).toBe(false);
  } finally {
    realStore.close();
  }
});

test("sensitive purge waits for the ledger mutation lock before rewriting", async () => {
  const home = tempHome();
  const ledgerPath = join(home, "lab", "compatibility.jsonl");
  const event = invalidation("purge-lock");
  appendLabEvent(ledgerPath, event);

  const readyPath = join(home, "purge-holder-ready");
  const releaseMarkerPath = join(home, "purge-holder-releasing");
  const child = spawnLiveLock(ledgerPath, readyPath, releaseMarkerPath);

  try {
    await waitForPath(readyPath);
    purgeSensitiveEvidence({
      configDir: home,
      targetEventIds: [event.eventId],
      targetArtifactDigests: [],
      purgeActions: ["ledger"],
      recordedAt: 1_700_000_000_100,
    });
    expect(existsSync(releaseMarkerPath)).toBe(true);
    const replay = replayLabLedger(ledgerPath);
    expect(replay.events.some((row) => row.eventId === event.eventId)).toBe(false);
    expect(replay.events.some((row) => row.eventKind === "purge_tombstone")).toBe(true);
    expect(existsSync(`${ledgerPath}.lock`)).toBe(false);
  } finally {
    await waitForChild(child);
  }
});
