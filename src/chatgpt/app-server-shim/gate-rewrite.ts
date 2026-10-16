/** Plain-quota gate rewriting; usage display and non-quota restrictions are preserved. */
const PLAIN_QUOTA_REACHED_TYPE = "rate_limit_reached";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNonQuotaBlock(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasNonQuotaBlock);
  if (!isRecord(node)) return false;
  if (node.spendControlReached !== undefined && node.spendControlReached !== null && node.spendControlReached !== false) return true;
  if (isRecord(node.spend_control) && node.spend_control.reached === true) return true;
  const reached = node.rate_limit_reached_type;
  if (isRecord(reached) && typeof reached.type === "string" && reached.type !== PLAIN_QUOTA_REACHED_TYPE) return true;
  const rpcReached = node.rateLimitReachedType;
  const rpcType = typeof rpcReached === "string" ? rpcReached : isRecord(rpcReached) ? rpcReached.type : undefined;
  if (typeof rpcType === "string" && rpcType !== PLAIN_QUOTA_REACHED_TYPE) return true;
  return Object.values(node).some(hasNonQuotaBlock);
}

export function unlockRateLimitGate(value: unknown): boolean {
  let changed = false;
  const payloadBlocked = hasNonQuotaBlock(value);
  // A subtree shows the plain quota as the reason when a plain-quota reached type was removed in
  // it or a usage window reads 100%; it stays "blocked" when a non-quota reason (workspace or
  // credit reached type, spend control) is still standing in it.
  const visit = (node: unknown): { cleared: boolean; exhausted: boolean; blocked: boolean } => {
    let cleared = false;
    let exhausted = false;
    let blocked = false;
    if (Array.isArray(node)) {
      for (const item of node) {
        const r = visit(item);
        cleared ||= r.cleared;
        exhausted ||= r.exhausted;
        blocked ||= r.blocked;
      }
      return { cleared, exhausted, blocked };
    }
    if (!isRecord(node)) return { cleared, exhausted, blocked };
    // A usage window at 100%, in either spelling the gate fields come in: `usedPercent` in the
    // app-server's JSON-RPC, `used_percent` in the web usage snapshot.
    if (typeof node.usedPercent === "number" && node.usedPercent >= 100) exhausted = true;
    if (typeof node.used_percent === "number" && node.used_percent >= 100) exhausted = true;
    if (node.spendControlReached !== undefined && node.spendControlReached !== null && node.spendControlReached !== false) blocked = true;
    if (isRecord(node.spend_control) && node.spend_control.reached === true) blocked = true;
    const reachedType = node.rate_limit_reached_type;
    if (isRecord(reachedType) && reachedType.type === PLAIN_QUOTA_REACHED_TYPE) {
      delete node.rate_limit_reached_type;
      changed = true;
      cleared = true;
    } else if (isRecord(reachedType) && typeof reachedType.type === "string") {
      blocked = true;
    }
    // The app-server's JSON-RPC spelling of the same field: a nullable string.
    const rpcReached = node.rateLimitReachedType;
    const rpcType = typeof rpcReached === "string" ? rpcReached : isRecord(rpcReached) ? rpcReached.type : undefined;
    if (rpcType === PLAIN_QUOTA_REACHED_TYPE) {
      node.rateLimitReachedType = null;
      changed = true;
      cleared = true;
    } else if (typeof rpcType === "string") {
      blocked = true;
    }
    for (const child of Object.values(node)) {
      const r = visit(child);
      cleared ||= r.cleared;
      exhausted ||= r.exhausted;
      blocked ||= r.blocked;
    }
    // The rate-limit flags are opened only when the plain quota is the visible reason in this
    // subtree and no workspace, credit or spend-control reason stands anywhere in the payload.
    // A flag closed for a reason the payload does not show stays as the server sent it.
    const plainQuotaShown = (cleared || exhausted) && !blocked && !payloadBlocked;
    if (plainQuotaShown) {
      for (const key of ["rate_limit", "rateLimit"] as const) {
        const rateLimit = node[key];
        if (!isRecord(rateLimit)) continue;
        if (rateLimit.allowed === false) {
          rateLimit.allowed = true;
          changed = true;
        }
        for (const limitKey of ["limit_reached", "limitReached"] as const) {
          if (rateLimit[limitKey] === true) {
            rateLimit[limitKey] = false;
            changed = true;
          }
        }
      }
    }
    // `ordinaryUsageAllowed: false` is the same quota gate seen from the RPC side, and the only
    // field the app reads for it. Open it only when the plain quota is the visible reason and
    // nothing else still explains the block.
    if (node.ordinaryUsageAllowed === false && plainQuotaShown) {
      node.ordinaryUsageAllowed = true;
      changed = true;
    }
    return { cleared, exhausted, blocked };
  };
  visit(value);
  return changed;
}
