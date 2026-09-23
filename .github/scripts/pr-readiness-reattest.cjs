"use strict";

const { createHash } = require("node:crypto");

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const PHASES = new Set(["await-clear", "await-check", "attested"]);
const AWAITING_KEYS = new Set(["version", "headSha", "baseRef", "generation", "phase", "checkpointAt"]);
const ATTESTED_KEYS = new Set([...AWAITING_KEYS, "attestedBodySha256"]);

/**
 * @typedef {{
 *   version: 1,
 *   headSha: string,
 *   baseRef: string,
 *   generation: number,
 *   phase: "await-clear" | "await-check",
 *   checkpointAt: string | null
 * }} AwaitingReattestation
 *
 * @typedef {{
 *   version: 1,
 *   headSha: string,
 *   baseRef: string,
 *   generation: number,
 *   phase: "attested",
 *   attestedBodySha256: string,
 *   checkpointAt: string | null
 * }} AttestedReattestation
 *
 * @typedef {AwaitingReattestation | AttestedReattestation} PendingReattestation
 * @typedef {{kind:"absent"} | {kind:"valid", value:PendingReattestation} | {kind:"invalid"}} ParsedPendingReattestation
 */

/** @param {unknown} value @returns {ParsedPendingReattestation} */
function parsePendingReattestation(value) {
  if (value == null) return { kind: "absent" };
  if (typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" };
  const candidate = /** @type {Record<string, unknown>} */ (value);
  if (
    candidate.version !== 1 ||
    typeof candidate.headSha !== "string" ||
    !SHA40.test(candidate.headSha) ||
    typeof candidate.baseRef !== "string" ||
    candidate.baseRef.length === 0 ||
    !Number.isSafeInteger(candidate.generation) ||
    candidate.generation <= 0 ||
    typeof candidate.phase !== "string" ||
    !PHASES.has(candidate.phase) ||
    !(candidate.checkpointAt === null ||
      (typeof candidate.checkpointAt === "string" && isStrictIsoTimestamp(candidate.checkpointAt)))
  ) return { kind: "invalid" };

  if (candidate.phase === "attested") {
    if (typeof candidate.attestedBodySha256 !== "string" || !SHA256.test(candidate.attestedBodySha256)) {
      return { kind: "invalid" };
    }
  } else if (Object.hasOwn(candidate, "attestedBodySha256")) {
    return { kind: "invalid" };
  }

  const allowedKeys = candidate.phase === "attested" ? ATTESTED_KEYS : AWAITING_KEYS;
  if (Object.keys(candidate).some(key => !allowedKeys.has(key))) return { kind: "invalid" };

  return { kind: "valid", value: /** @type {PendingReattestation} */ (candidate) };
}

/** @param {string} str */
function bodyDigest(str) {
  return createHash("sha256").update(String(str), "utf8").digest("hex");
}

function isStrictIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return value.includes(".") ? canonical === value : canonical.replace(".000Z", "Z") === value;
}

function validLiveIdentity(live) {
  return Boolean(
    live &&
    typeof live.headSha === "string" && SHA40.test(live.headSha) &&
    typeof live.baseRef === "string" && live.baseRef.length > 0 &&
    typeof live.body === "string" &&
    Number.isSafeInteger(live.authorId) && live.authorId > 0
  );
}

function sameIdentity(pending, live) {
  return pending.headSha === live.headSha && pending.baseRef === live.baseRef;
}

function awaitClear(live, generation) {
  return {
    version: 1,
    headSha: live.headSha,
    baseRef: live.baseRef,
    generation,
    phase: "await-clear",
    checkpointAt: null,
  };
}

function nextGeneration(generation) {
  return generation < Number.MAX_SAFE_INTEGER ? generation + 1 : 1;
}

function samePending(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function qualifyingAuthorBodyEdit({ live, event, checkpointAt }) {
  const checkpointMs = Date.parse(checkpointAt);
  const eventMs = Date.parse(event?.updatedAt ?? "");
  // GitHub can advance the live PR timestamp after the author event arrives.
  const liveMs = Date.parse(live?.updatedAt ?? "");
  return Boolean(
    event?.name === "pull_request_target" &&
    event.action === "edited" &&
    event.senderType === "User" &&
    Number.isSafeInteger(event.senderId) && event.senderId === live.authorId &&
    event.headSha === live.headSha &&
    typeof event.body === "string" && event.body === live.body &&
    typeof event.previousBody === "string" && event.previousBody !== event.body &&
    Number.isFinite(checkpointMs) && Number.isFinite(eventMs) && Number.isFinite(liveMs) &&
    eventMs > checkpointMs && eventMs <= liveMs
  );
}

/**
 * Advance the durable author re-attestation protocol without writing a PR body.
 * A newly seeded/reset episode never consumes the event that caused the reset.
 *
 * @param {object} input
 * @param {unknown} input.pending
 * @param {boolean} input.legacy
 * @param {boolean} input.current
 * @param {{present?:boolean,total?:number,checked?:number,complete?:boolean}} input.readiness
 * @param {{headSha:string,baseRef:string,body:string,updatedAt:string,authorId:number}} input.live
 * @param {{name?:string,action?:string,senderId?:number,senderType?:string,headSha?:string,body?:string,updatedAt?:string,previousBody?:string}} input.event
 * @param {boolean} [input.invalidate]
 * @returns {{pending:PendingReattestation|null,canComplete:boolean,changed:boolean,invalidIdentity:boolean}}
 */
function advanceReattestation({
  pending,
  legacy,
  current,
  readiness,
  live,
  event,
  invalidate = false,
}) {
  const parsed = parsePendingReattestation(pending);
  if (!validLiveIdentity(live)) {
    return {
      pending: parsed.kind === "valid" ? parsed.value : null,
      canComplete: false,
      changed: false,
      invalidIdentity: true,
    };
  }

  const prior = parsed.kind === "valid" ? parsed.value : null;
  if (parsed.kind === "invalid") {
    return { pending: awaitClear(live, 1), canComplete: false, changed: true, invalidIdentity: false };
  }

  if (prior && !sameIdentity(prior, live)) {
    return {
      pending: awaitClear(live, nextGeneration(prior.generation)),
      canComplete: false,
      changed: true,
      invalidIdentity: false,
    };
  }

  if (legacy || invalidate) {
    if (prior?.phase === "await-clear") {
      return { pending: prior, canComplete: false, changed: false, invalidIdentity: false };
    }
    const next = awaitClear(live, prior ? nextGeneration(prior.generation) : 1);
    return { pending: next, canComplete: false, changed: !samePending(prior, next), invalidIdentity: false };
  }

  if (!prior) {
    return { pending: null, canComplete: true, changed: false, invalidIdentity: false };
  }


  // A phase is provisional until the workflow persists it, reads the successful
  // comment write's server timestamp, and writes that timestamp into this field.
  if (prior.checkpointAt === null) {
    return { pending: prior, canComplete: false, changed: false, invalidIdentity: false };
  }

  if (prior.phase === "attested") {
    if (
      current && readiness?.present === true && readiness.total === 4 &&
      readiness.checked === 4 && readiness.complete === true &&
      prior.attestedBodySha256 === bodyDigest(live.body)
    ) {
      return { pending: prior, canComplete: true, changed: false, invalidIdentity: false };
    }
    const next = awaitClear(live, nextGeneration(prior.generation));
    return { pending: next, canComplete: false, changed: true, invalidIdentity: false };
  }

  if (!current) {
    if (prior.phase === "await-clear") {
      return { pending: prior, canComplete: false, changed: false, invalidIdentity: false };
    }
    return {
      pending: awaitClear(live, nextGeneration(prior.generation)),
      canComplete: false,
      changed: true,
      invalidIdentity: false,
    };
  }

  if (!qualifyingAuthorBodyEdit({ live, event, checkpointAt: prior.checkpointAt })) {
    return { pending: prior, canComplete: false, changed: false, invalidIdentity: false };
  }

  if (
    prior.phase === "await-clear" && current && readiness?.present === true &&
    readiness.total === 4 && readiness.checked === 0 && readiness.complete === false
  ) {
    const next = { ...prior, phase: "await-check", checkpointAt: null };
    return { pending: next, canComplete: false, changed: true, invalidIdentity: false };
  }

  if (
    prior.phase === "await-check" && current && readiness?.present === true &&
    readiness.total === 4 && readiness.checked === 4 && readiness.complete === true
  ) {
    const next = {
      ...prior,
      phase: "attested",
      attestedBodySha256: bodyDigest(live.body),
      checkpointAt: null,
    };
    return { pending: next, canComplete: false, changed: true, invalidIdentity: false };
  }

  return { pending: prior, canComplete: false, changed: false, invalidIdentity: false };
}

/**
 * Whether a saved re-attestation positively authorizes readiness for the live
 * PR: a finalized attestation of this exact head, base, and body. A readable
 * state that is merely unchanged from an earlier phase is not evidence.
 *
 * @param {unknown} saved
 * @param {{headSha:string,baseRef:string,body:string,authorId:number}} live
 */
function savedAttestationAuthorizes(saved, live) {
  const parsed = parsePendingReattestation(saved);
  if (parsed.kind !== "valid" || !validLiveIdentity(live)) return false;
  const value = parsed.value;
  return value.phase === "attested" &&
    typeof value.checkpointAt === "string" &&
    sameIdentity(value, live) &&
    value.attestedBodySha256 === bodyDigest(live.body);
}

module.exports = {
  advanceReattestation,
  bodyDigest,
  parsePendingReattestation,
  savedAttestationAuthorizes,
};
