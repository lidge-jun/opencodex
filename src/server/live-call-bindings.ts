import { randomUUID } from "node:crypto";

export const EXTERNAL_CALL_PREFIX = "rtc_ocx_";
export const LIVE_CALL_TTL_MS = 30 * 60_000;
const MAX_CALL_BINDINGS = 1024;

export interface LiveCallBinding {
  owner: string;
  upstreamCallId: string;
  joinStyle: "frameless-path" | "realtime-query";
  providerName: string;
  accountId?: string;
  chatgptAccountId?: string;
  keyedCredentialDigest?: string;
  callerOwned: boolean;
  sidebandBaseUrl?: string;
}

/** Caller-visible IDs are opaque aliases; expired aliases never become legacy upstream IDs. */
export class LiveCallBindings {
  private entries = new Map<string, { binding: LiveCallBinding; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const now = this.now();
    for (const [id, value] of this.entries) if (value.expiresAt <= now) this.entries.delete(id);
  }

  hasCapacity(): boolean {
    this.prune();
    return this.entries.size < MAX_CALL_BINDINGS;
  }

  create(binding: LiveCallBinding): string | null {
    if (!this.hasCapacity()) return null;
    const id = EXTERNAL_CALL_PREFIX + randomUUID().replaceAll("-", "");
    this.entries.set(id, { binding: { ...binding }, expiresAt: this.now() + LIVE_CALL_TTL_MS });
    return id;
  }

  get(id: string, owner: string): LiveCallBinding | undefined {
    this.prune();
    const value = this.entries.get(id);
    return value?.binding.owner === owner ? { ...value.binding } : undefined;
  }

  clear(): void { this.entries.clear(); }
}

export function upstreamLiveCallId(location: string | null): string | null {
  if (!location || location.length > 4096) return null;
  try {
    const url = new URL(location, "https://unused.invalid");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const segment = url.pathname.replace(/\/+$/, "").split("/").at(-1) ?? "";
    const id = decodeURIComponent(segment);
    return /^(?:rtc_[A-Za-z0-9_-]+|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/.test(id) && id.length <= 128 ? id : null;
  } catch { return null; }
}
