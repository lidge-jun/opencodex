/**
 * Selection rounds for a link with several routes (structure/remote-link.md, "Routes"). A round
 * probes the eligible routes in order with the pinned route probe, starts the -R tunnel on the
 * first that answers as a CANDIDATE, waits for OpenSSH to confirm the remote listener was granted
 * to it, and then proves readiness end to end: the Child fetches its own /v1/catalog with a fresh
 * proof id, its link relay carries that request to this Home with relay authentication, and the
 * Home must see the id admitted under this tunnel's generation while the same request completes
 * with a catalog. Only then is the link connected.
 *
 * One-route links never come here. Nothing in this module stops a tunnel that may carry traffic
 * for a non-failure reason; a candidate that has not proven readiness by its deadline is a failed
 * route and is stopped, which is today's reconnect contract for any request on it.
 */
import { randomBytes } from "node:crypto";
import { buildExecArgv, buildRouteProbeArgv, remoteOcxArgv } from "./ssh-argv";
import { isChildHealth, parseChildHttp, remoteChildHttpArgv } from "./remote-probe";
import { requireRemotePlatform } from "./remote-platform";
import { aggregateRouteClass, composeGrantTap, routeCooldownMs, routeOutcomeOfStderr, type RouteOutcomeClass } from "./route-select";
import type { RouteProofHandle, RouteProofRegistry } from "./route-proof";
import { SSH_MAX_OUTPUT_BYTES, type SshChild, type SshRunner } from "./ssh-runner";
import { effectiveLinkRoutes, type LinkRecord } from "./store";
import { exitCause, type TunnelCause } from "./tunnel-history";
import type { StderrClass, TunnelEvent, TunnelState } from "./tunnel-state";

/** One route probe, supervisor clock. */
export const ROUTE_PROBE_MS = 10_000;
/**
 * A candidate's budget, twice: from its spawn to the grant of its remote listener, and then from that
 * grant to its proven readiness (discovery, health and every trigger). A slow route that spends most
 * of the first budget on the ssh handshake still has the whole second one for its readiness execs.
 * Not measured on a real slow route. A candidate's readiness deadline is at most 2 x READY_PROOF_MS
 * after its spawn; the first supervisor tick at or after that deadline stops it (SIGTERM, then SIGKILL
 * after CANDIDATE_KILL_GRACE_MS).
 */
export const READY_PROOF_MS = 30_000;
/** One correlated trigger at most. */
export const PROOF_ATTEMPT_MS = 15_000;
/** Between the end of one failed trigger and the next. */
export const PROOF_RETRY_MS = 2_000;
/** SIGTERM to SIGKILL, and SIGKILL to giving up on observing a stopped candidate's exit. */
export const CANDIDATE_KILL_GRACE_MS = 2_000;
/** The ssh client check, and how long an unsupported answer stands. */
export const CLIENT_CHECK_MS = 5_000;
export const CLIENT_RECHECK_MS = 10 * 60_000;
// The Child's whole effective config: enrollment accepts up to the runner maximum (#8380), so a
// Child that enrolled with a large config must also pass this step on every route.
const CONFIG_MAX_BYTES = SSH_MAX_OUTPUT_BYTES;
const CATALOG_MAX_BYTES = 4 * 1024 * 1024;

export type RouteBlock = "ssh_client_unsupported" | "stop_unconfirmed";

export interface LinkRouteStatus {
  routes: Array<{ name: string; eligibleAt: number | null; lastOutcome: { class: RouteOutcomeClass; at: number } | null }>;
  /** The route of the proven tunnel and when it was proven; null while none is proven. */
  route: { name: string; index: number; since: number } | null;
  blocked: RouteBlock | null;
}

/** What the supervisor lends a round. Every call is synchronous except the runner. */
export interface RouteRoundHost {
  runner: Pick<SshRunner, "run">;
  now(): number;
  random(): number;
  knownHostsFile(): string;
  listenerPort(): number | null;
  /** The record as the supervisor currently holds it. */
  record(linkId: string): LinkRecord | undefined;
  /** stopping, held, or an earlier tunnel that may still live (orphan-unverified). */
  blocked(linkId: string): boolean;
  /** Lifecycle work (reload, stop, reconnect) is running: deadlines advance, no new probe or tunnel starts. */
  busy(): boolean;
  /** Is this child still the link's registered tunnel? */
  ownsChild(linkId: string, child: SshChild): boolean;
  /** Start the -R tunnel on a route, register it as the link's child, and name its generation. */
  spawnTunnel(record: LinkRecord, destination: string, stderrLine: (line: string) => boolean): { child: SshChild; generation: string; setupFailed?: boolean };
  /** The operator's capture tap for this spawn, if a capture window is open. */
  captureTap(linkId: string): ((line: string) => boolean) | undefined;
  setEvent(linkId: string, event: TunnelEvent, cause?: TunnelCause | null): TunnelState;
  /** Push a scheduled retry later without recording a transition. */
  deferRetry(linkId: string, at: number): void;
  /** Count one ssh attempt in the tunnel history (once per round). */
  attempted(linkId: string): void;
  routeProof?: RouteProofRegistry;
  warn(message: string): void;
}

interface RouteBook { name: string; outcome: RouteOutcomeClass | null; outcomeAt: number | null; probeFailures: number; tunnelFailures: number; eligibleAt: number }

interface Proof {
  platform?: "posix" | "windows";
  port?: number;
  healthy?: boolean;
  inFlight: boolean;
  nextAt: number;
  handle?: RouteProofHandle;
}

type Phase =
  | { kind: "client" }
  | { kind: "probe"; route: string; startedAt: number; abort: AbortController }
  | {
    kind: "candidate"; route: string; child: SshChild; generation: string; spawnedAt: number;
    grantedAt?: number; refused?: boolean; failure?: RouteOutcomeClass; stopAt?: number; killed?: boolean;
    abort: AbortController; proof: Proof;
  }
  | { kind: "halted"; route: string; child: SshChild; failure: RouteOutcomeClass }
  /** A probe that settled while lifecycle work ran: no deadline applies; round.resume continues it. */
  | { kind: "deferred" };

interface Round {
  token: number;
  queue: string[];
  phase: Phase;
  /** New work held back while lifecycle work runs; the next free tick starts it. */
  resume?: () => void;
}

interface LinkRoutes {
  books: Map<string, RouteBook>;
  round?: Round;
  active?: { route: string; child: SshChild; since: number };
  blocked: RouteBlock | null;
}

type ClientState = { kind: "unknown" } | { kind: "checking"; abort: AbortController; epoch: number } | { kind: "ok" } | { kind: "unsupported"; at: number };

export interface RouteRounds {
  isMultiRoute(record: LinkRecord): boolean;
  /** Start a round for a due attempt. False when the link is not multi-route. */
  begin(record: LinkRecord): boolean;
  tick(linkId: string): void;
  /** True when this child belonged to a multi-route round or proven tunnel (the exit is handled). */
  exited(linkId: string, child: SshChild, stderr: string): boolean;
  /** Drop rounds and proofs: a stop, hold, reconnect or removal is taking the link down. */
  cancel(linkId: string): void;
  /** Forget everything about a link (removed, or no longer multi-route). */
  forget(linkId: string): void;
  /** A reload changed this link's route list but kept its tunnel. */
  routesChanged(record: LinkRecord): void;
  /** Adopt a running one-route tunnel on the alias when the link gains routes. */
  adopt(record: LinkRecord, child: SshChild, connectedSince: number | null): void;
  /** Proven or candidate route of a link's live child, for the reload check. */
  liveRoute(linkId: string): string | undefined;
  inRound(linkId: string): boolean;
  status(linkId: string): LinkRouteStatus | undefined;
  /** The ssh client answer changes (a reload of a multi-route record re-reads it). */
  recheckClient(): void;
  stop(): void;
}

export function createRouteRounds(host: RouteRoundHost): RouteRounds {
  const links = new Map<string, LinkRoutes>();
  let tokens = 0;
  let client: ClientState = { kind: "unknown" };
  let clientEpoch = 0;
  let stopped = false;

  const isMultiRoute = (record: LinkRecord): boolean => record.direction === "hub-initiated" && effectiveLinkRoutes(record).length > 1;

  const linkFor = (record: LinkRecord): LinkRoutes => {
    let link = links.get(record.id);
    if (!link) { link = { books: new Map(), blocked: null }; links.set(record.id, link); }
    const names = effectiveLinkRoutes(record);
    for (const name of names) if (!link.books.has(name)) link.books.set(name, { name, outcome: null, outcomeAt: null, probeFailures: 0, tunnelFailures: 0, eligibleAt: 0 });
    for (const name of [...link.books.keys()]) if (!names.includes(name)) link.books.delete(name);
    return link;
  };

  const current = (linkId: string, round: Round): boolean => !stopped && links.get(linkId)?.round === round && !host.blocked(linkId);

  const fail = (link: LinkRoutes, route: string, outcome: RouteOutcomeClass, kind: "probe" | "tunnel"): void => {
    const book = link.books.get(route);
    if (!book) return;
    const n = kind === "probe" ? ++book.probeFailures : ++book.tunnelFailures;
    book.outcome = outcome;
    book.outcomeAt = host.now();
    book.eligibleAt = host.now() + routeCooldownMs(outcome, n, host.random);
  };

  const minEligible = (link: LinkRoutes): number => Math.min(...[...link.books.values()].map(book => book.eligibleAt));

  const aggregate = (link: LinkRoutes): StderrClass => aggregateRouteClass([...link.books.values()].map(book => book.outcome));

  /** The round is over without a proven route: one reducer exit with the aggregate class. */
  const endRound = (linkId: string, link: LinkRoutes): void => {
    link.round = undefined;
    host.routeProof?.forget(linkId);
    const cls = aggregate(link);
    host.setEvent(linkId, { type: "exit", now: host.now(), stderrClass: cls }, exitCause(cls));
    host.deferRetry(linkId, minEligible(link));
  };

  const next = (linkId: string, link: LinkRoutes, round: Round): void => {
    if (!current(linkId, round)) return;
    if (host.busy()) {
      round.phase = { kind: "deferred" };
      round.resume = () => next(linkId, link, round);
      return;
    }
    const record = host.record(linkId);
    if (!record) { link.round = undefined; return; }
    const route = round.queue.shift();
    if (route === undefined) { endRound(linkId, link); return; }
    if (!link.books.has(route)) { next(linkId, link, round); return; }
    probe(linkId, link, round, record, route);
  };

  const probe = (linkId: string, link: LinkRoutes, round: Round, record: LinkRecord, route: string): void => {
    const abort = new AbortController();
    const phase: Phase = { kind: "probe", route, startedAt: host.now(), abort };
    round.phase = phase;
    let argv: string[];
    try {
      argv = buildRouteProbeArgv({ alias: record.alias, destination: route, knownHostsFile: host.knownHostsFile(), route: record.explicitRoute ?? null });
    } catch {
      fail(link, route, "transient", "probe");
      next(linkId, link, round);
      return;
    }
    void host.runner.run(argv, { timeoutMs: ROUTE_PROBE_MS, signal: abort.signal }).then(result => {
      if (!current(linkId, round) || round.phase !== phase) return;
      // Past its deadline on the supervisor clock, a result is a timeout even if the tick has not run yet.
      const inTime = host.now() < phase.startedAt + ROUTE_PROBE_MS;
      if (inTime && result.code === 0 && result.stdout.trim() === "ocx-link-probe") {
        const book = link.books.get(route);
        if (book) book.probeFailures = 0;
        if (host.busy()) {
          const deferred: Phase = { kind: "deferred" };
          round.phase = deferred;
          round.resume = () => { if (current(linkId, round) && round.phase === deferred) candidate(linkId, link, round, route); };
        } else {
          candidate(linkId, link, round, route);
        }
        return;
      }
      // A late answer is a timeout whatever it says: a late host-key or auth message never decides the route.
      fail(link, route, !inTime || result.code === 0 ? "transient" : routeOutcomeOfStderr(result.stderr), "probe");
      next(linkId, link, round);
    }, () => {
      if (!current(linkId, round) || round.phase !== phase) return;
      fail(link, route, "transient", "probe");
      next(linkId, link, round);
    });
  };

  const candidate = (linkId: string, link: LinkRoutes, round: Round, route: string): void => {
    const record = host.record(linkId);
    const listenerPort = host.listenerPort();
    if (!record || listenerPort === null) { endRound(linkId, link); return; }
    let phase: Extract<Phase, { kind: "candidate" }> | undefined;
    const tap = composeGrantTap(record.tunnelPort, listenerPort, verdict => {
      if (!phase || round.phase !== phase) return;
      if (verdict === "refused") { phase.refused = true; return; }
      if (phase.grantedAt === undefined) { phase.grantedAt = host.now(); phase.proof.nextAt = host.now(); }
    }, host.captureTap(linkId));
    let spawned: { child: SshChild; generation: string };
    let setupFailed = false;
    try {
      const result = host.spawnTunnel(record, route, tap);
      spawned = result;
      setupFailed = result.setupFailed === true;
    } catch {
      fail(link, route, "transient", "tunnel");
      next(linkId, link, round);
      return;
    }
    phase = { kind: "candidate", route, child: spawned.child, generation: spawned.generation, spawnedAt: host.now(), abort: new AbortController(), proof: { inFlight: false, nextAt: Number.POSITIVE_INFINITY } };
    round.phase = phase;
    // The tunnel started but could not be recorded: stop it and wait for its exit before moving on.
    if (setupFailed) stopCandidate(linkId, phase, "transient");
  };

  /** Stop a candidate that failed as a route (today's reconnect contract for anything on it). */
  const stopCandidate = (linkId: string, phase: Extract<Phase, { kind: "candidate" }>, failure: RouteOutcomeClass): void => {
    if (phase.stopAt !== undefined) return;
    phase.failure = failure;
    phase.stopAt = host.now();
    phase.abort.abort();
    phase.proof.handle?.dispose();
    host.routeProof?.forget(linkId);
    try { phase.child.kill("SIGTERM"); } catch { /* already gone */ }
  };

  /**
   * Until the grant: READY_PROOF_MS from spawn. After it: READY_PROOF_MS from the grant, and a grant
   * seen after that first deadline (before the next tick stopped the candidate) counts from it, so the
   * deadline is never later than spawn + 2 x READY_PROOF_MS.
   */
  const readinessDeadline = (phase: Extract<Phase, { kind: "candidate" }>): number =>
    (phase.grantedAt === undefined ? phase.spawnedAt : Math.min(phase.grantedAt, phase.spawnedAt + READY_PROOF_MS)) + READY_PROOF_MS;

  const proven = (linkId: string, link: LinkRoutes, round: Round, phase: Extract<Phase, { kind: "candidate" }>): void => {
    // A child whose exit was already observed is never promoted, however late its proof settles.
    if (!host.ownsChild(linkId, phase.child)) return;
    phase.proof.handle?.dispose();
    host.routeProof?.forget(linkId);
    link.round = undefined;
    link.active = { route: phase.route, child: phase.child, since: host.now() };
    const book = link.books.get(phase.route);
    if (book) { book.tunnelFailures = 0; book.probeFailures = 0; book.outcome = null; book.outcomeAt = null; book.eligibleAt = 0; }
    host.setEvent(linkId, { type: "ready", now: host.now() });
    void round;
  };

  const execOnRoute = (record: LinkRecord, route: string, argv: readonly string[], deadline: number, signal: AbortSignal, maxOutputBytes?: number) =>
    host.runner.run(buildExecArgv({ alias: record.alias, destination: route, argv, knownHostsFile: host.knownHostsFile(), route: record.explicitRoute ?? null }), {
      timeoutMs: Math.max(1, Math.ceil(deadline - host.now())),
      signal,
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    });

  /** One readiness attempt: discovery and identity once per candidate, then a correlated trigger. */
  const attempt = async (linkId: string, link: LinkRoutes, round: Round, phase: Extract<Phase, { kind: "candidate" }>): Promise<void> => {
    const record = host.record(linkId);
    if (!record) return;
    const live = (): boolean => current(linkId, round) && round.phase === phase && phase.stopAt === undefined
      && host.ownsChild(linkId, phase.child);
    const candidateDeadline = readinessDeadline(phase);
    const { proof, abort } = phase;
    try {
      if (!proof.platform) {
        proof.platform = record.remotePlatform ?? await requireRemotePlatform(host.runner, record.alias, record.explicitRoute ?? null, host.knownHostsFile(), {
          destination: phase.route, timeoutMs: Math.max(1, Math.min(10_000, Math.ceil(candidateDeadline - host.now()))), signal: abort.signal,
        });
        if (!live()) return;
      }
      if (proof.port === undefined) {
        const configured = await execOnRoute(record, phase.route, remoteOcxArgv(["config", "show", "--json"], proof.platform), candidateDeadline, abort.signal, CONFIG_MAX_BYTES);
        if (!live()) return;
        const port = configured.code === 0 ? childPortOf(configured.stdout) : undefined;
        if (port === undefined) return;
        proof.port = port;
      }
      if (!proof.healthy) {
        const health = await execOnRoute(record, phase.route, remoteChildHttpArgv(proof.port, "healthz", candidateDeadline - host.now(), proof.platform), candidateDeadline, abort.signal);
        if (!live()) return;
        let body: unknown = null;
        try { body = health.code === 0 ? parseChildHttp(health.stdout) : null; } catch { body = null; }
        if (!isChildHealth(body, "client", proof.port)) return;
        proof.healthy = true;
      }
      if (!host.routeProof) return;
      const attemptDeadline = Math.min(host.now() + PROOF_ATTEMPT_MS, candidateDeadline);
      const proofId = randomBytes(16).toString("hex");
      proof.handle?.dispose();
      proof.handle = host.routeProof.register({ linkId, apiKeyId: record.apiKeyId, generation: phase.generation, proofId, expiresAt: attemptDeadline });
      const catalog = await execOnRoute(record, phase.route,
        remoteChildHttpArgv(proof.port, "v1/catalog", attemptDeadline - host.now(), proof.platform, proofId), attemptDeadline, abort.signal, CATALOG_MAX_BYTES);
      if (!live()) return;
      let body: unknown = null;
      try { body = catalog.code === 0 ? parseChildHttp(catalog.stdout) : null; } catch { body = null; }
      const handle = proof.handle;
      // Both deadlines hold at promotion too: a result that settles late, before the next tick, does not count.
      const settledAt = host.now();
      if (isCatalog(body) && handle?.admitted() && settledAt <= attemptDeadline && settledAt < candidateDeadline) {
        proven(linkId, link, round, phase);
        return;
      }
    } catch { /* a failed or aborted step; retried below while time remains */ }
    finally {
      proof.inFlight = false;
      proof.nextAt = host.now() + PROOF_RETRY_MS;
    }
  };

  const startClientCheck = (): void => {
    if (client.kind === "checking") return;
    const abort = new AbortController();
    const epoch = ++clientEpoch;
    client = { kind: "checking", abort, epoch };
    void host.runner.run(["ssh", "-V"], { timeoutMs: CLIENT_CHECK_MS, signal: abort.signal }).then(result => {
      if (stopped || clientEpoch !== epoch) return;
      client = result.code === 0 && /OpenSSH/.test(result.stderr + result.stdout) ? { kind: "ok" } : { kind: "unsupported", at: host.now() };
    }, () => {
      if (stopped || clientEpoch !== epoch) return;
      client = { kind: "unsupported", at: host.now() };
    });
  };

  /** A round waiting for the client answer, or a fresh round that may need it. */
  const proceed = (linkId: string, link: LinkRoutes, round: Round): void => {
    if (client.kind === "unsupported" && host.now() >= client.at + CLIENT_RECHECK_MS) client = { kind: "unknown" };
    if (client.kind === "unknown") startClientCheck();
    if (client.kind === "checking") { round.phase = { kind: "client" }; return; }
    if (client.kind === "unsupported") {
      link.round = undefined;
      link.blocked = "ssh_client_unsupported";
      host.setEvent(linkId, { type: "exit", now: host.now(), stderrClass: "network" }, "unknown");
      host.deferRetry(linkId, client.at + CLIENT_RECHECK_MS);
      return;
    }
    if (link.blocked === "ssh_client_unsupported") link.blocked = null;
    next(linkId, link, round);
  };

  return {
    isMultiRoute,
    begin(record) {
      if (!isMultiRoute(record)) return false;
      if (stopped || host.blocked(record.id)) return true;
      const link = linkFor(record);
      if (link.round || link.active) return true;
      const now = host.now();
      const queue = effectiveLinkRoutes(record).filter(name => (link.books.get(name)?.eligibleAt ?? 0) <= now);
      if (queue.length === 0) { host.deferRetry(record.id, minEligible(link)); return true; }
      const round: Round = { token: ++tokens, queue, phase: { kind: "client" } };
      link.round = round;
      host.attempted(record.id);
      host.setEvent(record.id, { type: "spawn", now });
      proceed(record.id, link, round);
      return true;
    },
    tick(linkId) {
      const link = links.get(linkId);
      const round = link?.round;
      if (!link || !round || stopped) return;
      const now = host.now();
      const phase = round.phase;
      if (round.resume && !host.busy()) {
        const resume = round.resume;
        round.resume = undefined;
        resume();
        return;
      }
      if (phase.kind === "client") { if (client.kind !== "checking") proceed(linkId, link, round); return; }
      if (phase.kind === "probe") {
        if (now - phase.startedAt >= ROUTE_PROBE_MS) {
          phase.abort.abort();
          fail(link, phase.route, "transient", "probe");
          next(linkId, link, round);
        }
        return;
      }
      if (phase.kind === "halted" || phase.kind === "deferred") return;
      if (phase.stopAt !== undefined) {
        if (!phase.killed && now - phase.stopAt >= CANDIDATE_KILL_GRACE_MS) {
          phase.killed = true;
          try { phase.child.kill("SIGKILL"); } catch { /* already gone */ }
        }
        if (now - phase.stopAt >= 2 * CANDIDATE_KILL_GRACE_MS) {
          // The stopped candidate's exit was never observed: fail closed until it is.
          round.phase = { kind: "halted", route: phase.route, child: phase.child, failure: phase.failure ?? "readiness" };
          link.blocked = "stop_unconfirmed";
          host.warn(`[link] route candidate exit unconfirmed link=${linkId}`);
        }
        return;
      }
      if (now >= readinessDeadline(phase)) {
        // Unlike a one-route tunnel, which reads connected after its 5 s grace and is never stopped
        // for lacking proof, a candidate with no proof by now is stopped: a granted forward whose
        // relay cannot authenticate or serve looks the same as a slow one, and keeping it would
        // starve the next route forever. A request already on it fails toward its caller, as on
        // any reconnect; once a route is proven it is never stopped for lack of later proofs.
        stopCandidate(linkId, phase, phase.grantedAt === undefined ? "grant_unobserved" : "readiness");
        return;
      }
      if (phase.grantedAt !== undefined && !phase.proof.inFlight && now >= phase.proof.nextAt) {
        phase.proof.inFlight = true;
        void attempt(linkId, link, round, phase);
      }
    },
    exited(linkId, child, stderr) {
      const link = links.get(linkId);
      if (!link) return false;
      if (link.active?.child === child) {
        const route = link.active.route;
        link.active = undefined;
        fail(link, route, routeOutcomeOfStderr(stderr), "tunnel");
        if (!stopped) endRoundAfterActive(linkId, link);
        return true;
      }
      const round = link.round;
      const phase = round?.phase;
      if (!round || !phase || (phase.kind !== "candidate" && phase.kind !== "halted") || phase.child !== child) return false;
      const failure = phase.kind === "halted" ? phase.failure
        : phase.failure ?? (phase.refused ? "forward" : routeOutcomeOfStderr(stderr));
      if (phase.kind === "candidate") { phase.abort.abort(); phase.proof.handle?.dispose(); }
      host.routeProof?.forget(linkId);
      if (link.blocked === "stop_unconfirmed") link.blocked = null;
      fail(link, phase.route, failure, "tunnel");
      if (!stopped && !host.blocked(linkId)) next(linkId, link, round);
      return true;
    },
    cancel(linkId) {
      const link = links.get(linkId);
      if (!link) return;
      const phase = link.round?.phase;
      if (phase?.kind === "probe" || phase?.kind === "candidate") phase.abort.abort();
      if (phase?.kind === "candidate") phase.proof.handle?.dispose();
      link.round = undefined;
      link.active = undefined;
      if (link.blocked === "stop_unconfirmed") link.blocked = null;
      host.routeProof?.forget(linkId);
    },
    forget(linkId) {
      this.cancel(linkId);
      links.delete(linkId);
    },
    routesChanged(record) {
      const link = links.get(record.id);
      if (!link) return;
      linkFor(record);
      const round = link.round;
      if (round?.phase.kind === "probe" || round?.phase.kind === "client" || round?.phase.kind === "deferred") {
        // Nothing carries traffic yet: start over on the new list.
        if (round.phase.kind === "probe") round.phase.abort.abort();
        round.resume = undefined;
        round.queue = effectiveLinkRoutes(record).filter(name => (link.books.get(name)?.eligibleAt ?? 0) <= host.now());
        proceed(record.id, link, round);
        return;
      }
      if (round) round.queue = round.queue.filter(name => link.books.has(name));
    },
    adopt(record, child, connectedSince) {
      if (!isMultiRoute(record)) return;
      const link = linkFor(record);
      if (link.round || link.active) return;
      if (connectedSince !== null) link.active = { route: record.alias, child, since: connectedSince };
    },
    liveRoute(linkId) {
      const link = links.get(linkId);
      const phase = link?.round?.phase;
      return link?.active?.route ?? (phase && (phase.kind === "candidate" || phase.kind === "halted") ? phase.route : undefined);
    },
    inRound(linkId) {
      return links.get(linkId)?.round !== undefined;
    },
    status(linkId) {
      const link = links.get(linkId);
      const record = host.record(linkId);
      if (!link || !record) return undefined;
      const names = effectiveLinkRoutes(record);
      return {
        routes: names.map(name => {
          const book = link.books.get(name);
          return {
            name,
            eligibleAt: book && book.eligibleAt > host.now() ? book.eligibleAt : null,
            lastOutcome: book?.outcome && book.outcomeAt !== null ? { class: book.outcome, at: book.outcomeAt } : null,
          };
        }),
        route: link.active ? { name: link.active.route, index: names.indexOf(link.active.route), since: link.active.since } : null,
        blocked: link.blocked,
      };
    },
    recheckClient() {
      if (client.kind === "checking") client.abort.abort();
      clientEpoch += 1;
      client = { kind: "unknown" };
    },
    stop() {
      stopped = true;
      if (client.kind === "checking") client.abort.abort();
      for (const linkId of [...links.keys()]) this.cancel(linkId);
    },
  };

  function endRoundAfterActive(linkId: string, link: LinkRoutes): void {
    const cls = aggregate(link);
    host.setEvent(linkId, { type: "exit", now: host.now(), stderrClass: cls }, exitCause(cls));
    host.deferRetry(linkId, minEligible(link));
  }
}

function childPortOf(stdout: string): number | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const port = (value as Record<string, unknown>).port;
    return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

function isCatalog(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).models);
}

