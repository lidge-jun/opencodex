import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OcxParsedRequest } from "../../types";
import type { ProviderAdapter } from "../base";
import { MuseMspError } from "./connection";
import { museContinuationOwner } from "./owner";
import { MuseMspRunner } from "./runner";
import { createMuseMspAdapter } from "./adapter";
import { MuseCorrelatedBudget } from "./correlated-budget";
import { createMuseCredentialSnapshot } from "./credential-snapshot";
import { openMuseLoopbackModelGateway } from "./loopback-model-gateway";
import { MuseModelInputCheckpoint } from "./user-turn-send";

type State = { runner: MuseMspRunner; adapter: ProviderAdapter; close: () => Promise<void>; timer: ReturnType<typeof setTimeout>;
  latestInput?: MuseModelInputCheckpoint; answer?: string; request?: OcxParsedRequest; closing?: Promise<void> };

/**
 * Unregistered, loopback-only composition for isolated integration tests.
 * Each authenticated conversation owns a separate child, gateway and budget.
 * This does not prove network confinement or support live account credentials.
 */
export class MuseIsolatedRuntime {
  private readonly states = new Map<string, State>();
  private closed = false;
  constructor(private readonly config: { hostExecutable: string; hostArgs: string[]; hostEnv: NodeJS.ProcessEnv; cwd: string;
    captureExecutable: string; captureArgs: string[]; upstream: string; dummyCredential: string; fakeModelOverride?: string;
    maxOwners?: number; ttlMs?: number; useRequestTransport?: true; observeError?: (code: string) => void }) {
    if (!/^dummy-[A-Za-z0-9-]{1,128}$/.test(config.dummyCredential) || !Number.isSafeInteger(config.maxOwners ?? 16) ||
        (config.maxOwners ?? 16) < 1 || (config.maxOwners ?? 16) > 16 || !Number.isSafeInteger(config.ttlMs ?? 300_000) ||
        (config.ttlMs ?? 300_000) < 1 || (config.ttlMs ?? 300_000) > 300_000) throw new MuseMspError("invalid_isolated_runtime");
  }

  readonly adapter: ProviderAdapter = {
    name: "muse-msp-isolated", reportsPhysicalSends: true,
    buildRequest() { throw new MuseMspError("unsupported_transport"); },
    async *parseStream() { throw new MuseMspError("unsupported_transport"); },
    runTurn: async (parsed, incoming, emit) => {
      const owner = museContinuationOwner(parsed);
      if (!owner || this.closed) { emit({ type: "error", message: "Muse session is unavailable.", code: "muse_session_failed", retryable: false }); return; }
      let state = this.states.get(owner), created = false;
      if (!state) {
        if (parsed.context.messages.at(-1)?.role !== "user" || parsed.context.messages.some(message => message.role === "assistant" || message.role === "toolResult") ||
            this.states.size >= (this.config.maxOwners ?? 16)) {
          emit({ type: "error", message: "Muse session is unavailable.", code: "muse_session_failed", retryable: false }); return;
        }
        try { state = this.createState(owner); created = true; }
        catch { emit({ type: "error", message: "Muse session is unavailable.", code: "muse_session_failed", retryable: false }); return; }
      }
      let failed = false;
      await state.adapter.runTurn!(parsed, incoming, event => { if (event.type === "error") failed = true; emit(event); });
      if (created && failed) await this.release(owner, state);
    },
    onResponseRendered: (parsed, response) => {
      const owner = museContinuationOwner(parsed), state = owner && this.states.get(owner);
      if (!state || state.request !== parsed || state.closing) return;
      state.request = undefined;
      state.adapter.onResponseRendered?.(parsed, response);
      if (response.status !== "completed" || !Array.isArray(response.output) || response.output.length !== 1) return;
      const item = response.output[0] as any;
      if (item?.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content) || !item.content.length ||
          item.content.some((part: any) => part?.type !== "output_text" || typeof part.text !== "string")) return;
      const answer = item.content.map((part: any) => part.text).join("");
      if (answer) state.answer = answer;
    },
  };

  private createState(owner: string): State {
    const budget = new MuseCorrelatedBudget(), bytes = Buffer.from(this.config.dummyCredential), credential = createMuseCredentialSnapshot(bytes);
    bytes.fill(0);
    let state: State | undefined;
    let gateway: ReturnType<typeof openMuseLoopbackModelGateway> | undefined;
    try {
      gateway = openMuseLoopbackModelGateway({ upstream: this.config.upstream, budget, credential,
        ...(this.config.useRequestTransport ? { useRequestTransport: true as const } : {}),
        prepareInput: body => {
          if (!state || state.closing) throw new MuseMspError("unavailable_conversation");
          const checkpoint = new MuseModelInputCheckpoint(body), ownerState = state;
          return () => { ownerState.latestInput = checkpoint; };
        } });
      const runner = new MuseMspRunner({ hostExecutable: this.config.hostExecutable, hostArgs: this.config.hostArgs,
        hostEnv: { ...this.config.hostEnv, TBH_CREDENTIAL_BACKEND: "file" }, cwd: this.config.cwd,
        captureExecutable: this.config.captureExecutable, captureArgs: this.config.captureArgs, projectDeveloperPrompt: true,
        retainPlainTextTurns: true, streamText: true, settingsProvision: { endpointTransport: { base_url: gateway.baseUrl, auth: "bearer" },
          disableReminders: true, writeCredentials: async dir => { await writeFile(join(dir, "auth.json"), JSON.stringify({ schema_version: 1,
            providers: { meta: { api_key: this.config.dummyCredential } } }), { flag: "wx", mode: 0o600 }); } } });
      const adapter = createMuseMspAdapter({ run: (parsed, options) => {
        if (!state || state.closing) throw new MuseMspError("unavailable_conversation");
        if (this.config.fakeModelOverride) {
          const rawModel = parsed._rawBody && typeof parsed._rawBody === "object" && "model" in parsed._rawBody ? parsed._rawBody.model : undefined;
          parsed._responseModelId = typeof rawModel === "string" ? rawModel : parsed.modelId;
          parsed.modelId = this.config.fakeModelOverride;
        }
        return runner.run(parsed, options).then(events => {
          // Rejected or still-parked requests must not displace the response
          // owner awaiting its render callback.
          if (state && !state.closing && !events.some(event => event.type === "tool_call_start")) state.request = parsed;
          return events;
        }).catch(error => {
          try { this.config.observeError?.(error instanceof MuseMspError ? error.code : "host_error"); } catch { /* observation is optional */ }
          throw error;
        });
      }, onResponseRendered: (parsed, response) => runner.onResponseRendered(parsed, response) }, 60_000, {
        run: async (incoming, execute, context) => {
          if (context.userContinuation) {
            if (!state?.latestInput || !state.answer) throw new MuseMspError("unavailable_conversation");
            return budget.runUserTurn(incoming, `isolated:${owner}`, state.latestInput, state.answer, hooks => execute({ beforeUserDispatch: hooks.beforeUserDispatch }));
          }
          return budget.run(incoming, `isolated:${owner}`, context.continuation, hooks => execute({ beforeResultCommit: hooks.beforeResultCommit }));
        },
      });
      const close = async () => { gateway!.close(); budget.close(); credential.close(); await runner.close(); };
      const timer = setTimeout(() => { if (state) void this.release(owner, state).catch(() => {}); }, this.config.ttlMs ?? 300_000);
      timer.unref?.();
      state = { runner, adapter, close, timer };
      this.states.set(owner, state);
      return state;
    } catch (error) { gateway?.close(); budget.close(); credential.close(); throw error; }
  }

  async close(): Promise<void> { this.closed = true; await Promise.all([...this.states].map(([owner, state]) => this.release(owner, state))); }

  private async release(owner: string, state: State): Promise<void> {
    if (this.states.get(owner) !== state) return;
    if (!state.closing) {
      clearTimeout(state.timer);
      state.closing = state.close().finally(() => { if (this.states.get(owner) === state) this.states.delete(owner); });
    }
    await state.closing;
  }
}
