import { decodeJwtPayload, extractAccountId, extractEmail } from "../oauth/chatgpt";
import { extractChatgptPlanType } from "./plan";
import { saveCodexAccountCredential, markCodexAccountValidated } from "./account-store";
import { withCodexAccountLogLabel } from "./account-label";
import { isValidCodexAccountId } from "./account-id";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { getRuntimeConfig, saveRuntimeConfig } from "./auth-api/runtime-config";
import { reconcileLiveStateStores } from "../lib/state-store-registrations";
import { CODEX_FORWARD_BASE_URL } from "../providers/openai-tiers-destination";
import type { CodexAccount, CodexAccountCredentials, OcxConfig } from "../types";

export interface NormalizedCodexAccountImport {
  id?: string;
  email?: string;
  alias?: string;
  plan?: string;
  chatgptAccountId?: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
}

export interface BulkImportCodexOptions {
  config: OcxConfig;
  overwrite?: boolean;
}

export interface BulkImportCodexResult {
  success: boolean;
  total: number;
  imported: string[];
  skipped: string[];
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeAccountId(candidate: string): string {
  const cleaned = candidate.trim().replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.slice(0, 64);
}

function parseExpiresAt(item: Record<string, unknown>, jwtExp?: number): number {
  if (typeof item.expiresAt === "number" && Number.isFinite(item.expiresAt)) {
    return item.expiresAt;
  }
  if (typeof item.expires_at === "number" && Number.isFinite(item.expires_at)) {
    return item.expires_at;
  }
  if (typeof item.expiresAt === "string") {
    const parsed = Date.parse(item.expiresAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof item.expires_at === "string") {
    const parsed = Date.parse(item.expires_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof item.expiresIn === "number" && Number.isFinite(item.expiresIn)) {
    return Date.now() + item.expiresIn * 1000;
  }
  if (typeof item.expires_in === "number" && Number.isFinite(item.expires_in)) {
    return Date.now() + item.expires_in * 1000;
  }
  if (typeof jwtExp === "number" && Number.isFinite(jwtExp)) {
    return jwtExp * 1000;
  }
  // Default to 14 days ahead if unknown
  return Date.now() + 14 * 24 * 60 * 60 * 1000;
}

/**
 * Normalizes a single raw object or string into a NormalizedCodexAccountImport
 * by checking Cockpit, 9router, Sub2API, and auth.json property variants.
 */
export function normalizeSingleCodexAccountCandidate(raw: unknown): NormalizedCodexAccountImport | null {
  if (typeof raw === "string") {
    const token = raw.trim();
    if (!token) return null;
    if (token.startsWith("eyJ")) {
      const claims = decodeJwtPayload(token);
      const email = claims ? extractEmail(undefined, token) : undefined;
      const chatgptAccountId = claims ? extractAccountId(undefined, token) : undefined;
      const plan = claims ? extractChatgptPlanType(undefined, token) : undefined;
      const exp = claims && typeof claims.exp === "number" ? claims.exp : undefined;
      return {
        accessToken: token,
        email,
        chatgptAccountId,
        plan,
        expiresAt: parseExpiresAt({}, exp),
      };
    }
    if (token.startsWith("rt_") || token.startsWith("1//")) {
      return {
        accessToken: "",
        refreshToken: token,
        expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
      };
    }
    return null;
  }

  if (!isPlainObject(raw)) return null;

  const item = raw as Record<string, unknown>;

  // Sub2API platform filter if present
  if (typeof item.platform === "string" && item.platform.toLowerCase() !== "openai" && item.platform.toLowerCase() !== "codex") {
    return null;
  }

  const tokensObj = isPlainObject(item.tokens) ? (item.tokens as Record<string, unknown>) : null;
  const credsObj = isPlainObject(item.credentials) ? (item.credentials as Record<string, unknown>) : null;

  const accessTokenRaw = (
    tokensObj?.access_token ??
    tokensObj?.accessToken ??
    credsObj?.access_token ??
    credsObj?.accessToken ??
    item.access_token ??
    item.accessToken ??
    item.token
  );
  const accessToken = typeof accessTokenRaw === "string" ? accessTokenRaw.trim() : "";

  const refreshTokenRaw = (
    tokensObj?.refresh_token ??
    tokensObj?.refreshToken ??
    credsObj?.refresh_token ??
    credsObj?.refreshToken ??
    item.refresh_token ??
    item.refreshToken
  );
  const refreshToken = typeof refreshTokenRaw === "string" ? refreshTokenRaw.trim() : undefined;

  const idTokenRaw = (
    tokensObj?.id_token ??
    tokensObj?.idToken ??
    credsObj?.id_token ??
    credsObj?.idToken ??
    item.id_token ??
    item.idToken
  );
  const idToken = typeof idTokenRaw === "string" ? idTokenRaw.trim() : undefined;

  // Must have at least an access token or a refresh token
  if (!accessToken && !refreshToken) {
    return null;
  }

  const jwtPayload = decodeJwtPayload(idToken || accessToken) || decodeJwtPayload(accessToken);
  const jwtExp = jwtPayload && typeof jwtPayload.exp === "number" ? jwtPayload.exp : undefined;

  const emailRaw = (
    item.email ??
    tokensObj?.email ??
    credsObj?.email ??
    extractEmail(idToken, accessToken)
  );
  const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : undefined;

  const chatgptAccountIdRaw = (
    item.chatgptAccountId ??
    item.chatgpt_account_id ??
    item.accountId ??
    item.account_id ??
    tokensObj?.account_id ??
    tokensObj?.accountId ??
    credsObj?.account_id ??
    credsObj?.accountId ??
    extractAccountId(idToken, accessToken)
  );
  const chatgptAccountId = typeof chatgptAccountIdRaw === "string" ? chatgptAccountIdRaw.trim() : undefined;

  const planRaw = (
    item.plan ??
    item.planType ??
    item.plan_type ??
    item.chatgptPlanType ??
    item.chatgpt_plan_type ??
    item.auth_file_plan_type ??
    extractChatgptPlanType(idToken, accessToken)
  );
  const plan = typeof planRaw === "string" ? planRaw.trim() : undefined;

  const aliasRaw = (
    item.alias ??
    item.name ??
    item.account_name ??
    item.accountName ??
    item.label ??
    item.note ??
    item.account_note
  );
  const alias = typeof aliasRaw === "string" ? aliasRaw.trim() : undefined;

  const idRaw = typeof item.id === "string" && item.id.trim() ? item.id.trim() : undefined;

  const expiresAt = parseExpiresAt(item, jwtExp);

  return {
    id: idRaw,
    email,
    alias,
    plan,
    chatgptAccountId,
    accessToken,
    refreshToken,
    idToken,
    expiresAt,
  };
}

/**
 * Extracts all valid Codex accounts from any input format (9router, Cockpit, Sub2API, auth.json, NDJSON, or token array).
 */
export function extractCodexAccountsFromRaw(input: unknown): NormalizedCodexAccountImport[] {
  let parsed: unknown = input;

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Fall back to line-by-line parsing below
      }
    }

    if (!parsed || typeof parsed !== "object") {
      const results: NormalizedCodexAccountImport[] = [];
      const lines = trimmed.split(/[\r\n]+/);
      for (const line of lines) {
        const lineTrimmed = line.trim();
        if (!lineTrimmed) continue;
        try {
          const lineJson = JSON.parse(lineTrimmed);
          const normalized = normalizeSingleCodexAccountCandidate(lineJson);
          if (normalized) results.push(normalized);
        } catch {
          const normalized = normalizeSingleCodexAccountCandidate(lineTrimmed);
          if (normalized) results.push(normalized);
        }
      }
      return results;
    }
  }

  const results: NormalizedCodexAccountImport[] = [];

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const normalized = normalizeSingleCodexAccountCandidate(item);
      if (normalized) results.push(normalized);
    }
    return results;
  }

  if (isPlainObject(parsed)) {
    // 1. Sub2API export or object with accounts array: { accounts: [ ... ] }
    if (Array.isArray(parsed.accounts)) {
      for (const item of parsed.accounts) {
        const normalized = normalizeSingleCodexAccountCandidate(item);
        if (normalized) results.push(normalized);
      }
      return results;
    }

    // 2. Single account candidate (e.g. auth.json, single Cockpit account, single 9router account)
    const single = normalizeSingleCodexAccountCandidate(parsed);
    if (single) {
      results.push(single);
      return results;
    }
  }

  return results;
}

/**
 * Bulk imports normalized Codex accounts into OpenCodex's account pool and credential store.
 */
export async function importCodexAccounts(
  accounts: NormalizedCodexAccountImport[],
  options: BulkImportCodexOptions,
): Promise<BulkImportCodexResult> {
  const result: BulkImportCodexResult = {
    success: true,
    total: accounts.length,
    imported: [],
    skipped: [],
    errors: [],
  };

  if (accounts.length === 0) {
    return result;
  }

  const runtimeConfig = getRuntimeConfig(options.config);
  const currentAccounts: CodexAccount[] = [...(runtimeConfig.codexAccounts ?? [])];

  for (let i = 0; i < accounts.length; i++) {
    const item = accounts[i]!;

    if (!item.accessToken && !item.refreshToken) {
      result.errors.push(`Account #${i + 1} has neither accessToken nor refreshToken.`);
      continue;
    }

    // Determine candidate ID
    let candidateId = "";
    if (item.id && isValidCodexAccountId(sanitizeAccountId(item.id))) {
      candidateId = sanitizeAccountId(item.id);
    } else if (item.email) {
      const emailPrefix = item.email.split("@")[0] || "user";
      candidateId = sanitizeAccountId(`openai-${emailPrefix}`);
    } else if (item.chatgptAccountId) {
      candidateId = sanitizeAccountId(`openai-${item.chatgptAccountId}`);
    } else {
      candidateId = `openai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    }

    if (!isValidCodexAccountId(candidateId)) {
      candidateId = `openai-${Date.now().toString(36)}-${i + 1}`;
    }

    const existingIdx = currentAccounts.findIndex(
      acc => acc.id === candidateId || (acc.email && item.email && acc.email.toLowerCase() === item.email.toLowerCase()),
    );

    if (existingIdx >= 0) {
      if (!options.overwrite) {
        let suffix = 2;
        let altId = `${candidateId}-${suffix}`;
        while (currentAccounts.some(acc => acc.id === altId)) {
          suffix += 1;
          altId = `${candidateId}-${suffix}`;
        }
        candidateId = altId;
      } else {
        candidateId = currentAccounts[existingIdx]!.id;
      }
    }

    const credential: CodexAccountCredentials = {
      accessToken: item.accessToken || "",
      refreshToken: item.refreshToken || "",
      expiresAt: item.expiresAt || (Date.now() + 14 * 24 * 60 * 60 * 1000),
      chatgptAccountId: item.chatgptAccountId || "",
    };

    try {
      const generation = saveCodexAccountCredential(candidateId, credential);
      markCodexAccountValidated(candidateId, Date.now(), generation);
      clearAccountNeedsReauth(candidateId);

      const accountRow: CodexAccount = withCodexAccountLogLabel({
        id: candidateId,
        email: item.email || `${candidateId}@codex.local`,
        alias: item.alias,
        plan: item.plan || "plus",
        planSource: "jwt",
        chatgptAccountId: item.chatgptAccountId || credential.chatgptAccountId,
        isMain: false,
      }, currentAccounts);

      if (existingIdx >= 0 && options.overwrite) {
        currentAccounts[existingIdx] = accountRow;
      } else {
        currentAccounts.push(accountRow);
      }

      result.imported.push(candidateId);
    } catch (err: unknown) {
      result.errors.push(`Failed to save account ${candidateId}: ${(err as Error).message}`);
    }
  }

  if (result.imported.length > 0) {
    // Ensure the canonical OpenAI forward provider exists and is set to pool mode
    if (!runtimeConfig.providers) {
      runtimeConfig.providers = {};
    }

    if (!runtimeConfig.providers.openai) {
      runtimeConfig.providers.openai = {
        adapter: "openai-responses",
        baseUrl: CODEX_FORWARD_BASE_URL,
        authMode: "forward",
        codexAccountMode: "pool",
      };
    } else {
      runtimeConfig.providers.openai.codexAccountMode = "pool";
      if (runtimeConfig.providers.openai.disabled) {
        runtimeConfig.providers.openai.disabled = false;
      }
    }

    runtimeConfig.codexAccounts = currentAccounts;
    saveRuntimeConfig(options.config, runtimeConfig);
    reconcileLiveStateStores();
  }

  result.success = result.errors.length === 0;
  return result;
}
