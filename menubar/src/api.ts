import { invoke } from "@tauri-apps/api/core";

export interface ProxyConfig {
  url: string;
  token: string | null;
}

let proxyConfig: ProxyConfig | null = null;

export async function initProxyConfig(): Promise<ProxyConfig> {
  if (proxyConfig) return proxyConfig;
  const discovery = await invoke<{ url: string; token: string | null; found: boolean }>("discover_proxy");
  proxyConfig = { url: discovery.url, token: discovery.token };
  return proxyConfig;
}

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

export async function apiRequest<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<ApiResponse<T>> {
  // Ensure config is loaded
  await initProxyConfig();
  return invoke<ApiResponse<T>>("api_request", {
    req: { path, method, body: body ?? null },
  });
}

// --- Data types matching the opencodex management API ---

export interface UsageSummary {
  summary: {
    requests: number;
    totalTokens: number;
    coverageRatio: number;
    estimatedCostUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface ProviderInfo {
  name: string;
  adapter: string;
  baseUrl?: string;
  defaultModel?: string;
  hasApiKey: boolean;
  disabled?: boolean;
  authMode?: string;
}

export interface HealthData {
  status: string;
  version: string;
  uptime: number;
}

export interface RequestLogEntry {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  status: number;
  durationMs?: number;
  firstOutputMs?: number;
  totalTokens?: number;
}

// --- API calls ---

export async function fetchUsage(range = "7d"): Promise<UsageSummary | null> {
  try {
    const res = await apiRequest<UsageSummary>(`/api/usage?range=${range}`);
    return res.ok ? res.body : null;
  } catch {
    return null;
  }
}

export async function fetchProviders(): Promise<ProviderInfo[] | null> {
  try {
    const res = await apiRequest<ProviderInfo[]>("/api/providers");
    return res.ok ? res.body : null;
  } catch {
    return null;
  }
}

export async function fetchHealth(): Promise<HealthData | null> {
  try {
    const res = await apiRequest<HealthData>("/healthz");
    return res.ok ? res.body : null;
  } catch {
    return null;
  }
}

export async function fetchRequestLog(limit = 20): Promise<RequestLogEntry[] | null> {
  try {
    const res = await apiRequest<RequestLogEntry[]>(`/api/logs?tail=${limit}`);
    if (!res.ok) return null;
    // The logs endpoint may return { entries: [...] } or an array
    const body = res.body as unknown;
    if (Array.isArray(body)) return body as RequestLogEntry[];
    if (body && typeof body === "object" && "entries" in body) {
      return (body as { entries: RequestLogEntry[] }).entries;
    }
    return null;
  } catch {
    return null;
  }
}

export async function stopProxy(): Promise<boolean> {
  try {
    const res = await apiRequest("/api/stop", "POST");
    return res.ok;
  } catch {
    return false;
  }
}

export async function toggleProvider(name: string, disabled: boolean): Promise<boolean> {
  try {
    const encoded = encodeURIComponent(name);
    const res = await apiRequest(`/api/providers?name=${encoded}`, "PATCH", { disabled });
    return res.ok;
  } catch {
    return false;
  }
}
