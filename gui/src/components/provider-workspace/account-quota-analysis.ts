
export function roundPercent(val: number): number {
  return Math.round(val);
}

export function isWindowExhausted(percent?: number): boolean {
  if (percent === undefined) return false;
  return Math.round(percent) >= 100 || percent >= 99.5;
}

/**
 * account-quota-analysis.ts — Pure quota window extraction, readiness calculation,
 * email login formatting, and sorting for OAuth provider accounts (WP-Antigravity-UX).
 */
import type { OAuthAccountRow } from "./types";
import { displayAccountId } from "../../lib/privacy";

export interface QuotaWindowInfo {
  label: string;
  percent: number;
  resetAt?: number;
}

export type AccountReadinessStatus =
  | "both_ready"       // Gemini and Claude are both available (< 100%)
  | "claude_only"      // Gemini is exhausted (100%), Claude is available
  | "gemini_only"      // Claude is exhausted (100%), Gemini is available
  | "fully_exhausted"  // Both models (or all available windows) are exhausted (>= 100%)
  | "ready"            // Generic non-Antigravity ready
  | "exhausted";       // Generic non-Antigravity exhausted

export interface AnalyzedAccountQuota {
  account: OAuthAccountRow;
  emailLogin: string;
  maskedLogin: string;
  isAntigravity: boolean;

  // Extracted specific model windows
  gemini5h?: QuotaWindowInfo;
  geminiWeekly?: QuotaWindowInfo;
  claude5h?: QuotaWindowInfo;
  claudeWeekly?: QuotaWindowInfo;

  // Generic windows if not antigravity
  generic5h?: QuotaWindowInfo;
  genericWeekly?: QuotaWindowInfo;

  // Calculations
  geminiUsedMax: number;
  claudeUsedMax: number;
  overallUsedMax: number;
  freeHeadroom: number; // 0..100%

  geminiExhausted: boolean;
  claudeExhausted: boolean;
  fullyExhausted: boolean;
  hasAnyLimitsLeft: boolean;

  readinessStatus: AccountReadinessStatus;
}

/**
 * Extract clean login name from email without domain (e.g. "user@example.com" -> "g***1").
 */

export function maskLocalEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.indexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!domain) return value;
  if (local.length === 1) return `*@${domain}`;
  if (local.length === 2) return `${local[0]}*@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

export function extractMaskedLogin(
  maskedEmail?: string,
  email?: string,
  rawEmail?: string,
  alias?: string,
  id?: string,
): string {
  const candidate = (maskedEmail && maskedEmail.trim()) || (email && email.includes("*") ? email.trim() : null);
  if (candidate) {
    const atIndex = candidate.indexOf("@");
    if (atIndex > 0) return candidate.slice(0, atIndex);
    return candidate;
  }
  const source = (rawEmail && rawEmail.trim() && !rawEmail.includes("*") ? rawEmail.trim() : null)
    || (email && email.trim() && !email.includes("*") ? email.trim() : null)
    || (rawEmail && rawEmail.trim())
    || (email && email.trim());
  if (source) {
    const masked = maskLocalEmail(source);
    if (masked) {
      const atIndex = masked.indexOf("@");
      if (atIndex > 0) return masked.slice(0, atIndex);
      return masked;
    }
  }
  if (alias && alias.trim()) return alias.trim();
  if (id) return displayAccountId(id);
  return "";
}

export function extractEmailLogin(
  email?: string,
  alias?: string,
  id?: string,
): string {
  // Display follows the management-API projection: never prefer a side-channel
  // rawEmail over the masked `email` the privacy SSOT already chose.
  const source = email && email.trim() ? email.trim() : null;
  if (source) {
    const atIndex = source.indexOf("@");
    if (atIndex > 0) return source.slice(0, atIndex);
    return source;
  }
  if (alias && alias.trim()) return alias.trim();
  if (id) return displayAccountId(id);
  return "";
}

/**
 * Check whether a window label represents a 5-hour window.
 */
function is5hWindow(label: string): boolean {
  const l = label.toLowerCase();
  return l === "gem" || l === "cla" || l === "5h" || l.includes("5h") || l.includes("5-hour") || l.includes("five");
}

/**
 * Check whether a window label represents a weekly window.
 */
function isWeeklyWindow(label: string): boolean {
  const l = label.toLowerCase();
  return l.includes("week");
}

export function analyzeAccountQuota(account: OAuthAccountRow, providerName = "google-antigravity"): AnalyzedAccountQuota {
  const emailLogin = extractEmailLogin(account.email, account.alias, account.id);
  const maskedLogin = extractMaskedLogin(account.maskedEmail, account.email, account.rawEmail, account.alias, account.id);
  const quota = account.quota;

  let gemini5h: QuotaWindowInfo | undefined;
  let geminiWeekly: QuotaWindowInfo | undefined;
  let claude5h: QuotaWindowInfo | undefined;
  let claudeWeekly: QuotaWindowInfo | undefined;

  let generic5h: QuotaWindowInfo | undefined;
  let genericWeekly: QuotaWindowInfo | undefined;

  const customWindows = quota?.customWindows ?? [];

  for (const w of customWindows) {
    if (typeof w.percent !== "number") continue;
    const l = w.label.trim();
    const lLower = l.toLowerCase();
    const isGem = lLower === "gem" || lLower.startsWith("gem ") || lLower.startsWith("gemini");
    const isCla = lLower === "cla" || lLower.startsWith("cla ") || lLower.startsWith("claude");

    if (isGem) {
      if (isWeeklyWindow(l)) {
        if (!geminiWeekly) geminiWeekly = { label: l, percent: w.percent, resetAt: w.resetAt };
      } else if (is5hWindow(l) || !gemini5h) {
        gemini5h = { label: l, percent: w.percent, resetAt: w.resetAt };
      }
    } else if (isCla) {
      if (isWeeklyWindow(l)) {
        if (!claudeWeekly) claudeWeekly = { label: l, percent: w.percent, resetAt: w.resetAt };
      } else if (is5hWindow(l) || !claude5h) {
        claude5h = { label: l, percent: w.percent, resetAt: w.resetAt };
      }
    }
  }

  // Standard fiveHour/weekly fallbacks
  if (typeof quota?.fiveHourPercent === "number") {
    generic5h = { label: "5-Hour", percent: quota.fiveHourPercent, resetAt: quota.fiveHourResetAt };
  }
  if (typeof quota?.weeklyPercent === "number") {
    genericWeekly = { label: "7-Day", percent: quota.weeklyPercent, resetAt: quota.weeklyResetAt };
  }

  const isAntigravity = providerName === "google-antigravity" || Boolean(gemini5h || geminiWeekly || claude5h || claudeWeekly);

  // Compute model max utilization
  const gemVals: number[] = [];
  if (gemini5h) gemVals.push(gemini5h.percent);
  if (geminiWeekly) gemVals.push(geminiWeekly.percent);
  const geminiUsedMax = gemVals.length > 0 ? roundPercent(Math.max(...gemVals)) : 0;

  const claVals: number[] = [];
  if (claude5h) claVals.push(claude5h.percent);
  if (claudeWeekly) claVals.push(claudeWeekly.percent);
  const claudeUsedMax = claVals.length > 0 ? roundPercent(Math.max(...claVals)) : 0;

  const allPercents: number[] = [];
  if (gemVals.length > 0) allPercents.push(...gemVals);
  if (claVals.length > 0) allPercents.push(...claVals);
  if (generic5h) allPercents.push(generic5h.percent);
  if (genericWeekly) allPercents.push(genericWeekly.percent);
  for (const w of customWindows) {
    if (typeof w.percent === "number") allPercents.push(w.percent);
  }

  const overallUsedMax = allPercents.length > 0 ? roundPercent(Math.max(...allPercents)) : 0;
  const freeHeadroom = roundPercent(Math.max(0, 100 - overallUsedMax));

  // Model-specific exhaustion
  const hasGemini = gemVals.length > 0;
  const hasClaude = claVals.length > 0;
  const geminiExhausted = hasGemini && gemVals.some(p => isWindowExhausted(p));
  const claudeExhausted = hasClaude && claVals.some(p => isWindowExhausted(p));

  let fullyExhausted: boolean;
  let readinessStatus: AccountReadinessStatus;

  if (isAntigravity && (hasGemini || hasClaude)) {
    if (hasGemini && hasClaude) {
      if (geminiExhausted && claudeExhausted) {
        fullyExhausted = true;
        readinessStatus = "fully_exhausted";
      } else if (geminiExhausted) {
        fullyExhausted = false;
        readinessStatus = "claude_only";
      } else if (claudeExhausted) {
        fullyExhausted = false;
        readinessStatus = "gemini_only";
      } else {
        fullyExhausted = false;
        readinessStatus = "both_ready";
      }
    } else if (hasGemini) {
      fullyExhausted = geminiExhausted;
      readinessStatus = geminiExhausted ? "fully_exhausted" : "gemini_only";
    } else {
      fullyExhausted = claudeExhausted;
      readinessStatus = claudeExhausted ? "fully_exhausted" : "claude_only";
    }
  } else {
    fullyExhausted = overallUsedMax >= 100;
    readinessStatus = fullyExhausted ? "exhausted" : "ready";
  }

  const hasAnyLimitsLeft = isAntigravity && (hasGemini || hasClaude)
    ? (!geminiExhausted && hasGemini) || (!claudeExhausted && hasClaude)
    : freeHeadroom > 0;

  return {
    account,
    emailLogin,
    maskedLogin,
    isAntigravity,
    gemini5h,
    geminiWeekly,
    claude5h,
    claudeWeekly,
    generic5h,
    genericWeekly,
    geminiUsedMax,
    claudeUsedMax,
    overallUsedMax,
    freeHeadroom,
    geminiExhausted,
    claudeExhausted,
    fullyExhausted,
    hasAnyLimitsLeft,
    readinessStatus,
  };
}

export type AccountFilterKey =
  | "with_limits"
  | "with_limits_gemini"
  | "with_limits_claude"
  | "all"
  | "gemini_exhausted"
  | "claude_exhausted"
  | "fully_exhausted";

export type AccountSortKey =
  | "more_headroom"
  | "less_headroom"
  | "reset_5h_soonest"
  | "reset_7d_soonest";

export type AccountDisplayKey = "login" | "masked" | "alias";

export type AccountViewModeKey = "cards" | "compact";

export function filterAccounts(
  items: AnalyzedAccountQuota[],
  filter: AccountFilterKey,
  searchQuery: string,
): AnalyzedAccountQuota[] {
  const query = searchQuery.trim().toLowerCase();

  return items.filter(item => {
    // 1. Search text filter
    if (query) {
      const matchLogin = item.emailLogin.toLowerCase().includes(query);
      const matchMasked = item.maskedLogin.toLowerCase().includes(query) || (item.account.maskedEmail ?? "").toLowerCase().includes(query);
      const matchEmail = (item.account.email ?? "").toLowerCase().includes(query);
      const matchAlias = (item.account.alias ?? "").toLowerCase().includes(query);
      const matchId = item.account.id.toLowerCase().includes(query);
      if (!matchLogin && !matchMasked && !matchEmail && !matchAlias && !matchId) return false;
    }

    // 2. Status filter
    switch (filter) {
      case "with_limits":
        return item.hasAnyLimitsLeft;
      case "with_limits_gemini":
        return Boolean(item.gemini5h || item.geminiWeekly) && !item.geminiExhausted;
      case "with_limits_claude":
        return Boolean(item.claude5h || item.claudeWeekly) && !item.claudeExhausted;
      case "gemini_exhausted":
        return item.geminiExhausted;
      case "claude_exhausted":
        return item.claudeExhausted;
      case "fully_exhausted":
        return item.fullyExhausted;
      case "all":
      default:
        return true;
    }
  });
}

export function sortAccounts(
  items: AnalyzedAccountQuota[],
  sortKey: AccountSortKey,
  activeFilter: AccountFilterKey = "with_limits",
): AnalyzedAccountQuota[] {
  const isGeminiFilter = activeFilter === "with_limits_gemini" || activeFilter === "gemini_exhausted";
  const isClaudeFilter = activeFilter === "with_limits_claude" || activeFilter === "claude_exhausted";

  return [...items].sort((a, b) => {
    switch (sortKey) {
      case "more_headroom": {
        if (isGeminiFilter) {
          const aGem = Math.max(0, 100 - a.geminiUsedMax);
          const bGem = Math.max(0, 100 - b.geminiUsedMax);
          if (bGem !== aGem) return bGem - aGem;
        } else if (isClaudeFilter) {
          const aCla = Math.max(0, 100 - a.claudeUsedMax);
          const bCla = Math.max(0, 100 - b.claudeUsedMax);
          if (bCla !== aCla) return bCla - aCla;
        } else {
          if (b.freeHeadroom !== a.freeHeadroom) {
            return b.freeHeadroom - a.freeHeadroom;
          }
        }
        if (a.account.active !== b.account.active) return a.account.active ? -1 : 1;
        return a.emailLogin.localeCompare(b.emailLogin);
      }
      case "less_headroom": {
        if (isGeminiFilter) {
          const aGem = Math.max(0, 100 - a.geminiUsedMax);
          const bGem = Math.max(0, 100 - b.geminiUsedMax);
          if (aGem !== bGem) return aGem - bGem;
        } else if (isClaudeFilter) {
          const aCla = Math.max(0, 100 - a.claudeUsedMax);
          const bCla = Math.max(0, 100 - b.claudeUsedMax);
          if (aCla !== bCla) return aCla - bCla;
        } else {
          if (a.freeHeadroom !== b.freeHeadroom) {
            return a.freeHeadroom - b.freeHeadroom;
          }
        }
        return a.emailLogin.localeCompare(b.emailLogin);
      }
      case "reset_5h_soonest": {
        const get5hReset = (item: AnalyzedAccountQuota) => {
          if (isGeminiFilter && item.gemini5h?.resetAt) return item.gemini5h.resetAt;
          if (isClaudeFilter && item.claude5h?.resetAt) return item.claude5h.resetAt;
          const resets: number[] = [];
          if (item.gemini5h?.resetAt) resets.push(item.gemini5h.resetAt);
          if (item.claude5h?.resetAt) resets.push(item.claude5h.resetAt);
          if (item.generic5h?.resetAt) resets.push(item.generic5h.resetAt);
          return resets.length > 0 ? Math.min(...resets) : Number.MAX_SAFE_INTEGER;
        };
        const aReset = get5hReset(a);
        const bReset = get5hReset(b);
        if (aReset !== bReset) return aReset - bReset;
        return b.freeHeadroom - a.freeHeadroom || a.emailLogin.localeCompare(b.emailLogin);
      }
      case "reset_7d_soonest": {
        const get7dReset = (item: AnalyzedAccountQuota) => {
          if (isGeminiFilter && item.geminiWeekly?.resetAt) return item.geminiWeekly.resetAt;
          if (isClaudeFilter && item.claudeWeekly?.resetAt) return item.claudeWeekly.resetAt;
          const resets: number[] = [];
          if (item.geminiWeekly?.resetAt) resets.push(item.geminiWeekly.resetAt);
          if (item.claudeWeekly?.resetAt) resets.push(item.claudeWeekly.resetAt);
          if (item.genericWeekly?.resetAt) resets.push(item.genericWeekly.resetAt);
          return resets.length > 0 ? Math.min(...resets) : Number.MAX_SAFE_INTEGER;
        };
        const aReset = get7dReset(a);
        const bReset = get7dReset(b);
        if (aReset !== bReset) return aReset - bReset;
        return b.freeHeadroom - a.freeHeadroom || a.emailLogin.localeCompare(b.emailLogin);
      }
      default:
        return 0;
    }
  });
}
