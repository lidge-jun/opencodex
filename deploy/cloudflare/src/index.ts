import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import { containerEnv, edgeDecision, envFingerprint, type SecretSource } from "./container-env";
import { LeaseState } from "./lease";
import { handleStateRequest } from "./state-routes";

export { ContainerProxy };

export interface Env extends SecretSource {
  HUB: DurableObjectNamespace<OpencodexHub>;
  STATE: R2Bucket;
  OCX_SLEEP_AFTER?: string;
  OCX_EXPOSE_MANAGEMENT_API?: string;
  /** Any new value discards the saved state once; see `applyPendingReset`. */
  OCX_DISCARD_SAVED_STATE?: string;
}

// Must match STATE_ORIGIN in docker/cloudflare-supervisor.ts.
const STATE_HOST = "state.ocx.internal";
const HUB_NAME = "hub";
const STARTED_ENV_KEY = "ocx:started-env";
const HONORED_RESET_KEY = "ocx:honored-reset";
const STOP_WAIT_MS = 5 * 60_000;
// The supervisor closes its 503 placeholder a moment before ocx binds the port.
const HANDOFF_WINDOW_MS = 30_000;
const PROXY_FAILURE = "Error proxying request to container";
const NOT_LISTENING = /not listening/i;
// The library's answer when a connection drops mid-request: the request may already have run.
const DISCONNECTED = "Container suddenly disconnected";
const REPLAYABLE_METHODS = new Set(["GET", "HEAD"]);

export class OpencodexHub extends Container<Env> {
  defaultPort = 10100;
  // The library fetches `http://${pingEndpoint}`, so this is host + path, not a path.
  pingEndpoint = "localhost/healthz";
  sleepAfter = this.env.OCX_SLEEP_AFTER || "30m";
  entrypoint = ["bun", "docker/cloudflare-supervisor.ts"];
  envVars = containerEnv(this.env);

  private readonly leases = new LeaseState(this.ctx.storage);

  private startedAt = 0;
  private resetInFlight: Promise<void> | undefined;

  override async onStart(): Promise<void> {
    this.startedAt = Date.now();
    await this.ctx.storage.put(STARTED_ENV_KEY, await envFingerprint(this.envVars));
  }

  override async fetch(req: Request): Promise<Response> {
    // Rebuilt per request: bindings can change under a live object, and a stale copy would both
    // hide a rotated secret from the check below and start the replacement with the old value.
    this.envVars = containerEnv(this.env);
    await this.applyPendingReset();
    await this.restartIfEnvChanged();
    // This request may itself start the container, which sets startedAt only once it is up, so
    // the window runs from whichever is later: the last start or this request's arrival.
    // startedAt is 0 in a recreated object even when the persisted state says healthy; the
    // container may be stopped and restarted by this very request, so that counts as a new start.
    const windowStart = (await this.getState()).status !== "healthy" || this.startedAt === 0 ? Date.now() : this.startedAt;
    const inWindow = () => Date.now() - Math.max(windowStart, this.startedAt) <= HANDOFF_WINDOW_MS;
    if (!inWindow()) return super.fetch(req);
    // Only inside the handoff window is the request cloned, so a refused connection can be replayed.
    // A refused connection never reached ocx, so any request replays. A dropped one may have run,
    // so only reads replay. Every other failure returns at once.
    for (let attempt = 0; ; attempt++) {
      const response = await super.fetch(req.clone());
      if (response.status !== 500 || attempt >= 10 || !inWindow()) return response;
      const text = await response.text();
      const refused = text.startsWith(PROXY_FAILURE) && NOT_LISTENING.test(text);
      const droppedRead = text.startsWith(DISCONNECTED) && REPLAYABLE_METHODS.has(req.method);
      if (!refused && !droppedRead) return new Response(text, response);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // The only way out of a saved state that cannot start (a config that binds loopback, a committed
  // pointer whose object was deleted): the admin API is closed and the bootstrap secret applies only
  // when nothing is saved. Honored once per distinct value, so leaving it set cannot wipe every boot.
  private async applyPendingReset(): Promise<void> {
    // stopAndWait() awaits timers, which reopen the input gate. Without this chain a second request
    // could read the old nonce mid-reset and later discard the replacement container's fresh state.
    while (this.resetInFlight) await this.resetInFlight;
    const nonce = this.env.OCX_DISCARD_SAVED_STATE?.trim();
    if (!nonce) return;
    // Assigned before the first await, so the nonce read is inside the serialized section.
    this.resetInFlight = this.discardSavedStateOnce(nonce).finally(() => { this.resetInFlight = undefined; });
    await this.resetInFlight;
  }

  private async discardSavedStateOnce(nonce: string): Promise<void> {
    if ((await this.ctx.storage.get<string>(HONORED_RESET_KEY)) === nonce) return;
    console.log("OCX_DISCARD_SAVED_STATE changed; discarding the saved state.");
    // Stop first: a running container uploads a final snapshot on the way out, which would
    // otherwise re-commit the state being discarded.
    await this.stopAndWait();
    const discarded = await this.leases.discardSnapshot();
    if (discarded) await this.env.STATE.delete(discarded);
    await this.ctx.storage.put(HONORED_RESET_KEY, nonce);
  }

  // A running container keeps the environment it started with, and every request renews its idle
  // timer, so a rotated data token would otherwise stay valid for as long as the leaked one is used.
  private async restartIfEnvChanged(): Promise<void> {
    if ((await this.getState()).status !== "healthy") return;
    const started = await this.ctx.storage.get<string>(STARTED_ENV_KEY);
    if (!started || started === (await envFingerprint(this.envVars))) return;
    console.log("Container secrets changed; restarting the container.");
    await this.stopAndWait();
  }

  private async stopAndWait(): Promise<void> {
    if (!["running", "healthy"].includes((await this.getState()).status)) return;
    const stoppedAt = Date.now();
    await this.stop("SIGTERM");
    // Done once the state moves after our stop: the old process exited, or another request
    // already started its replacement.
    const deadline = stoppedAt + STOP_WAIT_MS;
    while (Date.now() < deadline) {
      const state = await this.getState();
      if (state.lastChange >= stoppedAt || !["running", "healthy"].includes(state.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  acquireLease(bootId: string) { return this.leases.acquireLease(bootId); }
  renewLease(bootId: string) { return this.leases.renewLease(bootId); }
  holdsLease(bootId: string) { return this.leases.holdsLease(bootId); }
  releaseLease(bootId: string) { return this.leases.releaseLease(bootId); }
  currentSnapshot() { return this.leases.currentSnapshot(); }
  commitSnapshot(bootId: string, key: string) { return this.leases.commitSnapshot(bootId, key); }
}

async function handleState(req: Request, env: Env): Promise<Response> {
  return handleStateRequest(req, getContainer(env.HUB, HUB_NAME), {
    get: async key => (await env.STATE.get(key))?.body ?? null,
    put: async (key, body, length) => { await env.STATE.put(key, body.pipeThrough(new FixedLengthStream(length))); },
    delete: key => env.STATE.delete(key),
    list: async (prefix, limit) => {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await env.STATE.list({ prefix, cursor, limit: Math.min(1000, limit - keys.length) });
        keys.push(...page.objects.map(object => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && keys.length < limit);
      return keys;
    },
  });
}

OpencodexHub.outboundByHost = { [STATE_HOST]: handleState };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const decision = edgeDecision(req, env);
    if (!decision.forward) {
      if (decision.status === 204) return new Response(null, { status: 204 });
      return Response.json({ error: { message: decision.message, type: "invalid_request_error" } }, { status: decision.status });
    }
    return getContainer(env.HUB, HUB_NAME).fetch(req);
  },
} satisfies ExportedHandler<Env>;
