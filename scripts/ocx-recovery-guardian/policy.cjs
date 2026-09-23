"use strict";

const DEFAULTS = Object.freeze({ pollMs: 2_000, failureThreshold: 3, recoverAfterMs: 20_000, startupGraceMs: 45_000, maxAttempts: 2, attemptWindowMs: 900_000, recoveryStableMs: 30_000 });
const STATE_VERSION = 1;
const STATE_KEYS = Object.freeze(["attempts", "awaitingReady", "consecutiveFailures", "diagnoseIssued", "failureSince", "foreignLatch", "healthySince", "incidentActive", "lastFailedAttemptAt", "readySince", "recoveryDeadline", "recoveryStartedAt", "startedAt", "stoppedLatch", "version"]);

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}
function positiveInteger(value, name) {
  const normalized = nonNegativeInteger(value, name);
  if (normalized === 0) throw new Error(`${name} must be positive`);
  return normalized;
}
function nullableInteger(value) { return value === null || (Number.isSafeInteger(value) && value >= 0); }
function decision(state, useFallback, action, reason) { return { state, useFallback, action, reason }; }

class RecoveryPolicy {
  constructor(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("options must be an object");
    const merged = { ...DEFAULTS };
    for (const [name, value] of Object.entries(options)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, name)) throw new Error(`unknown recovery policy option: ${name}`);
      merged[name] = name === "startupGraceMs" ? nonNegativeInteger(value, name) : positiveInteger(value, name);
    }
    this.options = Object.freeze(merged);
    this.attempts = [];
    this.startedAt = null;
    this.lastNow = null;
    this.stoppedLatch = false;
    this.foreignLatch = false;
    this.incidentActive = false;
    this.consecutiveFailures = 0;
    this.failureSince = null;
    this.healthySince = null;
    this.lastFailedAttemptAt = null;
    this.recoveryStartedAt = null;
    this.recoveryDeadline = null;
    this.awaitingReady = false;
    this.readySince = null;
    this.diagnoseIssued = false;
  }

  observe(sample, now) {
    const current = this.#now(now);
    this.#pruneAttempts(current);
    if (this.stoppedLatch) return decision("stopped", false, "none", "stopped-latched");
    if (this.foreignLatch) return decision("foreign", true, "none", "foreign-or-unknown-identity");
    if (!sample || typeof sample !== "object") return this.#foreign();
    if (sample.manualStop === true) return this.#stop("manual-stop");
    if (sample.owned === true && sample.launcherAlive === false) return this.#stop("launcher-stopped");
    if (sample.owned !== true || sample.identityChanged === true) return this.#foreign();
    const ready = sample.ready === true && sample.health === true && sample.alive === true;
    if (this.recoveryStartedAt !== null || this.awaitingReady) return this.#observeRecovery(ready, current);
    if (ready) return this.#observeReady(current);
    return this.#observeFailure(sample, current);
  }

  markRecoveryStarted(now) {
    const current = this.#now(now);
    this.#pruneAttempts(current);
    if (this.stoppedLatch) return decision("stopped", false, "none", "stopped-latched");
    if (this.foreignLatch) return decision("foreign", true, "none", "foreign-or-unknown-identity");
    if (this.recoveryStartedAt !== null || this.awaitingReady) return decision("recovering", true, "none", "recovery-in-progress");
    if (this.attempts.length >= this.options.maxAttempts) return this.#exhausted();
    if (this.#isBackoff(current)) return decision("failed", true, "none", "recovery-backoff");
    this.attempts.push(current);
    this.recoveryStartedAt = current;
    this.recoveryDeadline = current + this.options.recoverAfterMs;
    this.readySince = null;
    this.awaitingReady = false;
    return decision("recovering", true, "none", "recovery-started");
  }

  markRecoveryFinished(result, now) {
    const current = this.#now(now);
    if (this.recoveryStartedAt === null) return this.stoppedLatch ? decision("stopped", false, "none", "stopped-latched") : this.foreignLatch ? decision("foreign", true, "none", "foreign-or-unknown-identity") : decision("failed", true, "none", "recovery-not-started");
    this.recoveryStartedAt = null;
    if (!result || result.ok !== true) return this.#recordFailedAttempt(current, "recovery-failed");
    this.awaitingReady = true;
    this.readySince = null;
    this.recoveryDeadline = current + this.options.startupGraceMs + this.options.recoveryStableMs;
    return decision("recovering", true, "none", "awaiting-stable-ready");
  }

  reset({ resetBudget = false, now = this.lastNow === null ? 0 : this.lastNow } = {}) {
    const current = this.#now(now);
    this.#pruneAttempts(current);
    this.startedAt = current;
    this.stoppedLatch = false;
    this.foreignLatch = false;
    this.incidentActive = false;
    this.consecutiveFailures = 0;
    this.failureSince = null;
    this.healthySince = null;
    this.lastFailedAttemptAt = null;
    this.recoveryStartedAt = null;
    this.recoveryDeadline = null;
    this.awaitingReady = false;
    this.readySince = null;
    if (resetBudget === true) { this.attempts = []; this.diagnoseIssued = false; }
  }

  exportSafeState(now = this.lastNow === null ? Date.now() : this.lastNow) {
    const current = nonNegativeInteger(now, "now");
    this.#pruneAttempts(current);
    return { version: STATE_VERSION, attempts: [...this.attempts], startedAt: this.startedAt, stoppedLatch: this.stoppedLatch, foreignLatch: this.foreignLatch, incidentActive: this.incidentActive, consecutiveFailures: this.consecutiveFailures, failureSince: this.failureSince, healthySince: this.healthySince, lastFailedAttemptAt: this.lastFailedAttemptAt, recoveryStartedAt: this.recoveryStartedAt, recoveryDeadline: this.recoveryDeadline, awaitingReady: this.awaitingReady, readySince: this.readySince, diagnoseIssued: this.diagnoseIssued };
  }

  importSafeState(value, now) {
    const current = this.#now(now);
    if (!this.#isSafeState(value)) {
      this.foreignLatch = true;
      this.stoppedLatch = false;
      this.incidentActive = true;
      this.attempts = [];
      return false;
    }
    this.attempts = value.attempts.filter(attempt => attempt >= current - this.options.attemptWindowMs).slice(-this.options.maxAttempts);
    this.startedAt = value.startedAt;
    this.stoppedLatch = value.stoppedLatch;
    this.foreignLatch = value.foreignLatch;
    this.incidentActive = value.incidentActive;
    this.consecutiveFailures = value.consecutiveFailures;
    this.failureSince = value.failureSince;
    this.healthySince = value.healthySince;
    this.lastFailedAttemptAt = value.lastFailedAttemptAt;
    this.recoveryStartedAt = value.recoveryStartedAt;
    this.recoveryDeadline = value.recoveryDeadline;
    this.awaitingReady = value.awaitingReady;
    this.readySince = value.readySince;
    this.diagnoseIssued = value.diagnoseIssued;
    return true;
  }

  #observeRecovery(ready, now) {
    if (this.recoveryStartedAt !== null) {
      if (now >= this.recoveryDeadline) return this.#recordFailedAttempt(now, "recovery-timeout");
      return decision("recovering", true, "none", "recovery-in-progress");
    }
    if (ready) {
      if (this.readySince === null) this.readySince = now;
      if (now - this.readySince >= this.options.recoveryStableMs) return this.#endIncident(now);
    } else this.readySince = null;
    // A start receipt that cannot become ready is a failed normal recovery, not
    // a reason to wait for a second replacement attempt before diagnostics.
    // The caller's repair budget still deduplicates the bounded GLM dispatch.
    if (now >= this.recoveryDeadline) return this.#recordFailedAttempt(now, "recovery-not-stable", true);
    return decision("recovering", true, "none", "awaiting-stable-ready");
  }

  #observeReady(now) {
    this.consecutiveFailures = 0;
    this.failureSince = null;
    if (!this.incidentActive) return decision("healthy", false, "none", "ready");
    if (this.healthySince === null) this.healthySince = now;
    if (now - this.healthySince >= this.options.recoveryStableMs) return this.#endIncident(now);
    return decision("fallback", true, "none", "awaiting-stable-ready");
  }

  #observeFailure(sample, now) {
    this.incidentActive = true;
    this.healthySince = null;
    this.readySince = null;
    this.consecutiveFailures += 1;
    if (this.failureSince === null) this.failureSince = now;
    const startupGrace = now - this.startedAt < this.options.startupGraceMs;
    const childDead = sample.alive === false;
    if (startupGrace && !childDead) return decision("suspect", false, "none", "startup-grace");
    if (childDead) return this.#recoverDecision(now, "owned-child-dead");
    if (this.consecutiveFailures < this.options.failureThreshold) return decision("suspect", false, "none", "transient-failure");
    if (now - this.failureSince < this.options.recoverAfterMs) return decision("fallback", true, "none", "failure-threshold");
    return this.#recoverDecision(now, "failure-duration");
  }

  #recoverDecision(now, reason) {
    this.#pruneAttempts(now);
    if (this.attempts.length >= this.options.maxAttempts) return this.#exhausted();
    if (this.#isBackoff(now)) return decision("failed", true, "none", "recovery-backoff");
    return decision("fallback", true, "recover", reason);
  }

  #recordFailedAttempt(now, reason, diagnoseImmediately = false) {
    this.recoveryStartedAt = null;
    this.awaitingReady = false;
    this.readySince = null;
    this.recoveryDeadline = null;
    this.lastFailedAttemptAt = now;
    this.incidentActive = true;
    this.healthySince = null;
    if (this.attempts.length >= this.options.maxAttempts) return this.#exhausted();
    if (diagnoseImmediately) return decision("failed", true, "diagnose", reason);
    return decision("failed", true, "none", reason);
  }

  #exhausted() {
    if (!this.diagnoseIssued) { this.diagnoseIssued = true; return decision("failed", true, "diagnose", "attempt-budget-exhausted"); }
    return decision("failed", true, "none", "attempt-budget-exhausted");
  }

  #endIncident(now) {
    this.incidentActive = false;
    this.consecutiveFailures = 0;
    this.failureSince = null;
    this.healthySince = now;
    this.lastFailedAttemptAt = null;
    this.recoveryStartedAt = null;
    this.recoveryDeadline = null;
    this.awaitingReady = false;
    this.readySince = null;
    this.diagnoseIssued = false;
    return decision("healthy", false, "none", "stable-ready");
  }

  #stop(reason) { this.stoppedLatch = true; return decision("stopped", false, "none", reason); }
  #foreign() { this.foreignLatch = true; return decision("foreign", true, "none", "foreign-or-unknown-identity"); }
  #isBackoff(now) { if (this.lastFailedAttemptAt === null) return false; return now - this.lastFailedAttemptAt < (this.attempts.length <= 1 ? 5_000 : 15_000); }
  #pruneAttempts(now) { const floor = now - this.options.attemptWindowMs; this.attempts = this.attempts.filter(attempt => attempt >= floor).slice(-this.options.maxAttempts); }
  #now(now) { const current = nonNegativeInteger(now, "now"); this.lastNow = current; if (this.startedAt === null) this.startedAt = current; return current; }

  #isSafeState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    if (keys.length !== STATE_KEYS.length || keys.some((key, index) => key !== STATE_KEYS[index])) return false;
    if (value.version !== STATE_VERSION || !Array.isArray(value.attempts) || value.attempts.length > this.options.maxAttempts || !value.attempts.every(attempt => Number.isSafeInteger(attempt) && attempt >= 0)) return false;
    if (!nullableInteger(value.startedAt) || !nullableInteger(value.failureSince) || !nullableInteger(value.healthySince) || !nullableInteger(value.lastFailedAttemptAt) || !nullableInteger(value.recoveryStartedAt) || !nullableInteger(value.recoveryDeadline) || !nullableInteger(value.readySince) || !Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0) return false;
    return typeof value.stoppedLatch === "boolean" && typeof value.foreignLatch === "boolean" && typeof value.incidentActive === "boolean" && typeof value.awaitingReady === "boolean" && typeof value.diagnoseIssued === "boolean";
  }
}

module.exports = { RecoveryPolicy };
