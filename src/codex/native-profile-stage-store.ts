import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { NativeProfileContext } from "./native-profile-store";
import { NativeProfileError } from "./native-profile-types";

export const NATIVE_STAGE_LEASE_MS = 30 * 60_000;
export const NATIVE_STAGE_HEARTBEAT_INTERVAL_MS = 60_000;
export const NATIVE_STAGE_SWEEP_INTERVAL_MS = 60_000;
const MAX_STAGE_REGISTRY_BYTES = 1024 * 1024;
const MAX_STAGES = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const TOKEN_DOMAIN = "opencodex-native-stage-writer-v1\0";

export type NativeStageState = "creating" | "open" | "cleanup-required";
export type NativeStageTerminalOutcome = null | "imported" | "rejected" | "cancelled" | "expired";

export interface NativeStageRecordV1 {
  stageId: string;
  leaseId: string;
  writerTokenHash: string;
  creatorInstanceId: string;
  stagingRoot: string;
  stagingRootDev: string;
  stagingRootIno: string;
  stageDev: string | null;
  stageIno: string | null;
  state: NativeStageState;
  terminalOutcome: NativeStageTerminalOutcome;
  createdAt: number;
  lastHeartbeatAt: number;
  leaseExpiresAt: number;
}

interface NativeStageRegistryV1 {
  version: 1;
  revision: number;
  homeId: string;
  stages: NativeStageRecordV1[];
}

export interface NativeStageProof {
  record: NativeStageRecordV1;
  path: string;
  identity: { dev: bigint; ino: bigint };
  expired: boolean;
}

export interface NativeStageReservation {
  stageId: string;
  leaseId: string;
  writerToken: string;
  stagingCodexHome: string;
  leaseExpiresAt: number;
}

type AtomicWriter = (path: string, content: string) => Promise<void>;

export interface NativeStageStoreOptions {
  context: NativeProfileContext;
  now: () => number;
  randomUUID: () => string;
  atomicWrite: AtomicWriter;
  hardenPath: (path: string) => Promise<void>;
  leaseMs?: number;
}

function storageUnsafe(message: string): NativeProfileError {
  return new NativeProfileError("PROFILE_STORAGE_UNSAFE", message, 409, false, true, true);
}

function pathIdentity(path: string): { dev: bigint; ino: bigint } {
  const entry = lstatSync(path, { bigint: true });
  return { dev: entry.dev, ino: entry.ino };
}

function sameIdentity(entry: { dev: bigint; ino: bigint }, dev: string, ino: string): boolean {
  return entry.dev.toString() === dev && entry.ino.toString() === ino;
}

function boundedRead(path: string): string {
  let fd: number | undefined;
  try {
    const flags = process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
    fd = openSync(path, flags);
    const opened = fstatSync(fd, { bigint: true });
    const linked = lstatSync(path, { bigint: true });
    if (
      !opened.isFile()
      || !linked.isFile()
      || linked.isSymbolicLink()
      || opened.dev !== linked.dev
      || opened.ino !== linked.ino
      || opened.size > BigInt(MAX_STAGE_REGISTRY_BYTES)
    ) throw storageUnsafe("The native-login stage registry is not a bounded private file.");
    return readFileSync(fd, "utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseRecord(value: unknown): NativeStageRecordV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record");
  const record = value as Record<string, unknown>;
  const state = record.state;
  const terminal = record.terminalOutcome;
  if (
    typeof record.stageId !== "string" || !UUID_RE.test(record.stageId)
    || typeof record.leaseId !== "string" || !UUID_RE.test(record.leaseId)
    || typeof record.writerTokenHash !== "string" || !HASH_RE.test(record.writerTokenHash)
    || typeof record.creatorInstanceId !== "string" || !HASH_RE.test(record.creatorInstanceId)
    || typeof record.stagingRoot !== "string" || !isAbsolute(record.stagingRoot)
    || typeof record.stagingRootDev !== "string" || !/^\d+$/.test(record.stagingRootDev)
    || typeof record.stagingRootIno !== "string" || !/^\d+$/.test(record.stagingRootIno)
    || (record.stageDev !== null && (typeof record.stageDev !== "string" || !/^\d+$/.test(record.stageDev)))
    || (record.stageIno !== null && (typeof record.stageIno !== "string" || !/^\d+$/.test(record.stageIno)))
    || !["creating", "open", "cleanup-required"].includes(String(state))
    || ![null, "imported", "rejected", "cancelled", "expired"].includes(terminal as never)
    || !isInteger(record.createdAt)
    || !isInteger(record.lastHeartbeatAt)
    || !isInteger(record.leaseExpiresAt)
    || record.lastHeartbeatAt < record.createdAt
    || record.leaseExpiresAt < record.lastHeartbeatAt
  ) throw new Error("record");
  if (state === "open" && (record.stageDev === null || record.stageIno === null || terminal !== null)) throw new Error("record state");
  if (state === "creating" && terminal !== null) throw new Error("record state");
  if (state === "cleanup-required" && terminal === null) throw new Error("record state");
  return record as unknown as NativeStageRecordV1;
}

function serializeRegistry(registry: NativeStageRegistryV1): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

function tokenHash(context: NativeProfileContext, stageId: string, leaseId: string, token: string): Buffer {
  return createHash("sha256")
    .update(TOKEN_DOMAIN)
    .update(context.homeId)
    .update("\0")
    .update(stageId)
    .update("\0")
    .update(leaseId)
    .update("\0")
    .update(token)
    .digest();
}

export class NativeProfileStageStore {
  // Trust boundary: an authenticated OS user can rewrite their own files and is
  // not treated as an adversarial tenant. Any link, type, or inode ambiguity
  // that this process actually observes still fails closed before credential IO.
  private readonly context: NativeProfileContext;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly atomicWrite: AtomicWriter;
  private readonly hardenPath: (path: string) => Promise<void>;
  private readonly leaseMs: number;

  constructor(options: NativeStageStoreOptions) {
    this.context = options.context;
    this.now = options.now;
    this.uuid = options.randomUUID;
    this.atomicWrite = options.atomicWrite;
    this.hardenPath = options.hardenPath;
    this.leaseMs = Math.max(1_000, options.leaseMs ?? NATIVE_STAGE_LEASE_MS);
  }

  private read(): NativeStageRegistryV1 {
    if (!existsSync(this.context.stageRegistryPath)) {
      return { version: 1, revision: 0, homeId: this.context.homeId, stages: [] };
    }
    try {
      const parsed = JSON.parse(boundedRead(this.context.stageRegistryPath)) as Record<string, unknown>;
      if (
        parsed.version !== 1
        || !isInteger(parsed.revision)
        || parsed.homeId !== this.context.homeId
        || !Array.isArray(parsed.stages)
        || parsed.stages.length > MAX_STAGES
      ) throw new Error("registry");
      const stages = parsed.stages.map(parseRecord);
      if (new Set(stages.map(stage => stage.stageId)).size !== stages.length) throw new Error("duplicate stage");
      return { version: 1, revision: parsed.revision, homeId: this.context.homeId, stages };
    } catch (error) {
      if (error instanceof NativeProfileError) throw error;
      throw storageUnsafe("The native-login stage registry is invalid.");
    }
  }

  private async write(registry: NativeStageRegistryV1): Promise<void> {
    registry.revision += 1;
    await this.atomicWrite(this.context.stageRegistryPath, serializeRegistry(registry));
    await this.hardenPath(this.context.stageRegistryPath);
  }

  private record(registry: NativeStageRegistryV1, stageId: string): NativeStageRecordV1 | undefined {
    return registry.stages.find(stage => stage.stageId === stageId);
  }

  private assertToken(record: NativeStageRecordV1 | undefined, token: string): NativeStageRecordV1 {
    const expected = record ? Buffer.from(record.writerTokenHash, "hex") : Buffer.alloc(32);
    const actual = tokenHash(this.context, record?.stageId ?? "00000000-0000-4000-8000-000000000000", record?.leaseId ?? "00000000-0000-4000-8000-000000000000", token);
    const valid = timingSafeEqual(expected, actual);
    expected.fill(0);
    actual.fill(0);
    if (!record || !valid) throw new NativeProfileError("STAGING_NOT_FOUND", "The native-login staging session is missing or invalid.", 404);
    return record;
  }

  private assertRoot(record: NativeStageRecordV1): void {
    try {
      const entry = lstatSync(record.stagingRoot, { bigint: true });
      if (
        !entry.isDirectory()
        || entry.isSymbolicLink()
        || resolve(realpathSync.native(record.stagingRoot)) !== resolve(record.stagingRoot)
        || !sameIdentity({ dev: entry.dev, ino: entry.ino }, record.stagingRootDev, record.stagingRootIno)
      ) throw new Error("root identity");
    } catch {
      throw storageUnsafe("The native-login staging root changed identity.");
    }
  }

  stagePath(record: NativeStageRecordV1): string {
    const path = resolve(join(record.stagingRoot, record.stageId));
    const rel = relative(resolve(record.stagingRoot), path);
    if (!rel || rel.startsWith("..") || rel.includes(sep)) throw storageUnsafe("The native-login staging path escaped its registered root.");
    return path;
  }

  proofForRecord(record: NativeStageRecordV1, allowPartial = false): NativeStageProof | null {
    this.assertRoot(record);
    const path = this.stagePath(record);
    if (!existsSync(path)) return null;
    try {
      const entry = lstatSync(path, { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("stage type");
      if (record.stageDev !== null && record.stageIno !== null && !sameIdentity({ dev: entry.dev, ino: entry.ino }, record.stageDev, record.stageIno)) {
        throw new Error("stage identity");
      }
      if (!allowPartial) {
        const markerPath = join(path, "stage.json");
        const markerBefore = lstatSync(markerPath, { bigint: true });
        if (!markerBefore.isFile() || markerBefore.isSymbolicLink() || markerBefore.size > 4096n) throw new Error("stage marker type");
        const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
        const markerAfter = lstatSync(markerPath, { bigint: true });
        if (markerAfter.dev !== markerBefore.dev || markerAfter.ino !== markerBefore.ino) throw new Error("stage marker identity");
        if (
          marker.version !== 2
          || marker.stageId !== record.stageId
          || marker.leaseId !== record.leaseId
          || marker.homeId !== this.context.homeId
        ) throw new Error("stage marker");
      }
      return {
        record,
        path,
        identity: { dev: entry.dev, ino: entry.ino },
        expired: this.now() > record.leaseExpiresAt,
      };
    } catch {
      throw storageUnsafe("The native-login staging directory changed identity.");
    }
  }

  async reserve(stagingRoot: string): Promise<NativeStageReservation> {
    const registry = this.read();
    if (registry.stages.length >= MAX_STAGES) throw new NativeProfileError("INVALID_REQUEST", "Native-login staging is limited to 32 concurrent sessions.", 400);
    const canonicalRoot = resolve(realpathSync.native(stagingRoot));
    const root = lstatSync(canonicalRoot, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) throw storageUnsafe("The native-login staging root is not a private directory.");
    let stageId = this.uuid();
    while (this.record(registry, stageId)) stageId = this.uuid();
    const leaseId = this.uuid();
    const writerToken = randomBytes(32).toString("base64url");
    const now = this.now();
    const digest = tokenHash(this.context, stageId, leaseId, writerToken);
    const record: NativeStageRecordV1 = {
      stageId,
      leaseId,
      writerTokenHash: digest.toString("hex"),
      creatorInstanceId: this.context.instanceId,
      stagingRoot: canonicalRoot,
      stagingRootDev: root.dev.toString(),
      stagingRootIno: root.ino.toString(),
      stageDev: null,
      stageIno: null,
      state: "creating",
      terminalOutcome: null,
      createdAt: now,
      lastHeartbeatAt: now,
      leaseExpiresAt: now + this.leaseMs,
    };
    digest.fill(0);
    registry.stages.push(record);
    await this.write(registry);
    return { stageId, leaseId, writerToken, stagingCodexHome: this.stagePath(record), leaseExpiresAt: record.leaseExpiresAt };
  }

  async activate(reservation: NativeStageReservation): Promise<void> {
    const registry = this.read();
    const record = this.assertToken(this.record(registry, reservation.stageId), reservation.writerToken);
    if (record.state !== "creating" || record.leaseId !== reservation.leaseId) throw storageUnsafe("The native-login stage reservation changed state.");
    const path = this.stagePath(record);
    const identity = pathIdentity(path);
    record.stageDev = identity.dev.toString();
    record.stageIno = identity.ino.toString();
    record.state = "open";
    await this.write(registry);
  }

  verify(
    stageId: string,
    writerToken: string,
    allowCleanupRequired = false,
    allowInvalidMarker = false,
  ): NativeStageProof {
    if (!UUID_RE.test(stageId) || typeof writerToken !== "string" || writerToken.length < 32) {
      throw new NativeProfileError("STAGING_NOT_FOUND", "The native-login staging session is missing or invalid.", 404);
    }
    const registry = this.read();
    const record = this.assertToken(this.record(registry, stageId), writerToken);
    if (record.creatorInstanceId !== this.context.instanceId) {
      throw new NativeProfileError("STAGING_NOT_FOUND", "The native-login staging session is missing or invalid.", 404);
    }
    if (record.state === "creating" || (!allowCleanupRequired && record.state !== "open")) {
      throw new NativeProfileError("STAGING_TERMINAL", "The native-login staging session is no longer writable.", 409, false, record.state === "cleanup-required" ? true : undefined, record.state === "cleanup-required" ? true : undefined);
    }
    const proof = this.proofForRecord(record, allowInvalidMarker);
    if (!proof) throw new NativeProfileError("STAGING_NOT_FOUND", "The native-login staging session is missing or invalid.", 404);
    return proof;
  }

  async heartbeat(proof: NativeStageProof): Promise<number> {
    const registry = this.read();
    const record = this.record(registry, proof.record.stageId);
    if (!record || record.leaseId !== proof.record.leaseId || record.state !== "open") throw storageUnsafe("The native-login stage lease changed during heartbeat.");
    const now = this.now();
    record.lastHeartbeatAt = now;
    record.leaseExpiresAt = now + this.leaseMs;
    await this.write(registry);
    this.proofForRecord(record);
    return record.leaseExpiresAt;
  }

  async markCleanupRequired(proof: Pick<NativeStageProof, "record">, outcome: Exclude<NativeStageTerminalOutcome, null>): Promise<void> {
    const registry = this.read();
    const record = this.record(registry, proof.record.stageId);
    if (!record || record.leaseId !== proof.record.leaseId) return;
    record.state = "cleanup-required";
    record.terminalOutcome = outcome;
    await this.write(registry);
  }

  async remove(proof: Pick<NativeStageProof, "record">): Promise<void> {
    const registry = this.read();
    const index = registry.stages.findIndex(stage => stage.stageId === proof.record.stageId && stage.leaseId === proof.record.leaseId);
    if (index < 0) return;
    registry.stages.splice(index, 1);
    await this.write(registry);
  }

  records(): NativeStageRecordV1[] {
    return this.read().stages;
  }

  recordForStage(stageId: string): NativeStageRecordV1 | undefined {
    return this.read().stages.find(stage => stage.stageId === stageId);
  }
}
