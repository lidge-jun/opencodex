'use strict';

// Desktop companion, deliberately hosted by Node rather than the Bun process it watches.
// No request payload, upstream credential, or arbitrary command is persisted here.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createGateway } = require('./gateway.cjs');
const { RecoveryPolicy } = require('./policy.cjs');
const { runRepair, REPAIR_ORIGINS } = require('./repair.cjs');

// The local OpenRouter-style listener the fallback and repair routes share.
const LOCAL_ORIGIN = 'http://127.0.0.1:20128';
// Incident directories are read by a human once and by nothing in the repository, so the
// newest few are all a long-lived guardian should keep.
const REPAIR_INCIDENTS_KEPT = 20;
// How far the boot instant implied by /healthz's `uptime` may sit from the one a snapshot
// was taken at before it counts as another process generation. A wrap that slips inside
// this window is caught by a later observation.
const BOOT_TOLERANCE_MS = 5000;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const writes = new Map();

async function jsonFile(file, max = 65536) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw Error('unsafe_state_file');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function atomicJson(file, value) {
  const encoded = JSON.stringify(value) + '\n';
  const next = (writes.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error('unsafe_state_file');
    // The observation loop rewrites status and budget every couple of seconds.
    // Compare inside the queue so a concurrent writer cannot slip between this
    // read and the replacement below.
    if (stat && await fs.readFile(file, 'utf8') === encoded) return;
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, encoded, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  });
  writes.set(file, next);
  try { await next; } finally { if (writes.get(file) === next) writes.delete(file); }
}

async function loadSettings(file) {
  const cfg = await jsonFile(file, 16384);
  if (cfg.version !== 1 || cfg.enabled !== true) throw Error('guardian_not_enabled');
  for (const key of ['projectRoot', 'openCodexHome', 'codexHome']) {
    if (typeof cfg[key] !== 'string' || !path.isAbsolute(cfg[key])) throw Error('invalid_home');
    cfg[key] = path.resolve(cfg[key]);
  }
  if (path.resolve(cfg.projectRoot, 'scripts', 'ocx-recovery-guardian') !== __dirname) throw Error('foreign_project');
  if (path.resolve(file) !== path.join(cfg.openCodexHome, 'recovery-guardian.json')) throw Error('foreign_config');
  const home = await fs.lstat(cfg.openCodexHome);
  if (!home.isDirectory() || home.isSymbolicLink()) throw Error('unsafe_home');
  for (const key of ['listenPort', 'primaryPort']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 1 || cfg[key] > 65535) throw Error('invalid_port');
  }
  if (cfg.listenPort === cfg.primaryPort) throw Error('gateway_loop');
  if (cfg.fallback?.origin !== LOCAL_ORIGIN || !cfg.fallback.models || Array.isArray(cfg.fallback.models)) throw Error('missing_fallback');
  if (Object.entries(cfg.fallback.models).some(([k, v]) => !k || typeof v !== 'string' || !v)) throw Error('invalid_models');
  if (!REPAIR_ORIGINS.includes(cfg.repair?.origin)) throw Error('invalid_repair');
  if (cfg.repair.fallbackOrigin !== undefined && cfg.repair.fallbackOrigin !== `${LOCAL_ORIGIN}/v1`) throw Error('invalid_repair_fallback');
  return cfg;
}

// Fixed, local-only credential references. Never put a credential in process arguments.
async function readKey(ref, cfg) {
  if (ref?.kind === 'ollama-local') return 'ollama-local';
  if (ref?.kind === 'oc-provider' && ref.provider === 'mnn-ai') {
    const source = await jsonFile(path.join(cfg.openCodexHome, 'config.json'), 2 * 1024 * 1024);
    const row = source.providers?.[ref.provider];
    if (row?.baseUrl !== cfg.repair.origin || typeof row.apiKey !== 'string' || !row.apiKey.trim() || row.apiKey.includes('${')) throw Error('repair_key_unavailable');
    return row.apiKey.trim();
  }
  if (ref?.kind === 'or-protected') {
    const directory = path.join(cfg.openCodexHome, 'recovery-secrets');
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('unsafe_key_directory');
    const saved = await jsonFile(path.join(directory, 'or-key.json'), 16384);
    if (saved.version !== 1 || saved.baseUrl !== cfg.fallback.origin || typeof saved.key !== 'string' || !saved.key) throw Error('fallback_key_unavailable');
    return saved.key;
  }
  throw Error('unsupported_key_reference');
}

async function boundedCommand(executable, args, { env, timeoutMs = 15000, maxBytes = 32768 } = {}) {
  return new Promise(resolve => {
    let done = false, output = '', bytes = 0;
    const child = spawn(executable, args, { env: env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => finish({ ok: false, error: 'command_timeout', pid: child.pid, uncertain: true }), timeoutMs);
    function finish(value) { if (!done) { done = true; clearTimeout(timer); resolve(value); } }
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= maxBytes) output += chunk; });
    child.on('error', () => finish({ ok: false, error: 'command_spawn_failed' }));
    child.on('close', code => {
      if (bytes > maxBytes) return finish({ ok: false, error: 'command_output_limit' });
      try { finish({ ok: code === 0, value: JSON.parse(output.replace(/^\uFEFF/, '').trim()), code }); }
      catch { finish({ ok: false, error: 'command_receipt_invalid', code }); }
    });
    // A timed-out stop may still be acting. It is deliberately NOT killed and no
    // replacement is started by the caller until its termination is established.
  });
}

function parseIntent(value, now) {
  if (value?.version !== 1 || !['running', 'stopped', 'maintenance'].includes(value.mode)
    || !Number.isSafeInteger(value.at) || value.at < 0 || value.at > now + 5000) return { mode: 'stopped', at: 0, valid: false };
  if (value.mode === 'maintenance' && (!Number.isSafeInteger(value.until) || value.until <= value.at || value.until > value.at + 180000)) return { mode: 'stopped', at: 0, valid: false };
  return { mode: value.mode, at: value.at, until: value.until || 0, valid: true };
}
function recoveryActionSucceeded(result) { return result?.ok === true && result.value?.action === 'started'; }

async function createGuardian(configFile, dependencies = {}) {
  const cfg = await loadSettings(path.resolve(configFile));
  const now = dependencies.now || Date.now;
  const processAlive = dependencies.alive || alive;
  const primaryOrigin = `http://127.0.0.1:${cfg.primaryPort}`;
  const logDir = path.join(cfg.openCodexHome, 'logs');
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, 'recovery-guardian.jsonl');
  const statusFile = path.join(cfg.openCodexHome, 'recovery-status.json');
  const budgetFile = path.join(cfg.openCodexHome, 'recovery-budget.json');
  const intentFile = path.join(cfg.openCodexHome, 'recovery-intent.json');
  const blockedFile = path.join(cfg.openCodexHome, 'recovery-blocked.json');
  const policy = new RecoveryPolicy(dependencies.policyOptions);
  let primaryReady = false, stopped = true, closing = false, snapshot = null;
  let snapshotBoot = null, lastStatusKey = '', openingInspection = false, snapshotAt = 0;
  let recovering = false, repairRunning = false, currentState = 'starting', lastIntentAt = -1;
  let lastIntentSignature = '', recoveryBlocked = null, failureSince = null, lastRecovery = null, lastRepair = null;
  let readyIdentity = '', readySince = null, repairController = null;
  const pendingActions = new Set();
  let maintenanceUntil = 0, logQueue = Promise.resolve(), pendingLogs = 0;
  const log = (event, detail = {}) => {
    if (++pendingLogs > 64) { --pendingLogs; return; }
    const row = { at: new Date().toISOString(), event, ...detail };
    logQueue = logQueue.then(async () => {
      const stat = await fs.stat(logFile).catch(() => null);
      if (stat?.size > 2 * 1024 * 1024) await fs.rename(logFile, `${logFile}.1`).catch(() => {});
      await fs.appendFile(logFile, JSON.stringify(row) + '\n', { mode: 0o600 });
    }).catch(() => { console.error('[OCX:ERROR] Recovery log write failed.'); }).finally(() => { --pendingLogs; });
  };
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const actionFile = path.join(__dirname, 'windows-action.ps1');
  const actionArgs = mode => ['-NoProfile', '-NonInteractive', '-File', actionFile, '-Mode', mode,
    '-ProjectRoot', cfg.projectRoot, '-OpenCodexHome', cfg.openCodexHome, '-CodexHome', cfg.codexHome, '-Port', String(cfg.primaryPort)];
  const inspect = dependencies.inspect || (() => boundedCommand(powershell, actionArgs('Inspect')));
  const initial = await inspect();
  if (initial.ok && initial.value?.owned === true) { snapshot = initial.value; openingInspection = true; snapshotAt = now(); }
  try {
    const saved = await jsonFile(budgetFile);
    if (!policy.importSafeState(saved, now())) throw Error('invalid_budget');
  } catch (error) {
    if (error.code !== 'ENOENT') throw Error('guardian_budget_invalid');
  }
  try { recoveryBlocked = await jsonFile(blockedFile); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('guardian_block_invalid'); }
  // A previous companion may have exited while its external stop command was
  // still running. A new observer must not replay that uncertain transaction.
  if (policy.exportSafeState().recoveryStartedAt !== null && !recoveryBlocked) {
    recoveryBlocked = { version: 1, at: now(), reason: 'previous_recovery_uncertain' };
    await atomicJson(blockedFile, recoveryBlocked);
  }
  const server = await createGateway({
    port: cfg.listenPort, primaryOrigin, fallbackOrigin: cfg.fallback.origin,
    models: cfg.fallback.models, readFallbackKey: () => readKey(cfg.fallback.key, cfg),
    isPrimaryReady: () => primaryReady, isStopped: () => stopped,
    onPrimaryFailure: () => { primaryReady = false; readySince = null; readyIdentity = ''; }, log,
  });
  log('guardian_started', { pid: process.pid, port: cfg.listenPort, primaryPort: cfg.primaryPort });

  async function probe(route) {
    if (dependencies.probe) return dependencies.probe(route);
    try {
      const response = await fetch(primaryOrigin + route, { redirect: 'error', signal: AbortSignal.timeout(1200) });
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 8192) { await reader.cancel(); return { ok: false }; }
        chunks.push(next.value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return { ok: response.ok && body.service === 'opencodex' && (route !== '/readyz' || body.status === 'ready'), pid: body.pid, uptime: body.uptime };
    } catch { return { ok: false }; }
  }

  function dispatch(work) {
    const pending = work().catch(() => log('guardian_action_failed', { reason: 'local_state_failure' }));
    pendingActions.add(pending);
    pending.finally(() => pendingActions.delete(pending));
  }

  async function diagnose(reason) {
    if (repairRunning || stopped || closing) return;
    repairRunning = true;
    const controller = new AbortController();
    repairController = controller;
    const expectedIntentAt = lastIntentAt;
    try {
      const claimAt = now();
      const repairBudgetFile = path.join(cfg.openCodexHome, 'recovery-repair-budget.json');
      let budget = { attempts: [] };
      try { budget = await jsonFile(repairBudgetFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!Array.isArray(budget.attempts) || budget.attempts.some(at => !Number.isSafeInteger(at))) throw Error('invalid_repair_budget');
      const attempts = budget.attempts.filter(at => at >= claimAt - 3600000);
      if (attempts.length >= 2 || attempts.some(at => at >= (failureSince ?? claimAt))) return;
      await atomicJson(repairBudgetFile, { version: 1, attempts: [...attempts, claimAt] });
      const incidentDir = path.join(cfg.openCodexHome, 'recovery-incidents', new Date(claimAt).toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
      await fs.mkdir(incidentDir, { recursive: true, mode: 0o700 });
      const incident = { reason: snapshot?.pid && !processAlive(snapshot.pid) ? 'unexpected_exit' : 'health_not_ready',
        healthReady: primaryReady, pid: snapshot?.pid, attempts: policy.exportSafeState().attempts.length,
        timing: { durationMs: Math.max(0, claimAt - (failureSince ?? claimAt)), observedAtMs: claimAt } };
      await atomicJson(path.join(incidentDir, 'incident.json'), incident);
      // Retention is best-effort: losing a race here must not lose the incident that was
      // just recorded. Only directories whose name matches the shape written above count
      // against the budget, so a stray file cannot evict a real incident, and a reparse
      // point is never walked by `fs.rm(recursive)` the way the rest of this subsystem
      // refuses to follow one.
      try {
        const incidentsRoot = path.dirname(incidentDir);
        const entries = await fs.readdir(incidentsRoot, { withFileTypes: true });
        const generated = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()
          && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/.test(entry.name)).map(entry => entry.name);
        const stale = generated.sort().reverse().slice(REPAIR_INCIDENTS_KEPT);
        for (const name of stale) await fs.rm(path.join(incidentsRoot, name), { recursive: true, force: true });
      } catch { /* the next incident retries */ }
      if (dependencies.beforeRepairDispatch) await dependencies.beforeRepairDispatch();
      const freshIntent = parseIntent(await jsonFile(intentFile, 8192), now());
      if (closing || stopped || controller.signal.aborted || !freshIntent.valid
        || freshIntent.mode !== 'running' || freshIntent.at !== expectedIntentAt) return;
      log('glm_repair_started', { reason });
      const result = await (dependencies.repair || runRepair)({
        incident, signal: controller.signal,
        projectRoot: cfg.projectRoot, incidentDir, endpoint: cfg.repair.origin,
        model: 'glm-5.3-flash', readKey: () => readKey(cfg.repair.key, cfg),
        ...(cfg.repair.fallbackOrigin ? { fallbackEndpoint: cfg.repair.fallbackOrigin, readFallbackKey: () => readKey(cfg.repair.fallbackKey, cfg) } : {}),
      });
      await atomicJson(path.join(incidentDir, 'receipt.json'), result);
      lastRepair = { at: now(), outcome: result.outcome, failureClass: result.failureClass || null, candidateCount: result.candidateCount || 0 };
      log('glm_repair_finished', lastRepair);
    } catch { lastRepair = { at: now(), outcome: 'failed', failureClass: 'LOCAL_OR_NETWORK' }; log('glm_repair_failed', lastRepair); }
    finally { repairRunning = false; if (repairController === controller) repairController = null; }
  }

  async function recover() {
    if (recovering || stopped || closing || recoveryBlocked || !snapshot?.owned) return;
    if (policy.markRecoveryStarted(now()).reason !== 'recovery-started') return;
    recovering = true;
    const expected = { ...snapshot };
    log('recovery_attempt_started', { pid: expected.pid });
    try {
      await atomicJson(budgetFile, policy.exportSafeState());
      const freshIntent = parseIntent(await jsonFile(intentFile, 8192), now());
      if (!freshIntent.valid || freshIntent.mode !== 'running' || freshIntent.at !== lastIntentAt) throw Error('intent_changed');
      const result = dependencies.action ? await dependencies.action(expected) : await boundedCommand(powershell, [...actionArgs('Recover'),
        '-ExpectedPid', String(expected.pid || 0), '-ExpectedStart', String(expected.start || ''),
        '-ExpectedLauncherPid', String(expected.launcherPid || 0), '-ExpectedLauncherStart', String(expected.launcherStart || '')],
      { timeoutMs: 145000 });
      // An OS start receipt is not readiness. The normal probe must observe and
      // identity-check the new process before the policy can leave recovery.
      lastRecovery = { at: now(), ok: recoveryActionSucceeded(result), reason: result.value?.reason || (result.uncertain ? 'stop_result_uncertain' : 'action_failed') };
      if (!recoveryActionSucceeded(result)) {
        policy.markRecoveryFinished({ ok: false }, now());
        log('recovery_attempt_failed', { reason: result.uncertain ? 'stop_result_uncertain' : 'recovery_action_failed' });
        if (result.uncertain || ['stop-uncertain', 'stop-not-confirmed'].includes(result.value?.reason)) {
          recoveryBlocked = { version: 1, at: now(), intentAt: lastIntentAt, reason: 'stop_result_uncertain' };
          await atomicJson(blockedFile, recoveryBlocked);
        }
        dispatch(() => diagnose('recovery_action_failed'));
      } else {
        policy.markRecoveryFinished({ ok: true }, now());
        log('recovery_start_received', { confirmedReady: false });
        const updated = await inspect();
        // Recovery replaced the process, so this is a fresh opening inspection: the next
        // tick that agrees on the pid lends it a boot instant instead of paying for a
        // second, identical spawn.
        if (updated.ok && updated.value?.owned === true) { snapshot = updated.value; snapshotBoot = null; openingInspection = true; snapshotAt = now(); }
      }
    } catch { policy.markRecoveryFinished({ ok: false }, now()); log('recovery_aborted', { reason: 'intent_or_identity_changed' }); }
    finally { recovering = false; await atomicJson(budgetFile, policy.exportSafeState()).catch(() => {}); }
  }

  async function observe() {
    let rawIntent;
    try { rawIntent = await jsonFile(intentFile, 8192); } catch { rawIntent = null; }
    const intent = parseIntent(rawIntent, now());
    const signature = `${intent.mode}|${intent.at}|${intent.until}`;
    if (signature !== lastIntentSignature) {
      const wasStopped = stopped;
      const hadIntent = lastIntentAt >= 0;
      lastIntentSignature = signature;
      lastIntentAt = intent.at;
      primaryReady = false;
      readyIdentity = ''; readySince = null;
      repairController?.abort();
      stopped = intent.mode === 'stopped';
      maintenanceUntil = intent.mode === 'maintenance' ? intent.until : 0;
      if (hadIntent && !stopped && (wasStopped || currentState === 'foreign')) policy.reset({ now: now() });
      if (hadIntent && intent.mode === 'running' && recoveryBlocked) {
        // A fresh durable running intent is a new instruction from the operator.
        // The uncertain-stop latch must not disable recovery for this home for
        // the rest of the process' life, or a restart would re-read it from disk.
        recoveryBlocked = null;
        await fs.unlink(blockedFile).catch(() => {});
      }
      log('intent_observed', { mode: intent.mode, valid: intent.valid });
    }
    stopped = intent.mode === 'stopped';
    if (stopped || intent.mode === 'maintenance') repairController?.abort();
    const [health, ready] = await Promise.all([probe('/healthz'), probe('/readyz')]);
    const healthPid = Number.isInteger(health.pid) && health.pid > 0 ? health.pid : null;
    // Inspect resolves the owning process tree through WMI and is far more expensive than
    // a health probe, so a healthy steady state must not re-run it every couple of seconds.
    // Skipping is only safe for a generation the snapshot can corroborate: Windows reuses
    // pids, so a pid alone cannot tell a wrap apart from the process it replaced. The boot
    // instant derived from /healthz's `uptime` can, and a probe that reports no uptime is
    // not corroborated at all, so it is always inspected.
    const boot = Number.isFinite(health.uptime) ? now() - health.uptime * 1000 : null;
    // The opening inspection resolved this very generation, so the first probe that agrees on
    // its pid lends it a boot instant instead of paying for a second, identical spawn.
    if (openingInspection && boot !== null && healthPid === snapshot?.pid) { snapshotBoot = boot; snapshotAt = now(); }
    openingInspection = false;
    // Corroboration decays. `snapshot` carries the launcher identity that `recover()` later
    // hands to the action script, and pid+boot agreeing forever would otherwise freeze it
    // even if the launching process went away behind us. A minute between re-resolutions
    // costs one spawn per ~30 ticks instead of one per tick.
    const corroborated = boot !== null && snapshotBoot !== null && Math.abs(boot - snapshotBoot) <= BOOT_TOLERANCE_MS
      && now() - snapshotAt <= 60_000;
    if (healthPid && (healthPid !== snapshot?.pid || !corroborated)) {
      const updated = await inspect();
      if (updated.ok && updated.value?.owned === true && updated.value.pid === healthPid) {
        snapshot = updated.value;
        snapshotBoot = boot;
        snapshotAt = now();
        if (currentState === 'foreign') policy.reset({ now: now() });
      } else { snapshot = null; snapshotBoot = null; }
    }
    const observedReady = !stopped && health.ok && ready.ok && healthPid === ready.pid && snapshot?.owned === true && snapshot.pid === healthPid;
    if (!observedReady && !stopped && failureSince === null) failureSince = now();
    const sample = {
      ready: observedReady, health: health.ok, alive: !!snapshot?.pid && processAlive(snapshot.pid), owned: snapshot?.owned === true,
      manualStop: stopped, launcherAlive: snapshot?.launcherPid ? processAlive(snapshot.launcherPid) : false,
    };
    let decision;
    if (stopped) decision = policy.observe(sample, now());
    else if (recovering) decision = { state: 'recovering', useFallback: true, action: 'none' };
    else if (now() < maintenanceUntil) decision = { state: 'maintenance', useFallback: !observedReady, action: 'none' };
    else if (!snapshot && healthPid === null) decision = { state: 'waiting_for_owner', useFallback: true, action: 'none' };
    else decision = policy.observe(sample, now());
    // Admission is per verified process generation and durable running intent.
    // Policy reset/import must never allow a fresh process to skip this window.
    const identity = observedReady ? `${snapshot.pid}|${snapshot.start}|${snapshot.launcherPid}|${snapshot.launcherStart}` : '';
    if (!identity || identity !== readyIdentity) { readyIdentity = identity; readySince = identity ? now() : null; }
    const stableReady = readySince !== null && now() - readySince >= policy.options.recoveryStableMs;
    primaryReady = observedReady && stableReady && !decision.useFallback;
    if (decision.state === 'healthy' && !primaryReady) decision = { ...decision, state: 'stabilizing', useFallback: true };
    if (primaryReady) failureSince = null;
    if (decision.state !== currentState) { currentState = decision.state; log('state_changed', { state: currentState, ready: primaryReady }); }
    if (decision.state === 'stopped') stopped = true;
    // `at` is a wall-clock stamp and this loop runs every couple of seconds, so the status
    // payload always differs while nothing it records has changed: dedup on the state, not
    // on the timestamp, or the inspect throttle above buys nothing.
    const status = state();
    const statusKey = JSON.stringify({ ...status, at: 0 });
    if (statusKey !== lastStatusKey) {
      lastStatusKey = statusKey;
      await atomicJson(statusFile, status);
    }
    await atomicJson(budgetFile, policy.exportSafeState());
    if (decision.action === 'recover' && !recoveryBlocked) dispatch(recover);
    if (decision.action === 'diagnose') dispatch(() => diagnose(decision.reason || 'recovery_budget_exhausted'));
    if (recoveryBlocked && !observedReady && !stopped && !recovering) dispatch(() => diagnose('recovery_result_uncertain'));
  }
  async function tick() {
    try { await observe(); }
    catch (error) {
      primaryReady = false; readyIdentity = ''; readySince = null;
      currentState = 'observation_failed';
      repairController?.abort();
      throw error;
    }
  }
  function state() {
    return { version: 1, at: now(), pid: process.pid, primaryPid: snapshot?.pid || null, state: currentState,
      primaryReady, recovering, repairRunning, recoveryBlocked: Boolean(recoveryBlocked), listenPort: cfg.listenPort,
      fallbackModels: Object.keys(cfg.fallback.models), fallbackConfigured: Object.keys(cfg.fallback.models).length > 0,
      lastRecovery, lastRepair };
  }
  const close = async () => {
    closing = true;
    repairController?.abort();
    await server.close();
    await Promise.allSettled([...pendingActions]);
    log('guardian_stopping', { pid: process.pid });
    await logQueue;
  };
  return { tick, close, state, server, drain: () => Promise.allSettled([...pendingActions]) };
}

async function startGuardian(configFile) {
  const guardian = await createGuardian(configFile);
  let closing = false;
  const stop = () => { closing = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
  while (!closing) {
    const start = Date.now();
    try { await guardian.tick(); } catch { console.error('[OCX:WARN] Guardian observation failed; inspect recovery state.'); }
    await pause(Math.max(50, 2000 - (Date.now() - start)));
  }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await guardian.close(); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') { console.error('Usage: node main.cjs --config <recovery-guardian.json>'); process.exitCode = 2; }
  else startGuardian(args[1]).catch(() => { console.error('[OCX:ERROR] Recovery guardian failed; inspect its local state and configuration.'); process.exitCode = 1; });
}
module.exports = { startGuardian, createGuardian, loadSettings, readKey, jsonFile, atomicJson, boundedCommand, parseIntent, recoveryActionSucceeded };
