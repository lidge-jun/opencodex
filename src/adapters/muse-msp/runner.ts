import type { AdapterEvent, OcxParsedRequest } from "../../types";
import { MuseMspError } from "./connection";
import { museContinuationOwner } from "./owner";
import { buildMuseCaptureCatalog, museClientToolInstructions } from "./catalog";
import { MuseCaptureRendezvous } from "./capture-rendezvous";
import { MusePendingRegistry } from "./pending-registry";
import { openMuseCaptureChannel } from "./capture-channel";
import { MuseMspHost } from "./host";
import { MuseMspSession } from "./session";
import { MuseResponsesHandoff } from "./responses-handoff";
import { MuseTurnSegments } from "./segment";
import { MuseTurnRegistry } from "./turn-registry";
import { createMuseIsolatedSettings } from "./isolated-settings";
import type { MuseToolResult } from "./tool-result";
import { MuseConversationRegistry } from "./conversation-registry";
import { parseRequest } from "../../responses/parser";
import { museConversationDigest } from "./history";
import { observeMuseMspSubscriptionQuota } from "./subscription-usage";
import type { ProviderQuota } from "../../providers/quota-types";
import { museDeveloperContinuation } from "./developer-continuation";
import { museProjectedText, projectInitialMuseHistory } from "./initial-history";
import { MuseConversationHistoryChanged } from "./conversation-checkpoint";
export { museProjectedText } from "./initial-history";

type RetainedMuseSession = { session: MuseMspSession; host: MuseMspHost; handoff: MuseResponsesHandoff;
  rendezvous: MuseCaptureRendezvous; catalog: ReturnType<typeof buildMuseCaptureCatalog>; close: () => Promise<void> };
type PendingRender = { state: RetainedMuseSession; existing: boolean; request: OcxParsedRequest; requestDigest: string; timer: ReturnType<typeof setTimeout> };

function withCodexExecHint(text: string, catalog: ReturnType<typeof buildMuseCaptureCatalog>): string {
  const exec = [...catalog.approvalTools].find(([, value]) => typeof value !== "string" && value.name === "exec" && !value.namespace && value.freeform);
  return exec ? `${text}\n\nCodex client tools are available through ${exec[0]}, even when Muse's own shell and write tools are disabled. For requested commands, file operations, MCP calls, or other client actions, use that tool with JavaScript input; Codex applies its own permissions. For example, use await tools.exec_command({cmd: "..."}) for commands, and inspect ALL_TOOLS to discover available MCP tools before calling them via tools. Use an available search tool for requested searches. When asked to repeat previous tests or actions, perform them again rather than assuming their previous results are current. Do not claim a client tool is unavailable without attempting the requested action; report any actual tool error.` : text;
}

/** Concatenate text parts only when the caller explicitly opted into projection. */

/** Experimental orchestration. The caller owns the trusted executable and isolated env. */
export class MuseMspRunner {
  private readonly turns = new MuseTurnRegistry();
  private readonly conversations = new MuseConversationRegistry();
  private readonly retained = new Map<string, RetainedMuseSession>();
  private readonly activeHosts = new Map<string, MuseMspHost>();
  private readonly pendingRender = new Map<string, PendingRender>();
  private readonly starting = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private closed = false;
  constructor(private readonly config: {
    hostExecutable: string; hostArgs: string[]; hostEnv: NodeJS.ProcessEnv; cwd: string;
    captureExecutable: string; captureArgs: string[];
    /** Opt into lossy merging of adjacent developer/user messages and Muse's own instructions. */
    projectDeveloperPrompt?: true;
    /** Trusted caller provisions only the new isolated directory; no credentials are implicitly copied. */
    settingsProvision?: { writeCredentials: (configDir: string) => Promise<void>; disableReminders?: true };
    /** Experimental host credential-lane check; does not establish subscription billing. */
    requireAccountLogin?: true;
    /** Host-scoped observation: owner is a conversation key, not an account identifier. */
    observeSubscriptionQuota?: (quota: ProviderQuota, scope: { owner: string; invalidated: AbortSignal }) => void;
    /** Experimental incremental text; completed content remains authoritative. */
    streamText?: true;
    /** Experimental: preserve simple text turns after their client-visible response is rendered. */
    retainPlainTextTurns?: true;
    /** Bound all owned hosts, including turns awaiting response rendering. */
    maxOwnedHosts?: number;
  }) {
    if (config.maxOwnedHosts !== undefined && (!Number.isSafeInteger(config.maxOwnedHosts) || config.maxOwnedHosts < 1 || config.maxOwnedHosts > 16)) throw new MuseMspError("invalid_host_limit");
  }

  async run(parsed: OcxParsedRequest, options: { timeoutMs: number; signal?: AbortSignal; beforeDispatch?: () => void; beforeResultCommit?: (result: Readonly<MuseToolResult>) => void; beforeUserDispatch?: (text: string) => void; onText?: (text: string) => void }): Promise<AdapterEvent[]> {
    if (!this.config.streamText) options = { ...options, onText: undefined };
    const owner = museContinuationOwner(parsed);
    if (!owner || this.closed) throw new MuseMspError("unavailable_continuation");
    if (this.pendingRender.has(owner)) throw new MuseMspError("unavailable_conversation");
    // parallelToolCalls grants permission for multiple calls; the capture bridge
    // exposes approvals one at a time and validates each result before proceeding.
    const acceptedOptions = new Set(["toolChoice", "reasoning", "parallelToolCalls", "promptCacheKey", "hideThinkingSummary", "hideRawReasoning", "tierObservation", "tierDecision"]);
    if (Object.entries(parsed.options).some(([key, value]) => value !== undefined && !acceptedOptions.has(key)) ||
        (parsed.options.tierDecision !== undefined && parsed.options.tierDecision.kind !== "drop") ||
        (parsed.options.reasoning !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(parsed.options.reasoning))) {
      throw new MuseMspError("unsupported_request_options");
    }
    const messages = parsed.context.messages;
    const developerContinuation=museDeveloperContinuation(parsed,this.config.projectDeveloperPrompt===true);
    if (messages.at(-1)?.role === "toolResult" || developerContinuation) {
      if (this.config.requireAccountLogin) {
        const activeHost = this.activeHosts.get(owner);
        if (!activeHost) throw new MuseMspError("unavailable_turn");
        try { await activeHost.checkAccountLogin(options); }
        catch (error) { await this.turns.discard(parsed); throw error; }
      }
      return this.turns.continue(parsed, {...options,...(developerContinuation ?? {})});
    }
    if (this.config.retainPlainTextTurns && this.retained.has(owner) && messages.at(-1)?.role === "user") {
      const state = this.retained.get(owner)!;
      let turnId:string | undefined;
      try { turnId = await this.conversations.resume(parsed, { timeoutMs: options.timeoutMs, signal: options.signal, beforeDispatch: options.beforeUserDispatch }); }
      catch (error) {
        if (!(error instanceof MuseConversationHistoryChanged)) throw error;
        await this.conversations.discard(parsed);
      }
      if (turnId) {
      try {
        const segments = new MuseTurnSegments({ session: state.session, turnId, capture: state.session.captureForTurn(turnId, state.catalog.approvalTools),
          inbox: state.host.inbox, connection: state.host.connection, handoff: state.handoff, rendezvous: state.rendezvous });
        return await this.turns.start(parsed, { segments: this.withUsageObservation(segments, state.host), handoff: state.handoff, close: state.close,
          isValid: () => !state.host.invalidated.aborted, invalidated: state.host.invalidated, onFinal: final => this.parkRendered(final, state, true),
          onToolCommit: continuation => this.conversations.advanceToolResult(continuation), steer:(text,opts)=>state.session.steer(text,opts) }, options);
      } catch (error) { await this.conversations.discard(parsed); throw error; }
      }
    }
    const projected=projectInitialMuseHistory(parsed.context,this.config.projectDeveloperPrompt===true);
    const catalog = buildMuseCaptureCatalog(parsed);
    const execTool=[...catalog.approvalTools].find(([,value])=>typeof value!=="string" && value.name==="exec" && !value.namespace && value.freeform);
    const toolInstructions=execTool ? museClientToolInstructions(catalog.approvalTools) : undefined;
    const developer=[projected.developer,toolInstructions].filter(Boolean).join("\n\n") || undefined;
    const user=withCodexExecHint(projected.user,catalog);
    this.turns.assertAvailable(parsed);
    const owned = new Set([...this.starting.keys(), ...this.turns.owners(), ...this.pendingRender.keys(), ...this.retained.keys()]);
    if (this.starting.has(owner) || owned.size >= (this.config.maxOwnedHosts ?? 16)) throw new MuseMspError("unavailable_turn");
    const abort = new AbortController();
    let finishStart!: () => void;
    const done = new Promise<void>(resolve => { finishStart = resolve; });
    this.starting.set(owner, { abort, done });
    const effectiveOptions = { ...options, signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal };
    const registry = new MusePendingRegistry(), rendezvous = new MuseCaptureRendezvous();
    let channel: Awaited<ReturnType<typeof openMuseCaptureChannel>> | undefined;
    let host: MuseMspHost | undefined;
    let settings: Awaited<ReturnType<typeof createMuseIsolatedSettings>> | undefined;
    let cleanup: Promise<void> | undefined;
    const close = () => cleanup ??= (async () => {
      if (this.retained.get(owner)?.close === close) this.retained.delete(owner);
      if (this.activeHosts.get(owner) === host) this.activeHosts.delete(owner);
      rendezvous.close(); registry.close();
      if (channel) await channel.close();
      if (host) await host.close();
      if (settings) await settings.close();
    })();
    try {
      channel = await openMuseCaptureChannel(rendezvous, catalog.tools);
      if (developer || this.config.settingsProvision) settings = await createMuseIsolatedSettings(developer, this.config.hostEnv, this.config.settingsProvision);
      host = await MuseMspHost.start({ executable: this.config.hostExecutable, args: this.config.hostArgs,
        cwd: this.config.cwd, env: settings?.env ?? this.config.hostEnv }, { timeoutMs: options.timeoutMs, signal: effectiveOptions.signal,
          requireAccountLogin: this.config.requireAccountLogin });
      this.activeHosts.set(owner, host);
      const session = await MuseMspSession.open(host.connection, { workspaceRoot: this.config.cwd, modelId: parsed.modelId,
        captureServer: { command: this.config.captureExecutable, args: this.config.captureArgs,
          env: { OCX_MUSE_CAPTURE_PORT: String(channel.port), OCX_MUSE_CAPTURE_TOKEN: channel.token } } }, effectiveOptions);
      await host.checkAccountLogin(effectiveOptions);
      if (effectiveOptions.signal.aborted) throw new MuseMspError("cancelled");
      options.beforeDispatch?.();
      options.beforeUserDispatch?.(user);
      const turnId = await session.startTurn(user, parsed.options.reasoning, effectiveOptions, projected.images);
      const handoff = new MuseResponsesHandoff(registry);
      const segments = new MuseTurnSegments({ session, turnId, capture: session.captureForTurn(turnId, catalog.approvalTools),
        inbox: host.inbox, connection: host.connection, handoff, rendezvous });
      if (this.closed) throw new MuseMspError("unavailable_turn");
      const state: RetainedMuseSession = { session, host, handoff, rendezvous, catalog, close };
      return await this.turns.start(parsed, { segments: this.withUsageObservation(segments, host), handoff, close, isValid: () => !host!.invalidated.aborted, invalidated: host.invalidated, steer:(text,opts)=>session.steer(text,opts),
        ...(this.config.retainPlainTextTurns ? { onFinal: (final: OcxParsedRequest) => this.parkRendered(final, state, false) } : {}) }, effectiveOptions);
    } catch (error) { await close(); throw error; }
    finally { this.starting.delete(owner); finishStart(); }
  }

  private withUsageObservation(segments: MuseTurnSegments, host: MuseMspHost): Pick<MuseTurnSegments, "next"> {
    const observe = this.config.observeSubscriptionQuota;
    if (!observe) return segments;
    return { async next(parsed, options) {
      const events = await segments.next(parsed, options);
      const owner = museContinuationOwner(parsed);
      if (!owner) return events;
      const signal = AbortSignal.any([host.invalidated, ...[options.requestSignal, options.sessionSignal].filter((value): value is AbortSignal => !!value)]);
      await observeMuseMspSubscriptionQuota(host.connection, quota => observe(quota, { owner, invalidated: host.invalidated }),
        { timeoutMs: Math.min(options.timeoutMs, 1000), signal });
      return events;
    } };
  }

  private parkRendered(parsed: OcxParsedRequest, state: RetainedMuseSession, existing: boolean): void {
    const owner = museContinuationOwner(parsed);
    if (!owner || this.closed || this.pendingRender.has(owner) || state.host.invalidated.aborted) throw new MuseMspError("unavailable_conversation");
    const requestDigest = museConversationDigest(parsed.context, parsed.options);
    const timer = setTimeout(() => {
      const pending = this.pendingRender.get(owner);
      if (!pending || pending.state !== state) return;
      this.pendingRender.delete(owner);
      void (existing ? this.conversations.discard(parsed) : state.close()).catch(() => {});
    }, 60_000);
    timer.unref?.();
    this.pendingRender.set(owner, { state, existing, request: parsed, requestDigest, timer });
  }

  /** Called only with the normalized response emitted by the trusted Responses bridge. */
  onResponseRendered(parsed: OcxParsedRequest, response: Record<string, unknown>): void {
    const owner = museContinuationOwner(parsed), pending = owner && this.pendingRender.get(owner);
    if (!owner || !pending || pending.request !== parsed) return;
    try { if (museConversationDigest(parsed.context, parsed.options) !== pending.requestDigest) return; } catch { return; }
    clearTimeout(pending.timer); this.pendingRender.delete(owner);
    const fail = () => { void (pending.existing ? this.conversations.discard(parsed) : pending.state.close()).catch(() => {}); };
    try {
      if (this.closed || response.status !== "completed" || !Array.isArray(response.output) || response.output.length !== 1) throw new MuseMspError("invalid_conversation_checkpoint");
      const item = response.output[0];
      if (!item || typeof item !== "object" || item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content) ||
          !item.content.length || item.content.some((part: any) => part?.type !== "output_text" || typeof part.text !== "string")) throw new MuseMspError("invalid_conversation_checkpoint");
      const reply = parseRequest({ model: parsed._responseModelId ?? parsed.modelId, input: [item] });
      if (reply.context.messages.length !== 1 || reply.context.messages[0]?.role !== "assistant") throw new MuseMspError("invalid_conversation_checkpoint");
      const completed: OcxParsedRequest = { ...parsed, context: { ...parsed.context, messages: [...parsed.context.messages, ...reply.context.messages] } };
      if (pending.existing) void this.conversations.finish(completed).catch(fail);
      else {
        const state = pending.state;
        this.conversations.retain(completed, { isValid: () => !state.host.invalidated.aborted, invalidated: state.host.invalidated, close: state.close,
          startTurn: async (text, options) => { await state.host.checkAccountLogin(options); return state.session.startTurn(withCodexExecHint(text,state.catalog), parsed.options.reasoning, { ...options, allowQueued: true }); } });
        this.retained.set(owner, state);
      }
    } catch { fail(); }
  }

  async close(): Promise<void> {
    this.closed = true;
    const starts = [...this.starting.values()];
    for (const start of starts) start.abort.abort();
    const pending = [...this.pendingRender.values()];
    this.pendingRender.clear();
    for (const entry of pending) clearTimeout(entry.timer);
    await Promise.all([this.turns.close(), this.conversations.close(), ...pending.map(entry => entry.state.close()), ...starts.map(start => start.done)]);
  }
}
