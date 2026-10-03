/** Pure response policy. Real quota windows, credits and spending restrictions stay unchanged. */
export interface UsageRewriteContext {
  enabled: boolean;
  mode: 'observe' | 'apply';
  status: number;
  pathname: string;
  account: {
    id: string;
    userId: string;
    plan: 'plus' | 'pro';
    structure: 'personal';
  } | null;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Transform only a complete, matched personal-account usage snapshot.
 * Account context must come from a trusted live integration; this module does not
 * discover it or prove provider isolation. Never persist the adjusted snapshot as
 * actual provider/account capacity. Unknown or protected states pass unchanged.
 */
export function evaluateUsageRewrite(value: unknown, context: UsageRewriteContext) {
  const unchanged = (reason: string) => ({ value, changed: false, eligible: false, reason });
  if (!context.enabled) return unchanged('off');
  if (context.status !== 200) return unchanged('non-success-response');
  if (!['/backend-api/wham/usage', '/backend-api/wham/usage/stream'].includes(context.pathname)) return unchanged('unowned-path');
  const account = context.account;
  if (!account || !account.id || !account.userId || account.structure !== 'personal' || !['plus', 'pro'].includes(account.plan)) return unchanged('unsupported-account');
  if (!record(value) || value.account_id !== account.id || value.user_id !== account.userId || value.plan_type !== account.plan) return unchanged('identity-mismatch');
  const rate = value.rate_limit;
  if (!record(rate) || rate.allowed !== false || rate.limit_reached !== true) return unchanged('not-explicitly-exhausted');
  const spend = value.spend_control;
  // Absence is unknown, not evidence that no protected spending restriction exists.
  if (!record(spend) || spend.reached !== false) return unchanged('protected-or-unknown-spend');
  const reason = value.rate_limit_reached_type;
  if (reason != null && (!record(reason) || reason.type !== 'rate_limit_reached')) return unchanged('protected-or-unknown-reason');
  const credits = value.credits;
  if (!record(credits) || typeof credits.has_credits !== 'boolean' || typeof credits.unlimited !== 'boolean') return unchanged('unknown-credit-schema');
  if (credits.overage_limit_reached != null && credits.overage_limit_reached !== false) return unchanged('overage-restriction');
  if (context.mode !== 'apply') return { value, changed: false, eligible: true, reason: 'observe-only' };
  return {
    value: { ...value, rate_limit: { ...rate, allowed: true, limit_reached: false } },
    changed: true, eligible: true, reason: 'personal-usage-only',
  };
}
