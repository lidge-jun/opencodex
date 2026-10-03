import { UsageActivation, type ApplyScope } from './usage-activation';
import { UsageRefreshRegistry } from './usage-refresh';
import { evaluateUsageRewrite, type UsageRewriteContext } from './usage-policy';

export type UsageIdentity = NonNullable<UsageRewriteContext['account']> & { credentialGeneration?: string };
type Registration = NonNullable<ReturnType<UsageRefreshRegistry['register']>>;
type Exchange = { method: string; pathname: string; status: number };
const same = (a: UsageIdentity | null, b: UsageIdentity) => a !== null
  && a.id === b.id && a.userId === b.userId && a.plan === b.plan && a.structure === b.structure
  && a.credentialGeneration === b.credentialGeneration;
const object = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value);

/** Response-level controller. Construction never starts a listener, timer or trust operation. */
export class UsageRelayController {
  private readonly account: UsageIdentity;
  private readonly key: string;
  private readonly refresh = new UsageRefreshRegistry();
  private readonly activation: UsageActivation;
  private jsonSnapshots = 0;
  private streamSnapshots = 0;
  private lastSnapshotAt: number | null = null;
  constructor(account: UsageIdentity, private readonly readCurrentIdentity: () => Promise<UsageIdentity | null>,
    verifyFreshIdentity: () => Promise<UsageIdentity | null>, private readonly clock: () => number,
    private readonly expiresAt: number, timeoutMs = 180000, private readonly contextValid: () => boolean | Promise<boolean> = () => true) {
    if (!account.id || !account.userId || !['plus', 'pro'].includes(account.plan)
      || account.structure !== 'personal' || !Number.isFinite(expiresAt) || expiresAt <= clock()) {
      throw new Error('A verified supported identity and finite safety deadline are required');
    }
    this.account = { ...account };
    this.key = JSON.stringify([account.id, account.userId, account.plan, account.credentialGeneration ?? null]);
    this.activation = new UsageActivation(this.key, key => this.refresh.refresh(key), async () => {
      return same(await verifyFreshIdentity(), this.account) ? this.key : null;
    }, clock, timeoutMs);
  }
  snapshot() { return { ...this.activation.snapshot(), trackedStreams: this.refresh.size, expired: this.clock() >= this.expiresAt,
    observation: { jsonSnapshots: this.jsonSnapshots, streamSnapshots: this.streamSnapshots,
      validatedActiveStreams: this.refresh.boundSize, lastSnapshotAt: this.lastSnapshotAt,
      sourceProcessVerified: false as const, composerRecoveryVerified: false as const } }; }
  private async checkContext() { try { return await this.contextValid(); } catch { return false; } }
  async activate(options: { scope: ApplyScope; accountWideConsent: boolean }) {
    const generation = this.activation.snapshot().generation, valid = await this.checkContext();
    if (generation !== this.activation.snapshot().generation) return { accepted: false, reason: 'superseded', ...this.snapshot() };
    if (!valid) { this.activation.invalidateIdentity(); return { accepted: false, reason: 'native-context-changed', ...this.snapshot() }; }
    if (this.clock() >= this.expiresAt) { this.activation.invalidateIdentity(); return { accepted: false, reason: 'safety-deadline', ...this.snapshot() }; }
    return this.activation.activate(options);
  }
  observeOnly() { return this.activation.observeOnly(); }
  expireIfNeeded() { return this.activation.expireIfNeeded(); }
  registerStream(exchange: Exchange, close: () => Promise<void>): Registration | null {
    if (exchange.status !== 200) return null;
    return this.refresh.register(exchange.method, exchange.pathname, close);
  }
  /** Only a complete original usage record may establish the stream's account binding. */
  async rewriteJson(text: string, exchange: Exchange, stream?: Registration | null): Promise<string | null> {
    if (exchange.method !== 'GET' || exchange.status !== 200
      || !['/backend-api/wham/usage', '/backend-api/wham/usage/stream'].includes(exchange.pathname)) return null;
    if (this.clock() >= this.expiresAt) { this.activation.invalidateIdentity(); stream?.exclude(); return null; }
    const observedGeneration = this.activation.snapshot().generation;
    let current: UsageIdentity | null;
    try { current = await this.readCurrentIdentity(); } catch { current = null; }
    if (!same(current, this.account)) { this.activation.invalidateIdentity(); stream?.exclude(); return null; }
    // Do not apply an activation that raced this response's identity read.
    if (observedGeneration !== this.activation.snapshot().generation) return null;
    if (this.clock() >= this.expiresAt) { this.activation.invalidateIdentity(); stream?.exclude(); return null; }
    if (Buffer.byteLength(text, 'utf8') > 262144) { stream?.exclude(); return null; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { stream?.exclude(); return null; }
    const envelope = object(parsed) && 'usage' in parsed ? parsed : null;
    if ((exchange.pathname.endsWith('/stream') && !envelope)
      || (envelope && (envelope.version !== 1 || typeof envelope.stream_id !== 'string' || !envelope.stream_id
        || !Number.isSafeInteger(envelope.sequence) || Number(envelope.sequence) <= 0))) { stream?.exclude(); return null; }
    const original = envelope ? envelope.usage : parsed;
    if (!object(original) || original.account_id !== this.account.id || original.user_id !== this.account.userId
      || original.plan_type !== this.account.plan) { stream?.exclude(); return null; }
    const rate = original.rate_limit;
    if (!object(rate) || typeof rate.allowed !== 'boolean' || typeof rate.limit_reached !== 'boolean') {
      stream?.exclude(); return null;
    }
    if (stream && !stream.bind(this.key)) return null;
    // Identity-checked responses received by this relay do not establish the
    // sending process or prove that an authoritative UI cache consumed them.
    if (exchange.pathname.endsWith('/stream')) this.streamSnapshots = Math.min(Number.MAX_SAFE_INTEGER, this.streamSnapshots + 1);
    else this.jsonSnapshots = Math.min(Number.MAX_SAFE_INTEGER, this.jsonSnapshots + 1);
    this.lastSnapshotAt = this.clock();
    const context: UsageRewriteContext = { enabled: true, mode: 'observe', status: exchange.status,
      pathname: exchange.pathname, account: this.account };
    const observed = evaluateUsageRewrite(original, context);
    this.activation.observe(this.key, observed.eligible ? 'exhausted'
      : rate.allowed === true && rate.limit_reached === false ? 'available' : 'protected');
    const state = this.activation.snapshot();
    if (state.mode !== 'apply') return null;
    const result = evaluateUsageRewrite(original, { ...context, mode: 'apply' });
    if (!result.changed) return null;
    // Observe and unchanged responses never spawn an installed-package probe.
    const valid = await this.checkContext();
    if (state.generation !== this.activation.snapshot().generation) return null;
    if (!valid) { this.activation.invalidateIdentity(); stream?.exclude(); return null; }
    // A native account or trial can change while the asynchronous build check runs.
    try { current = await this.readCurrentIdentity(); } catch { current = null; }
    if (state.generation !== this.activation.snapshot().generation) return null;
    if (!same(current, this.account)) { this.activation.invalidateIdentity(); stream?.exclude(); return null; }
    if (this.clock() >= this.expiresAt) { this.activation.invalidateIdentity(); stream?.exclude(); return null; }
    if (!this.activation.recordOutput(this.key, state.generation)) return null;
    return JSON.stringify(envelope ? { ...envelope, usage: result.value } : result.value);
  }
}
