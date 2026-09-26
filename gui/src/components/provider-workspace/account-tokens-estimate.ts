/**
 * account-tokens-estimate.ts - Empirical and baseline token capacity calculation
 * for OAuth account pools (Google Antigravity, Anthropic, OpenAI, etc.).
 *
 * Calculates remaining 5-hour and weekly token limits in Millions (M) and Billions (B),
 * calibrated against actual request token usage from /api/logs (#logs).
 */
import { useEffect, useMemo, useState } from "react";
import type { AnalyzedAccountQuota } from "./account-quota-analysis";

export interface FormattedTokenAmount {
  raw: number;
  /** Millions formatted with spaces, e.g. "~240M" or "0M" */
  m: string;
  /** Billions formatted with tilde, e.g. "~0.24B" */
  b: string;
  /** Combined representation, e.g. "~240M (~0.24B)" */
  display: string;
  smart: string;
}

export interface PoolTokensEstimate {
  isAntigravity: boolean;
  showModelFamilies: boolean;

  // When showModelFamilies is true (Claude + Gemini breakdown):
  claude5h?: FormattedTokenAmount;
  claudeWeekly?: FormattedTokenAmount;
  gemini5h?: FormattedTokenAmount;
  geminiWeekly?: FormattedTokenAmount;

  // Total across pool:
  total5h: FormattedTokenAmount;
  totalWeekly: FormattedTokenAmount;

  // Calibrated capacities per account window (for diagnostics / tooltips):
  gemini5hCapacity: number;
  geminiWeeklyCapacity: number;
  claude5hCapacity: number;
  claudeWeeklyCapacity: number;
  generic5hCapacity: number;
  genericWeeklyCapacity: number;

  isCalibratedFromLogs: boolean;
}

export interface LogEntryAttempt {
  provider?: string;
  model?: string;
  accountLogLabel?: string;
  totalTokens?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface MinimalLogEntry {
  timestamp: number;
  provider?: string;
  model?: string;
  resolvedModel?: string;
  accountLogLabel?: string;
  totalTokens?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  attempts?: LogEntryAttempt[];
}

/** Pure TypeScript SHA-256 implementation for synchronous account log label hashing. */
export function sha256Hex(str: string): string {
  function rotr(n: number, x: number) {
    return (x >>> n) | (x << (32 - n));
  }
  function ch(x: number, y: number, z: number) {
    return (x & y) ^ (~x & z);
  }
  function maj(x: number, y: number, z: number) {
    return (x & y) ^ (x & z) ^ (y & z);
  }
  function sigma0(x: number) {
    return rotr(2, x) ^ rotr(13, x) ^ rotr(22, x);
  }
  function sigma1(x: number) {
    return rotr(6, x) ^ rotr(11, x) ^ rotr(25, x);
  }
  function gamma0(x: number) {
    return rotr(7, x) ^ rotr(18, x) ^ (x >>> 3);
  }
  function gamma1(x: number) {
    return rotr(17, x) ^ rotr(19, x) ^ (x >>> 10);
  }

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let H0 = 0x6a09e667;
  let H1 = 0xbb67ae85;
  let H2 = 0x3c6ef372;
  let H3 = 0xa54ff53a;
  let H4 = 0x510e527f;
  let H5 = 0x9b05688c;
  let H6 = 0x1f83d9ab;
  let H7 = 0x5be0cd19;

  const utf8 = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      utf8.push(c);
    } else if (c < 0x800) {
      utf8.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      utf8.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      utf8.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }

  const bitLen = utf8.length * 8;
  utf8.push(0x80);
  while ((utf8.length % 64) !== 56) {
    utf8.push(0);
  }
  for (let i = 3; i >= 0; i--) utf8.push(0);
  for (let i = 3; i >= 0; i--) utf8.push((bitLen >>> (i * 8)) & 0xff);

  const W = new Int32Array(64);
  for (let chunk = 0; chunk < utf8.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      const idx = chunk + i * 4;
      W[i] = (utf8[idx] << 24) | (utf8[idx + 1] << 16) | (utf8[idx + 2] << 8) | utf8[idx + 3];
    }
    for (let i = 16; i < 64; i++) {
      W[i] = (gamma1(W[i - 2]) + W[i - 7] + gamma0(W[i - 15]) + W[i - 16]) | 0;
    }

    let a = H0;
    let b = H1;
    let c = H2;
    let d = H3;
    let e = H4;
    let f = H5;
    let g = H6;
    let h = H7;

    for (let i = 0; i < 64; i++) {
      const T1 = (h + sigma1(e) + ch(e, f, g) + K[i] + W[i]) | 0;
      const T2 = (sigma0(a) + maj(a, b, c)) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + T1) | 0;
      d = c;
      c = b;
      b = a;
      a = (T1 + T2) | 0;
    }

    H0 = (H0 + a) | 0;
    H1 = (H1 + b) | 0;
    H2 = (H2 + c) | 0;
    H3 = (H3 + d) | 0;
    H4 = (H4 + e) | 0;
    H5 = (H5 + f) | 0;
    H6 = (H6 + g) | 0;
    H7 = (H7 + h) | 0;
  }

  const hexParts = [H0, H1, H2, H3, H4, H5, H6, H7].map(h => (h >>> 0).toString(16).padStart(8, "0"));
  return hexParts.join("");
}

// Mirrors baseProviderLabel (src/providers/label.ts): the server stamps log labels
// under the normalized provider, so the GUI must hash the same value or lookups miss.
function baseProviderLabelForLog(provider: string): string {
  const canonical = provider === "chatgpt" || provider === "openai-multi" ? "openai" : provider;
  if (canonical !== provider) return canonical;
  const cut = provider.lastIndexOf("-");
  if (cut <= 0) return provider;
  const suffix = provider.slice(cut + 1);
  if (suffix === "main" || /^[pa][a-f0-9]{6}$/.test(suffix)) return provider.slice(0, cut);
  return provider;
}

export function computeOAuthAccountLogLabel(accountId: string, provider = ""): string {
  return "o" + sha256Hex(baseProviderLabelForLog(provider) + "\u0000" + accountId).slice(0, 6);
}

/** Format raw token number to Millions (M) and Billions (~B). */
export function formatTokenAmount(tokens: number): FormattedTokenAmount {
  const safeTokens = Math.max(0, Math.round(tokens));
  if (safeTokens === 0) {
    return {
      raw: 0,
      smart: "0M",
      m: "0M",
      b: "~0.00B",
      display: "0M",
    };
  }
  const inM = Math.round(safeTokens / 1_000_000);
  const inB = (safeTokens / 1_000_000_000).toFixed(2);
  const formattedM = inM.toLocaleString("en-US").replace(/,/g, " ");
  const m = "~" + formattedM + "M";
  const b = "~" + inB + "B";

  const smart = safeTokens >= 1_000_000_000 ? b : safeTokens >= 1_000_000 ? m : "<1M";

  return {
    raw: safeTokens,
    smart,
    m,
    b,
    display: smart,
  };
}

export const DEFAULT_CAPACITIES = {
  antigravity: {
    gemini5h: 100_000_000,
    geminiWeekly: 1_200_000_000,
    claude5h: 30_000_000,
    claudeWeekly: 240_000_000,
  },
  anthropic: {
    fiveHour: 40_000_000,
    weekly: 300_000_000,
  },
  openai: {
    fiveHour: 30_000_000,
    weekly: 200_000_000,
  },
  generic: {
    fiveHour: 50_000_000,
    weekly: 500_000_000,
  },
} as const;

function extractLogTokens(
  log: MinimalLogEntry,
  now: number,
  windowMs: number,
): Array<{ label: string; family: "gemini" | "claude" | "generic"; tokens: number }> {
  if (log.timestamp < now - windowMs) return [];
  const results = [];

  const rawItems = (log.attempts && log.attempts.length > 0)
    ? log.attempts
    : [log];

  for (const item of rawItems) {
    const label = item.accountLogLabel || log.accountLogLabel;
    if (!label) continue;
    const tokens = item.totalTokens
      || ((item.usage?.inputTokens ?? 0) + (item.usage?.outputTokens ?? 0))
      || 0;
    if (tokens <= 0) continue;

    const m = (item.model || log.resolvedModel || log.model || "").toLowerCase();
    let family: "gemini" | "claude" | "generic" = "generic";
    if (m.includes("gemini")) {
      family = "gemini";
    } else if (m.includes("claude") || m.includes("sonnet") || m.includes("opus")) {
      family = "claude";
    }
    results.push({ label, family: family, tokens });
  }

  return results;
}

/**
 * Pure calculation function that determines token capacity from logs
 * and computes remaining tokens for all accounts in the pool.
 */
export function calculatePoolTokensEstimate(
  analyzedList: AnalyzedAccountQuota[],
  providerName = "google-antigravity",
  logs: MinimalLogEntry[] = [],
  now = Date.now(),
  showModelFamilies = false,
): PoolTokensEstimate {
  const isAntigravity = providerName === "google-antigravity" || showModelFamilies;

  // 1. Group 5h (18,000,000 ms) and 7d (604,800,000 ms) tokens by accountLogLabel + family
  const tokens5hByLabelAndFamily = new Map();
  const tokens7dByLabelAndFamily = new Map();

  for (const log of logs) {
    for (const item of extractLogTokens(log, now, 5 * 3600 * 1000)) {
      const key = item.label + ":" + item.family;
      tokens5hByLabelAndFamily.set(key, (tokens5hByLabelAndFamily.get(key) ?? 0) + item.tokens);
    }
    for (const item of extractLogTokens(log, now, 7 * 24 * 3600 * 1000)) {
      const key = item.label + ":" + item.family;
      tokens7dByLabelAndFamily.set(key, (tokens7dByLabelAndFamily.get(key) ?? 0) + item.tokens);
    }
  }

  // 2. Calibrate 5h window capacity from accounts that have used some percent
  let gemUsedTokens5h = 0;
  let gemUsedPercent5h = 0;
  let claUsedTokens5h = 0;
  let claUsedPercent5h = 0;
  let genericUsedTokens5h = 0;
  let genericUsedPercent5h = 0;

  for (const analyzed of analyzedList) {
    const label = analyzed.account.logLabel || computeOAuthAccountLogLabel(analyzed.account.id, providerName);
    if (!label) continue;

    if (analyzed.gemini5h && analyzed.gemini5h.percent > 0 && analyzed.gemini5h.percent < 99.5) {
      const tok = tokens5hByLabelAndFamily.get(label + ":gemini") ?? 0;
      if (tok > 0) {
        gemUsedTokens5h += tok;
        gemUsedPercent5h += analyzed.gemini5h.percent;
      }
    }

    if (analyzed.claude5h && analyzed.claude5h.percent > 0 && analyzed.claude5h.percent < 99.5) {
      const tok = tokens5hByLabelAndFamily.get(label + ":claude") ?? 0;
      if (tok > 0) {
        claUsedTokens5h += tok;
        claUsedPercent5h += analyzed.claude5h.percent;
      }
    }

    if (analyzed.generic5h && analyzed.generic5h.percent > 0 && analyzed.generic5h.percent < 99.5) {
      const tok = tokens5hByLabelAndFamily.get(label + ":generic") ?? 0;
      if (tok > 0) {
        genericUsedTokens5h += tok;
        genericUsedPercent5h += analyzed.generic5h.percent;
      }
    }
  }

  let isCalibratedFromLogs = false;

  // Calibrate Gemini 5h capacity
  let gemini5hCapacity: number = DEFAULT_CAPACITIES.antigravity.gemini5h;
  if (gemUsedPercent5h > 0 && gemUsedTokens5h > 0) {
    const empirical = Math.round((gemUsedTokens5h / gemUsedPercent5h) * 100);
    if (empirical >= 10_000_000 && empirical <= 500_000_000) {
      gemini5hCapacity = empirical;
      isCalibratedFromLogs = true;
    }
  }

  // Calibrate Claude 5h capacity
  let claude5hCapacity: number = DEFAULT_CAPACITIES.antigravity.claude5h;
  if (claUsedPercent5h > 0 && claUsedTokens5h > 0) {
    const empirical = Math.round((claUsedTokens5h / claUsedPercent5h) * 100);
    if (empirical >= 5_000_000 && empirical <= 200_000_000) {
      claude5hCapacity = empirical;
      isCalibratedFromLogs = true;
    }
  }

  // Calibrate Generic 5h capacity
  const defaultGeneric = providerName === "anthropic"
    ? DEFAULT_CAPACITIES.anthropic.fiveHour
    : providerName === "openai"
      ? DEFAULT_CAPACITIES.openai.fiveHour
      : DEFAULT_CAPACITIES.generic.fiveHour;
  let generic5hCapacity: number = defaultGeneric;
  if (genericUsedPercent5h > 0 && genericUsedTokens5h > 0) {
    const empirical = Math.round((genericUsedTokens5h / genericUsedPercent5h) * 100);
    if (empirical >= 5_000_000 && empirical <= 300_000_000) {
      generic5hCapacity = empirical;
      isCalibratedFromLogs = true;
    }
  }

  // Weekly capacities scale with standard provider ratios
  const geminiWeeklyCapacity = Math.round(gemini5hCapacity * 12);
  const claudeWeeklyCapacity = Math.round(claude5hCapacity * 8);
  const defaultGenericWeekly = providerName === "anthropic"
    ? DEFAULT_CAPACITIES.anthropic.weekly
    : providerName === "openai"
      ? DEFAULT_CAPACITIES.openai.weekly
      : DEFAULT_CAPACITIES.generic.weekly;
  const genericWeeklyCapacity = Math.round(
    generic5hCapacity === defaultGeneric ? defaultGenericWeekly : generic5hCapacity * 8
  );

  // 3. Compute remaining tokens across all valid accounts in the pool
  let claude5hRem = 0;
  let claudeWeeklyRem = 0;
  let gemini5hRem = 0;
  let geminiWeeklyRem = 0;
  let generic5hRem = 0;
  let genericWeeklyRem = 0;

  for (const analyzed of analyzedList) {
    const acc = analyzed.account;
    if (acc.health?.status === "reauth_required") continue;
    if (acc.quotaUnavailable || !acc.quota) continue;

    if (showModelFamilies || isAntigravity) {
      // Gemini 5h
      if (analyzed.gemini5h && !analyzed.geminiExhausted && analyzed.gemini5h.percent < 99.5) {
        const free = Math.max(0, 100 - analyzed.gemini5h.percent);
        gemini5hRem += gemini5hCapacity * (free / 100);
      }
      // Gemini Weekly
      if (analyzed.geminiWeekly && analyzed.geminiWeekly.percent < 99.5) {
        const free = Math.max(0, 100 - analyzed.geminiWeekly.percent);
        geminiWeeklyRem += geminiWeeklyCapacity * (free / 100);
      } else if (analyzed.gemini5h && !analyzed.geminiExhausted) {
        const impliedUsed = Math.min(99, analyzed.gemini5h.percent * 0.35);
        geminiWeeklyRem += geminiWeeklyCapacity * (Math.max(0, 100 - impliedUsed) / 100);
      }

      // Claude 5h
      if (analyzed.claude5h && !analyzed.claudeExhausted && analyzed.claude5h.percent < 99.5) {
        const free = Math.max(0, 100 - analyzed.claude5h.percent);
        claude5hRem += claude5hCapacity * (free / 100);
      }
      // Claude Weekly
      if (analyzed.claudeWeekly && analyzed.claudeWeekly.percent < 99.5) {
        const free = Math.max(0, 100 - analyzed.claudeWeekly.percent);
        claudeWeeklyRem += claudeWeeklyCapacity * (free / 100);
      } else if (analyzed.claude5h && !analyzed.claudeExhausted) {
        const impliedUsed = Math.min(99, analyzed.claude5h.percent * 0.35);
        claudeWeeklyRem += claudeWeeklyCapacity * (Math.max(0, 100 - impliedUsed) / 100);
      }
    } else {
      // Generic OAuth provider (Anthropic, OpenAI, etc.)
      if (analyzed.generic5h && analyzed.generic5h.percent < 99.5) {
        const free = Math.max(0, 100 - analyzed.generic5h.percent);
        generic5hRem += generic5hCapacity * (free / 100);
      }
      if (analyzed.genericWeekly && analyzed.genericWeekly.percent < 99.5) {
        const free = Math.max(0, 100 - analyzed.genericWeekly.percent);
        genericWeeklyRem += genericWeeklyCapacity * (free / 100);
      } else if (analyzed.generic5h && analyzed.generic5h.percent < 99.5) {
        const impliedUsed = Math.min(99, analyzed.generic5h.percent * 0.35);
        genericWeeklyRem += genericWeeklyCapacity * (Math.max(0, 100 - impliedUsed) / 100);
      }
    }
  }

  const total5hRaw = (showModelFamilies || isAntigravity) ? (claude5hRem + gemini5hRem) : generic5hRem;
  const totalWeeklyRaw = (showModelFamilies || isAntigravity) ? (claudeWeeklyRem + geminiWeeklyRem) : genericWeeklyRem;

  return {
    isAntigravity,
    showModelFamilies,
    claude5h: formatTokenAmount(claude5hRem),
    claudeWeekly: formatTokenAmount(claudeWeeklyRem),
    gemini5h: formatTokenAmount(gemini5hRem),
    geminiWeekly: formatTokenAmount(geminiWeeklyRem),
    total5h: formatTokenAmount(total5hRaw),
    totalWeekly: formatTokenAmount(totalWeeklyRaw),
    gemini5hCapacity,
    geminiWeeklyCapacity,
    claude5hCapacity,
    claudeWeeklyCapacity,
    generic5hCapacity,
    genericWeeklyCapacity,
    isCalibratedFromLogs,
  };
}

/** React hook for managing live logs fetching and tokens estimate calculations. */
export function usePoolTokensEstimate({
  apiBase = "",
  providerName = "google-antigravity",
  analyzedList,
  showModelFamilies = false,
  refreshingAll = false,
}: {
  apiBase?: string;
  providerName?: string;
  analyzedList: AnalyzedAccountQuota[];
  showModelFamilies?: boolean;
  refreshingAll?: boolean;
}): PoolTokensEstimate {
  const [logs, setLogs] = useState<MinimalLogEntry[]>([]);
  const [lastFetchedAt, setLastFetchedAt] = useState<number>(() => 0);

  useEffect(() => {
    let unmounted = false;
    const controller = new AbortController();
    const loadLogs = async () => {
      // A hidden tab needs no fresh estimate; the next visible load refreshes.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const url = apiBase + "/api/logs?limit=1000";
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json() as { logs?: MinimalLogEntry[] };
        if (!unmounted && Array.isArray(data.logs)) {
          setLogs(data.logs);
          setLastFetchedAt(Date.now());
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Soft fallback to baseline
      }
    };

    // Load on mount and when a quota refresh completes. While a refresh is in
    // flight its completion re-runs this effect, so starting needs no load.
    if (!refreshingAll) void loadLogs();
    const timer = window.setInterval(() => {
      void loadLogs();
    }, 45_000);

    return () => {
      unmounted = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [apiBase, refreshingAll]);

  return useMemo(() => {
    return calculatePoolTokensEstimate(
      analyzedList,
      providerName,
      logs,
      lastFetchedAt || 0,
      showModelFamilies,
    );
  }, [analyzedList, providerName, logs, lastFetchedAt, showModelFamilies]);
}
