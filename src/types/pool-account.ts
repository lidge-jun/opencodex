/**
 * Per-account egress for a pool account (`codexAccounts[].egress`).
 *
 * The values follow the same rules as `providers.<name>.proxy` and `noProxy`: `proxy` absent inherits the
 * provider's route, `"direct"` or `null` connects directly, an http(s) or socks5(h) URL selects a proxy for
 * this account; `noProxy` entries send matching destinations directly and are merged ahead of the
 * provider's own list. Resolved per request by `src/lib/provider-egress.ts`.
 */
export interface PoolAccountEgress {
  proxy?: string | null;
  noProxy?: string | string[];
}
