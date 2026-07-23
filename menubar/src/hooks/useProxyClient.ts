import { useCallback, useMemo, useRef, useState } from "react";
import type { ComboInfo } from "../components/ComboList";
import type { QuotaReport } from "../components/QuotaBars";

interface UsageData {
  requests: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

interface ProxyState {
  online: boolean;
  version: string | null;
  uptime: number | null;
  usage: UsageData;
  usageStale: boolean;
  combos: ComboInfo[];
  combosStale: boolean;
  quotas: QuotaReport[];
  quotasStale: boolean;
  quotaRefreshing: boolean;
}

const INITIAL_STATE: ProxyState = {
  online: false,
  version: null,
  uptime: null,
  usage: { requests: 0, totalTokens: 0, estimatedCostUsd: 0 },
  usageStale: false,
  combos: [],
  combosStale: false,
  quotas: [],
  quotasStale: false,
  quotaRefreshing: false,
};

const STALE_THRESHOLD_MS = 30_000;

function getBaseUrl(): string {
  return import.meta.env.VITE_PROXY_URL || "http://127.0.0.1:10100";
}

function getApiToken(): string | null {
  return import.meta.env.VITE_API_TOKEN || localStorage.getItem("ocx-menubar-token");
}

async function apiFetch(path: string): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getApiToken();
  if (token) headers["X-OpenCodex-API-Key"] = token;
  return fetch(`${getBaseUrl()}${path}`, { headers });
}

export function useProxyClient() {
  const [state, setState] = useState<ProxyState>(INITIAL_STATE);
  const timersRef = useRef<number[]>([]);
  const lastFetchRef = useRef<Record<string, number>>({});

  const fetchSettings = useCallback(async () => {
    try {
      const res = await apiFetch("/api/settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      lastFetchRef.current.settings = Date.now();
      setState((prev) => ({
        ...prev,
        online: true,
        version: data.version ?? prev.version,
        uptime: data.uptime ?? prev.uptime,
      }));
    } catch {
      setState((prev) => ({ ...prev, online: false }));
    }
  }, []);

  const fetchUsage = useCallback(async () => {
    try {
      const res = await apiFetch("/api/usage?range=today");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      lastFetchRef.current.usage = Date.now();
      setState((prev) => ({
        ...prev,
        usage: {
          requests: data.summary?.requests ?? 0,
          totalTokens: data.summary?.totalTokens ?? 0,
          estimatedCostUsd: data.summary?.estimatedCostUsd ?? 0,
        },
        usageStale: false,
      }));
    } catch {
      setState((prev) => ({ ...prev, usageStale: true }));
    }
  }, []);

  const fetchCombos = useCallback(async () => {
    try {
      const res = await apiFetch("/api/combos");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      lastFetchRef.current.combos = Date.now();
      const combos: ComboInfo[] = (data.combos ?? []).map((c: Record<string, unknown>) => ({
        id: c.id as string,
        model: (c.model as string) ?? "",
      }));
      setState((prev) => ({ ...prev, combos, combosStale: false }));
    } catch {
      setState((prev) => ({ ...prev, combosStale: true }));
    }
  }, []);

  const fetchQuotas = useCallback(async (forceRefresh = false) => {
    if (forceRefresh) {
      setState((prev) => ({ ...prev, quotaRefreshing: true }));
    }
    try {
      const path = forceRefresh ? "/api/provider-quotas?refresh=1" : "/api/provider-quotas";
      const res = await apiFetch(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      lastFetchRef.current.quotas = Date.now();
      const reports: QuotaReport[] = (data.reports ?? []).map((r: Record<string, unknown>) => ({
        provider: r.provider as string,
        label: (r.label as string) ?? (r.provider as string),
        quota: (r.quota as QuotaReport["quota"]) ?? {},
      }));
      setState((prev) => ({ ...prev, quotas: reports, quotasStale: false, quotaRefreshing: false }));
    } catch {
      setState((prev) => ({ ...prev, quotasStale: true, quotaRefreshing: false }));
    }
  }, []);

  const startPolling = useCallback(() => {
    // Immediate fetch
    void fetchSettings();
    void fetchUsage();
    void fetchCombos();
    void fetchQuotas();

    // Intervals
    const t1 = window.setInterval(() => { void fetchSettings(); void fetchUsage(); }, 10_000);
    const t2 = window.setInterval(() => { void fetchCombos(); }, 30_000);
    const t3 = window.setInterval(() => { void fetchQuotas(); }, 60_000);

    // Stale checker
    const t4 = window.setInterval(() => {
      const now = Date.now();
      setState((prev) => ({
        ...prev,
        usageStale: now - (lastFetchRef.current.usage ?? 0) > STALE_THRESHOLD_MS,
        combosStale: now - (lastFetchRef.current.combos ?? 0) > STALE_THRESHOLD_MS,
        quotasStale: now - (lastFetchRef.current.quotas ?? 0) > STALE_THRESHOLD_MS,
      }));
    }, 5_000);

    timersRef.current = [t1, t2, t3, t4];
  }, [fetchSettings, fetchUsage, fetchCombos, fetchQuotas]);

  const stopPolling = useCallback(() => {
    for (const t of timersRef.current) clearInterval(t);
    timersRef.current = [];
  }, []);

  const switchCombo = useCallback((comboId: string) => {
    if (!comboId) return;
    // Combo switching is done by setting the active combo in config
    // For now, we just refetch combos after a brief delay
    void apiFetch("/api/combos").then(() => {
      setTimeout(() => { void fetchCombos(); }, 500);
    });
  }, [fetchCombos]);

  const refreshQuotas = useCallback(() => {
    void fetchQuotas(true);
  }, [fetchQuotas]);

  const openDashboard = useCallback(() => {
    const url = getBaseUrl();
    // In Tauri, use shell.open; in dev, use window.open
    if (typeof window !== "undefined" && "__TAURI__" in window) {
      import("@tauri-apps/plugin-shell").then(({ open }) => {
        void open(url);
      });
    } else {
      window.open(url, "_blank");
    }
  }, []);

  return useMemo(() => ({
    ...state,
    startPolling,
    stopPolling,
    switchCombo,
    refreshQuotas,
    openDashboard,
  }), [state, startPolling, stopPolling, switchCombo, refreshQuotas, openDashboard]);
}
