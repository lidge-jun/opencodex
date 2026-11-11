// Canonical checkpoint data only. This module never authenticates or grants update authority.
import { createHash } from "node:crypto";
import { snapshotUpdateBytes } from "./update-bytes.mjs";
import { parseRootTransitionEnvelope, parseUpdateDocument } from "./update-contracts.mjs";
import { sameSignedVersion } from "./update-signed-version.mjs";

const PREFIX = Buffer.from("ocx.update.checkpoint/1\0", "ascii");
const MAX_PAYLOAD = 64 * 1024 * 1024;
const MAX_ROOT = 65536, MAX_ENVELOPE = 262144;
const CHANNELS = ["latest", "preview", "nightly"];
const OWNERS = ["desktop", "npm", "pnpm", "bun", "standalone", "service"];
const KEYS = ["namespaceDigest", "principalDigest", "ownerKind", "consentGeneration", "identityKind", "identityBytes", "generation", "rootRevision", "rootDigest", "rootBytes", "history", "channels", "firstSeen", "clockHighWaterMs", "securityEpoch"];
const HISTORY_KEYS = ["previousRevision", "previousDigest", "nextRevision", "nextDigest", "acceptedAtMs", "rootBytes", "envelopeBytes"];
const FLOOR_KEYS = ["sequence", "releaseDigest", "version"];
const SEEN_KEYS = ["candidateDigest", "firstSeenMs"];
const fail = () => { throw new Error("Invalid checkpoint payload"); };

function record(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  // JavaScript must enumerate own keys to reject extras; executable proxies can
  // still make that enumeration expensive. Do not materialize extra descriptors.
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some((key) => typeof key !== "string" || !keys.includes(key))) fail();
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail();
    result[key] = descriptor.value;
  }
  return result;
}
function list(value, max) {
  if (!Array.isArray(value)) fail();
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) fail();
  const names = Reflect.ownKeys(value);
  if (names.length !== length + 1 || names.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) fail();
  const result = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor)) fail();
    result.push(descriptor.value);
  }
  return result;
}
function number(value, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) fail();
  return value;
}
function bytes(value, max, exact = false) {
  const copy = snapshotUpdateBytes(value, max);
  if (copy.length === 0 || (exact && copy.length !== max)) fail();
  return Buffer.from(copy);
}
const digest = (value) => bytes(value, 32, true);
const hash = (value) => createHash("sha256").update(value).digest();
function root(bytesValue, revision, expectedDigest) {
  if (!hash(bytesValue).equals(expectedDigest)) fail();
  const parsed = parseUpdateDocument(bytesValue, "ocx.update.root/1");
  if (parsed.revision !== revision) fail();
}
function capture(input) {
  const data = record(input, KEYS);
  const owner = OWNERS.indexOf(data.ownerKind);
  if (owner < 0 || (data.identityKind !== "posix" && data.identityKind !== "windows")) fail();
  const identitySize = data.identityKind === "posix" ? 16 : 24;
  const result = {
    namespaceDigest: digest(data.namespaceDigest), principalDigest: digest(data.principalDigest),
    ownerKind: data.ownerKind, consentGeneration: number(data.consentGeneration),
    identityKind: data.identityKind, identityBytes: bytes(data.identityBytes, identitySize, true),
    generation: number(data.generation, true), rootRevision: number(data.rootRevision, true),
    rootDigest: digest(data.rootDigest), rootBytes: bytes(data.rootBytes, MAX_ROOT),
    history: [], channels: {}, firstSeen: {}, clockHighWaterMs: number(data.clockHighWaterMs),
    securityEpoch: number(data.securityEpoch, true),
  };
  root(result.rootBytes, result.rootRevision, result.rootDigest);
  let previous = null;
  for (const item of list(data.history, 128)) {
    const h = record(item, HISTORY_KEYS);
    const entry = {
      previousRevision: number(h.previousRevision, true), previousDigest: digest(h.previousDigest),
      nextRevision: number(h.nextRevision, true), nextDigest: digest(h.nextDigest),
      acceptedAtMs: number(h.acceptedAtMs), rootBytes: bytes(h.rootBytes, MAX_ROOT),
      envelopeBytes: bytes(h.envelopeBytes, MAX_ENVELOPE),
    };
    if (entry.nextRevision <= entry.previousRevision || (previous && (entry.previousRevision !== previous.nextRevision || !entry.previousDigest.equals(previous.nextDigest) || entry.acceptedAtMs < previous.acceptedAtMs))) fail();
    root(entry.rootBytes, entry.nextRevision, entry.nextDigest);
    parseRootTransitionEnvelope(entry.envelopeBytes);
    result.history.push(entry);
    previous = entry;
  }
  if (previous && (previous.nextRevision !== result.rootRevision || !previous.nextDigest.equals(result.rootDigest))) fail();
  const floors = record(data.channels, CHANNELS), observations = record(data.firstSeen, CHANNELS);
  for (const channel of CHANNELS) {
    const floor = floors[channel];
    if (floor === null) result.channels[channel] = null;
    else {
      const f = record(floor, FLOOR_KEYS);
      if (typeof f.version !== "string" || !sameSignedVersion(f.version, f.version)) fail();
      result.channels[channel] = { sequence: number(f.sequence, true), releaseDigest: digest(f.releaseDigest), version: f.version };
    }
    const entries = [];
    for (const item of list(observations[channel], 4096)) {
      const s = record(item, SEEN_KEYS);
      const entry = { candidateDigest: digest(s.candidateDigest), firstSeenMs: number(s.firstSeenMs) };
      if (entry.firstSeenMs > result.clockHighWaterMs || (entries.length && Buffer.compare(entries[entries.length - 1].candidateDigest, entry.candidateDigest) >= 0)) fail();
      entries.push(entry);
    }
    result.firstSeen[channel] = entries;
  }
  return result;
}
const u8 = (value) => Buffer.from([value]);
function u16(value) { const out = Buffer.allocUnsafe(2); out.writeUInt16BE(value); return out; }
function u32(value) { const out = Buffer.allocUnsafe(4); out.writeUInt32BE(value); return out; }
function u64(value) { const out = Buffer.allocUnsafe(8); out.writeBigUInt64BE(BigInt(value)); return out; }
const lengthOf = (chunks) => chunks.reduce((total, chunk) => total + chunk.length, 0);
function sized(chunks) { return [u32(lengthOf(chunks)), ...chunks]; }
function encodeCaptured(data) {
  const fields = [
    [data.namespaceDigest, data.principalDigest],
    [u8(OWNERS.indexOf(data.ownerKind) + 1), u64(data.consentGeneration), u8(data.identityKind === "posix" ? 1 : 2), u16(data.identityBytes.length), data.identityBytes],
    [u64(data.generation), u64(data.rootRevision), data.rootDigest],
    [data.rootBytes],
    [u32(data.history.length)], [], [], [u64(data.clockHighWaterMs), u64(data.securityEpoch)],
  ];
  for (const item of data.history) {
    fields[4].push(...sized([u64(item.previousRevision), item.previousDigest, u64(item.nextRevision), item.nextDigest, u64(item.acceptedAtMs), ...sized([item.rootBytes]), ...sized([item.envelopeBytes])]));
  }
  for (const channel of CHANNELS) {
    const floor = data.channels[channel];
    if (!floor) fields[5].push(u8(0));
    else { const version = Buffer.from(floor.version, "ascii"); fields[5].push(u8(1), u64(floor.sequence), floor.releaseDigest, u8(version.length), version); }
    const seen = data.firstSeen[channel];
    fields[6].push(u32(seen.length));
    for (const entry of seen) fields[6].push(entry.candidateDigest, u64(entry.firstSeenMs));
  }
  const chunks = [PREFIX];
  for (let i = 0; i < fields.length; i++) chunks.push(u16(i + 1), ...sized(fields[i]));
  const length = lengthOf(chunks);
  if (length > MAX_PAYLOAD) fail();
  return new Uint8Array(Buffer.concat(chunks, length));
}

class Reader {
  constructor(bytesValue) { this.data = bytesValue; this.offset = 0; }
  take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.data.length - this.offset) fail();
    const value = this.data.subarray(this.offset, this.offset + length); this.offset += length; return value;
  }
  byte() { return this.take(1)[0]; }
  short() { return this.take(2).readUInt16BE(); }
  uint() { return this.take(4).readUInt32BE(); }
  long() { const value = this.take(8).readBigUInt64BE(); if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(); return Number(value); }
  end() { if (this.offset !== this.data.length) fail(); }
  blob(max) { const length = this.uint(); if (length < 1 || length > max) fail(); return new Uint8Array(this.take(length)); }
}
function decodeSnapshot(snapshot) {
  const input = new Reader(Buffer.from(snapshot));
  if (!input.take(PREFIX.length).equals(PREFIX)) fail();
  const fields = [];
  for (let tag = 1; tag <= 8; tag++) {
    if (input.short() !== tag) fail();
    fields.push(new Reader(input.take(input.uint())));
  }
  input.end();
  const [a,b,c,d,e,f,g,h] = fields;
  const namespaceDigest = new Uint8Array(a.take(32)), principalDigest = new Uint8Array(a.take(32)); a.end();
  const owner = b.byte(), consentGeneration = b.long(), identity = b.byte(), identityLength = b.short();
  if (!OWNERS[owner - 1] || ![1, 2].includes(identity) || identityLength !== (identity === 1 ? 16 : 24)) fail();
  const identityBytes = new Uint8Array(b.take(identityLength)); b.end();
  const generation = c.long(), rootRevision = c.long(), rootDigest = new Uint8Array(c.take(32)); c.end();
  if (d.data.length < 1 || d.data.length > MAX_ROOT) fail();
  const rootBytes = new Uint8Array(d.take(d.data.length)); d.end();
  const count = e.uint(); if (count > 128) fail();
  const history = [];
  for (let i = 0; i < count; i++) {
    const size = e.uint(); if (size > 88 + 4 + MAX_ROOT + 4 + MAX_ENVELOPE) fail();
    const item = new Reader(e.take(size));
    history.push({ previousRevision: item.long(), previousDigest: new Uint8Array(item.take(32)), nextRevision: item.long(), nextDigest: new Uint8Array(item.take(32)), acceptedAtMs: item.long(), rootBytes: item.blob(MAX_ROOT), envelopeBytes: item.blob(MAX_ENVELOPE) });
    item.end();
  }
  e.end();
  const channels = {}, firstSeen = {};
  for (const channel of CHANNELS) {
    const present = f.byte(); if (present > 1) fail();
    if (!present) channels[channel] = null;
    else {
      const sequence = f.long(), releaseDigest = new Uint8Array(f.take(32)), size = f.byte();
      if (!size || size > 64) fail();
      const version = f.take(size); if (version.some((byte) => byte > 127)) fail();
      channels[channel] = { sequence, releaseDigest, version: version.toString("ascii") };
    }
    const seenCount = g.uint(); if (seenCount > 4096) fail();
    const seen = [];
    for (let i = 0; i < seenCount; i++) seen.push({ candidateDigest: new Uint8Array(g.take(32)), firstSeenMs: g.long() });
    firstSeen[channel] = seen;
  }
  f.end(); g.end();
  const clockHighWaterMs = h.long(), securityEpoch = h.long(); h.end();
  const value = { namespaceDigest, principalDigest, ownerKind: OWNERS[owner - 1], consentGeneration, identityKind: identity === 1 ? "posix" : "windows", identityBytes, generation, rootRevision, rootDigest, rootBytes, history, channels, firstSeen, clockHighWaterMs, securityEpoch };
  // Re-encoding validates all semantic rules and the canonical representation.
  const canonical = encodeCaptured(capture(value));
  if (!Buffer.from(canonical).equals(Buffer.from(snapshot))) fail();
  return value;
}

/** Structurally encode unverified checkpoint data; no trust or installation authority is issued. */
export function encodeCheckpointPayload(input) { return encodeCaptured(capture(input)); }
/** Decode and validate a private snapshot; returned buffers are detached from the input. */
export function decodeCheckpointPayload(input) { return decodeSnapshot(snapshotUpdateBytes(input, MAX_PAYLOAD)); }
/** Hash exactly the private snapshot whose canonical structure was validated. */
export function checkpointPayloadDigest(input) {
  const snapshot = snapshotUpdateBytes(input, MAX_PAYLOAD);
  decodeSnapshot(snapshot);
  return hash(snapshot).toString("hex");
}
