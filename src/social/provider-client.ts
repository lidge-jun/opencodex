import { PLATFORM_DEFAULTS } from "./constants";
import type {
  PlatformCapabilities,
  ProviderHealth,
  PublicationStatus,
  RemoteAccount,
  RemoteDeliveryState,
  RemoteMedia,
  RemoteWorkspace,
  RenditionStatus,
  SocialPlatform,
  SocialPublishingProvider,
} from "./types";

export class OpenPostApiError extends Error {
  public readonly statusCode?: number;
  public readonly errorCode?: string;
  public readonly retryable: boolean;

  constructor(message: string, options?: { statusCode?: number; errorCode?: string; retryable?: boolean }) {
    super(message);
    this.name = "OpenPostApiError";
    this.statusCode = options?.statusCode;
    this.errorCode = options?.errorCode;
    this.retryable = options?.retryable ?? (options?.statusCode ? options.statusCode >= 500 || options.statusCode === 429 : false);
  }
}

export interface OpenPostClientOptions {
  baseUrl: string;
  apiToken?: string;
  timeoutMs?: number;
}

export class OpenPostHttpClient implements SocialPublishingProvider {
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly timeoutMs: number;

  constructor(options: OpenPostClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      "Accept": "application/json",
      ...(options.headers as Record<string, string> ?? {}),
    };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        let errMessage = `HTTP ${res.status} ${res.statusText}`;
        let errCode = "OPENPOST_HTTP_ERROR";
        try {
          const errBody = await res.json() as Record<string, unknown>;
          if (errBody.message) errMessage = String(errBody.message);
          if (errBody.error) errMessage = String(errBody.error);
          if (errBody.code) errCode = String(errBody.code);
        } catch (_parseErr) {
          // Non-JSON response body; keep the default HTTP status message
        }

        throw new OpenPostApiError(errMessage, {
          statusCode: res.status,
          errorCode: errCode,
          retryable: res.status >= 500 || res.status === 429 || res.status === 408,
        });
      }

      return (await res.json()) as T;
    } catch (err: unknown) {
      if (err instanceof OpenPostApiError) throw err;
      const isTimeout = err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
      throw new OpenPostApiError(isTimeout ? "OpenPost request timed out" : (err instanceof Error ? err.message : String(err)), {
        errorCode: isTimeout ? "OPENPOST_TIMEOUT" : "OPENPOST_NETWORK_ERROR",
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  public async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const res = await this.request<{ status?: string; version?: string }>("/api/health");
      return {
        status: res.status === "ok" || res.status === "healthy" ? "healthy" : "degraded",
        version: res.version ?? null,
        latency_ms: Date.now() - start,
      };
    } catch (err) {
      return {
        status: "unavailable",
        version: null,
        latency_ms: Date.now() - start,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async getServerInfo(): Promise<{ version: string; status: string }> {
    return this.request<{ version: string; status: string }>("/api/info");
  }

  public async listWorkspaces(): Promise<RemoteWorkspace[]> {
    const res = await this.request<{ workspaces: RemoteWorkspace[] }>("/api/workspaces");
    return res.workspaces ?? [];
  }

  public async listAccounts(workspaceRef: string): Promise<RemoteAccount[]> {
    const res = await this.request<{ accounts: RemoteAccount[] }>(`/api/workspaces/${encodeURIComponent(workspaceRef)}/accounts`);
    return res.accounts ?? [];
  }

  public async getAccountCapabilities(accountRef: string): Promise<PlatformCapabilities> {
    const res = await this.request<{ capabilities: PlatformCapabilities }>(`/api/accounts/${encodeURIComponent(accountRef)}/capabilities`);
    return res.capabilities;
  }

  public async uploadMedia(input: {
    content: Buffer | Uint8Array;
    mime_type: string;
    filename: string;
    sha256: string;
  }): Promise<RemoteMedia> {
    const formData = new FormData();
    const blob = new Blob([input.content as any], { type: input.mime_type });
    formData.append("file", blob, input.filename);
    formData.append("sha256", input.sha256);

    return this.request<RemoteMedia>("/api/media", {
      method: "POST",
      body: formData,
    });
  }

  public async getMedia(mediaRef: string): Promise<RemoteMedia> {
    return this.request<RemoteMedia>(`/api/media/${encodeURIComponent(mediaRef)}`);
  }

  public async createPublication(input: {
    title?: string;
    caption?: string;
    renditions: Array<{
      account_ref: string;
      platform: SocialPlatform;
      caption?: string;
      media_refs?: string[];
      provider_settings?: Record<string, unknown>;
    }>;
  }): Promise<{ publication_ref: string; rendition_refs: Record<string, string> }> {
    return this.request<{ publication_ref: string; rendition_refs: Record<string, string> }>("/api/publications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  public async schedule(input: {
    publication_ref: string;
    scheduled_at: string;
    timezone: string;
  }): Promise<RemoteDeliveryState> {
    return this.request<RemoteDeliveryState>(`/api/publications/${encodeURIComponent(input.publication_ref)}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  public async publishNow(input: {
    publication_ref: string;
  }): Promise<RemoteDeliveryState> {
    return this.request<RemoteDeliveryState>(`/api/publications/${encodeURIComponent(input.publication_ref)}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  public async cancel(input: {
    publication_ref: string;
  }): Promise<RemoteDeliveryState> {
    return this.request<RemoteDeliveryState>(`/api/publications/${encodeURIComponent(input.publication_ref)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  public async getPublicationState(publicationRef: string): Promise<{
    publication_ref: string;
    status: PublicationStatus;
    rendition_states: Record<string, RenditionStatus>;
  }> {
    return this.request<{
      publication_ref: string;
      status: PublicationStatus;
      rendition_states: Record<string, RenditionStatus>;
    }>(`/api/publications/${encodeURIComponent(publicationRef)}/status`);
  }

  public async getAnalytics(input: {
    account_ref: string;
    publication_ref?: string;
  }): Promise<{
    views: number | null;
    impressions: number | null;
    reach: number | null;
    engagements: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    raw: Record<string, unknown>;
  }> {
    let q = `account_ref=${encodeURIComponent(input.account_ref)}`;
    if (input.publication_ref) q += `&publication_ref=${encodeURIComponent(input.publication_ref)}`;
    return this.request<{
      views: number | null;
      impressions: number | null;
      reach: number | null;
      engagements: number | null;
      likes: number | null;
      comments: number | null;
      shares: number | null;
      raw: Record<string, unknown>;
    }>(`/api/analytics?${q}`);
  }
}

/**
 * Deterministic fake provider for unit tests and local mock execution.
 */
export class FakeSocialPublishingProvider implements SocialPublishingProvider {
  public healthStatus: "healthy" | "degraded" | "unavailable" = "healthy";
  public simulateFailure: Error | null = null;
  public transientFailuresLeft = 0;
  public uploadedMedia = new Map<string, RemoteMedia>();
  public publications = new Map<string, {
    status: PublicationStatus;
    rendition_states: Record<string, RenditionStatus>;
    scheduled_at?: string;
  }>();
  public accounts: RemoteAccount[] = [
    {
      id: "acc_x_demo",
      platform: "x",
      display_name: "Demo X Brand",
      username: "demo_brand",
      readiness_state: "READY",
      capabilities: PLATFORM_DEFAULTS.x,
    },
    {
      id: "acc_mastodon_demo",
      platform: "mastodon",
      display_name: "Demo Mastodon",
      username: "demo_masto",
      readiness_state: "READY",
      capabilities: PLATFORM_DEFAULTS.mastodon,
    },
    {
      id: "acc_linkedin_demo",
      platform: "linkedin",
      display_name: "Demo Corp LinkedIn",
      username: "demo-corp",
      readiness_state: "READY",
      capabilities: PLATFORM_DEFAULTS.linkedin,
    },
    {
      id: "acc_tiktok_demo",
      platform: "tiktok",
      display_name: "Demo TikTok Video",
      username: "demotiktok",
      readiness_state: "READY",
      capabilities: PLATFORM_DEFAULTS.tiktok,
    },
    {
      id: "acc_instagram_degraded",
      platform: "instagram",
      display_name: "Demo IG (Requires Reauth)",
      username: "demo_ig",
      readiness_state: "REQUIRES_REAUTH",
      capabilities: PLATFORM_DEFAULTS.instagram,
    },
  ];

  private checkFailure(): void {
    if (this.transientFailuresLeft > 0) {
      this.transientFailuresLeft--;
      throw new OpenPostApiError("Simulated transient 500 Service Unavailable", { statusCode: 500, retryable: true });
    }
    if (this.simulateFailure) {
      throw this.simulateFailure;
    }
  }

  public async healthCheck(): Promise<ProviderHealth> {
    this.checkFailure();
    return {
      status: this.healthStatus,
      version: "4.12.0",
      latency_ms: 12,
    };
  }

  public async getServerInfo(): Promise<{ version: string; status: string }> {
    this.checkFailure();
    return { version: "4.12.0", status: "ok" };
  }

  public async listWorkspaces(): Promise<RemoteWorkspace[]> {
    this.checkFailure();
    return [{ id: "ws_default", name: "Default Workspace" }];
  }

  public async listAccounts(_workspaceRef: string): Promise<RemoteAccount[]> {
    this.checkFailure();
    return [...this.accounts];
  }

  public async getAccountCapabilities(accountRef: string): Promise<PlatformCapabilities> {
    this.checkFailure();
    const acc = this.accounts.find(a => a.id === accountRef);
    if (!acc) throw new OpenPostApiError(`Account not found: ${accountRef}`, { statusCode: 404 });
    return acc.capabilities;
  }

  public async uploadMedia(input: {
    content: Buffer | Uint8Array;
    mime_type: string;
    filename: string;
    sha256: string;
  }): Promise<RemoteMedia> {
    this.checkFailure();
    const existing = this.uploadedMedia.get(input.sha256);
    if (existing) return existing;

    const media: RemoteMedia = {
      id: `media_${input.sha256.slice(0, 12)}`,
      url: `https://openpost.local/media/media_${input.sha256.slice(0, 12)}`,
      mime_type: input.mime_type,
      byte_size: input.content.length,
      sha256: input.sha256,
    };
    this.uploadedMedia.set(input.sha256, media);
    return media;
  }

  public async getMedia(mediaRef: string): Promise<RemoteMedia> {
    this.checkFailure();
    for (const m of this.uploadedMedia.values()) {
      if (m.id === mediaRef) return m;
    }
    throw new OpenPostApiError(`Media not found: ${mediaRef}`, { statusCode: 404 });
  }

  public async createPublication(input: {
    title?: string;
    caption?: string;
    renditions: Array<{
      account_ref: string;
      platform: SocialPlatform;
      caption?: string;
      media_refs?: string[];
      provider_settings?: Record<string, unknown>;
    }>;
  }): Promise<{ publication_ref: string; rendition_refs: Record<string, string> }> {
    this.checkFailure();
    const pubId = `pub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const renditionRefs: Record<string, string> = {};
    const renditionStates: Record<string, RenditionStatus> = {};

    for (const r of input.renditions) {
      const rendRef = `rend_${pubId}_${r.platform}`;
      renditionRefs[r.account_ref] = rendRef;
      renditionStates[rendRef] = "draft";
    }

    this.publications.set(pubId, {
      status: "draft",
      rendition_states: renditionStates,
    });

    return { publication_ref: pubId, rendition_refs: renditionRefs };
  }

  public async schedule(input: {
    publication_ref: string;
    scheduled_at: string;
    timezone: string;
  }): Promise<RemoteDeliveryState> {
    this.checkFailure();
    const pub = this.publications.get(input.publication_ref);
    if (!pub) throw new OpenPostApiError(`Publication not found: ${input.publication_ref}`, { statusCode: 404 });

    pub.status = "scheduled";
    pub.scheduled_at = input.scheduled_at;
    for (const k of Object.keys(pub.rendition_states)) {
      pub.rendition_states[k] = "scheduled";
    }

    return {
      remote_publication_ref: input.publication_ref,
      status: "scheduled",
      scheduled_at: input.scheduled_at,
    };
  }

  public async publishNow(input: {
    publication_ref: string;
  }): Promise<RemoteDeliveryState> {
    this.checkFailure();
    const pub = this.publications.get(input.publication_ref);
    if (!pub) throw new OpenPostApiError(`Publication not found: ${input.publication_ref}`, { statusCode: 404 });

    pub.status = "published";
    for (const k of Object.keys(pub.rendition_states)) {
      pub.rendition_states[k] = "published";
    }

    return {
      remote_publication_ref: input.publication_ref,
      status: "published",
      published_at: new Date().toISOString(),
    };
  }

  public async cancel(input: {
    publication_ref: string;
  }): Promise<RemoteDeliveryState> {
    this.checkFailure();
    const pub = this.publications.get(input.publication_ref);
    if (!pub) throw new OpenPostApiError(`Publication not found: ${input.publication_ref}`, { statusCode: 404 });

    pub.status = "cancelled";
    for (const k of Object.keys(pub.rendition_states)) {
      pub.rendition_states[k] = "cancelled";
    }

    return {
      remote_publication_ref: input.publication_ref,
      status: "cancelled",
    };
  }

  public async getPublicationState(publicationRef: string): Promise<{
    publication_ref: string;
    status: PublicationStatus;
    rendition_states: Record<string, RenditionStatus>;
  }> {
    this.checkFailure();
    const pub = this.publications.get(publicationRef);
    if (!pub) throw new OpenPostApiError(`Publication not found: ${publicationRef}`, { statusCode: 404 });
    return {
      publication_ref: publicationRef,
      status: pub.status,
      rendition_states: { ...pub.rendition_states },
    };
  }

  public async getAnalytics(input: {
    account_ref: string;
    publication_ref?: string;
  }): Promise<{
    views: number | null;
    impressions: number | null;
    reach: number | null;
    engagements: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    raw: Record<string, unknown>;
  }> {
    this.checkFailure();
    return {
      views: 1250,
      impressions: 1800,
      reach: 1400,
      engagements: 230,
      likes: 95,
      comments: 18,
      shares: 12,
      raw: { source: "fake_openpost", timestamp: new Date().toISOString() },
    };
  }
}

