/**
 * Client for the leaderboard section of opencodex.me/dashboard. Reads the collector's public profile
 * endpoints and renders connected profiles only. Every user-supplied string (handle, display name)
 * is written with `textContent`; a handle is validated before it is ever put into a request URL.
 */
import type { TelemetryLeaderboardCopy } from "../../data/telemetry-leaderboard-i18n";

export const TELEMETRY_LEADERBOARD_ENDPOINT = "https://telemetry.opencodex.me/v1/leaderboard";
export const TELEMETRY_PROFILE_BY_HANDLE_ENDPOINT = "https://telemetry.opencodex.me/v1/profiles/by-handle/";
/** Mirrors PROFILE_HANDLE_RE in src/telemetry/profile/contract.ts (asserted by a test). */
export const LEADERBOARD_HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/;
export const LEADERBOARD_PERIODS = ["day", "week", "month"] as const;
export const LEADERBOARD_METRICS = ["tokens", "requests"] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];
export const LEADERBOARD_LIMIT = 50;
const FETCH_TIMEOUT_MS = 10_000;

/** Mirrors PROFILE_AVATARS in src/telemetry/profile/contract.ts. */
export const LEADERBOARD_AVATAR_COLORS: Readonly<Record<string, string>> = Object.freeze({
  slate: "#64748b", red: "#ef4444", orange: "#f97316", amber: "#f59e0b", lime: "#84cc16", green: "#22c55e",
  teal: "#14b8a6", cyan: "#06b6d4", blue: "#3b82f6", indigo: "#6366f1", violet: "#8b5cf6", pink: "#ec4899",
});

export interface LeaderboardEntry {
  rank: number;
  handle: string;
  displayName: string;
  avatar: string;
  tokens: number;
  requests: number;
}

export interface LeaderboardSnapshot {
  period: LeaderboardPeriod;
  metric: LeaderboardMetric;
  total: number;
  entries: LeaderboardEntry[];
}

export interface PublicProfilePeriod { rank: number | null; of: number; tokens: number; requests: number }
export interface PublicProfileView {
  handle: string;
  displayName: string;
  avatar: string;
  periods: Record<LeaderboardPeriod, PublicProfilePeriod>;
  families: Array<{ family: string; tokens: number; requests: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Normalize and validate a handle from user input or the ?profile= parameter. */
export function normalizeLeaderboardHandle(raw: string | null | undefined): string | null {
  const handle = (raw ?? "").trim().toLowerCase();
  if (!LEADERBOARD_HANDLE_RE.test(handle) || handle.includes("--") || /^[0-9-]+$/.test(handle)) return null;
  return handle;
}

export function parseLeaderboardPeriod(raw: string | null | undefined): LeaderboardPeriod {
  return (LEADERBOARD_PERIODS as readonly string[]).includes(raw ?? "") ? raw as LeaderboardPeriod : "week";
}

export function parseLeaderboardMetric(raw: string | null | undefined): LeaderboardMetric {
  return (LEADERBOARD_METRICS as readonly string[]).includes(raw ?? "") ? raw as LeaderboardMetric : "tokens";
}

export function buildLeaderboardUrl(endpoint: string, period: LeaderboardPeriod, metric: LeaderboardMetric): string {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ period, metric, limit: String(LEADERBOARD_LIMIT) }).toString();
  return url.toString();
}

/** Null for an invalid handle, so no request is ever built from one. */
export function buildProfileUrl(endpoint: string, rawHandle: string, metric: LeaderboardMetric): string | null {
  const handle = normalizeLeaderboardHandle(rawHandle);
  if (!handle) return null;
  const url = new URL(encodeURIComponent(handle), endpoint);
  url.search = new URLSearchParams({ metric }).toString();
  return url.toString();
}

export function parseLeaderboard(value: unknown): LeaderboardSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) return null;
  const entries: LeaderboardEntry[] = [];
  for (const raw of value.entries) {
    if (!isRecord(raw) || typeof raw.handle !== "string" || typeof raw.displayName !== "string") continue;
    if (!normalizeLeaderboardHandle(raw.handle)) continue;
    entries.push({
      rank: count(raw.rank),
      handle: raw.handle,
      displayName: raw.displayName.slice(0, 64),
      avatar: typeof raw.avatar === "string" ? raw.avatar : "slate",
      tokens: count(raw.tokens),
      requests: count(raw.requests),
    });
  }
  return {
    period: parseLeaderboardPeriod(typeof value.period === "string" ? value.period : null),
    metric: parseLeaderboardMetric(typeof value.metric === "string" ? value.metric : null),
    total: count(value.total),
    entries,
  };
}

export function parsePublicProfile(value: unknown): PublicProfileView | null {
  if (!isRecord(value) || !isRecord(value.profile) || !isRecord(value.periods)) return null;
  const profile = value.profile;
  if (typeof profile.handle !== "string" || !normalizeLeaderboardHandle(profile.handle) || typeof profile.displayName !== "string") return null;
  const periods = {} as Record<LeaderboardPeriod, PublicProfilePeriod>;
  for (const period of LEADERBOARD_PERIODS) {
    const entry = value.periods[period];
    if (!isRecord(entry)) return null;
    periods[period] = {
      rank: typeof entry.rank === "number" && entry.rank > 0 ? Math.floor(entry.rank) : null,
      of: count(entry.of),
      tokens: count(entry.tokens),
      requests: count(entry.requests),
    };
  }
  const families = Array.isArray(value.families)
    ? value.families.filter(isRecord).filter(row => typeof row.family === "string")
        .map(row => ({ family: String(row.family), tokens: count(row.tokens), requests: count(row.requests) }))
    : [];
  return {
    handle: profile.handle,
    displayName: profile.displayName.slice(0, 64),
    avatar: typeof profile.avatar === "string" ? profile.avatar : "slate",
    periods,
    families,
  };
}

export function formatRankOf(copy: TelemetryLeaderboardCopy, rank: number | null, of: number, number: Intl.NumberFormat): string {
  if (rank === null) return copy.profileNotRanked;
  return copy.profileRankOf.replace("{rank}", number.format(rank)).replace("{of}", number.format(of));
}

export function avatarColor(avatar: string): string {
  return LEADERBOARD_AVATAR_COLORS[avatar] ?? LEADERBOARD_AVATAR_COLORS.slate!;
}

function initial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export interface MountLeaderboardOptions {
  root?: ParentNode;
  fetchImpl?: typeof fetch;
  location?: { search: string };
  history?: { replaceState: (data: unknown, unused: string, url?: string) => void };
}

/** Wire up every `[data-telemetry-leaderboard]` root on the page. */
export function mountTelemetryLeaderboard(options: MountLeaderboardOptions = {}): void {
  const scope = options.root ?? document;
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  for (const root of Array.from(scope.querySelectorAll<HTMLElement>("[data-telemetry-leaderboard]"))) {
    mountOne(root, fetchImpl, options);
  }
}

function mountOne(root: HTMLElement, fetchImpl: typeof fetch, options: MountLeaderboardOptions): void {
  const pageHistory = options.history ?? (typeof history !== "undefined" ? history : undefined);
  const copy = JSON.parse(root.dataset.copy ?? "{}") as TelemetryLeaderboardCopy;
  const locale = root.dataset.locale ?? "en";
  const leaderboardEndpoint = root.dataset.leaderboardEndpoint ?? TELEMETRY_LEADERBOARD_ENDPOINT;
  const profileEndpoint = root.dataset.profileEndpoint ?? TELEMETRY_PROFILE_BY_HANDLE_ENDPOINT;
  const number = new Intl.NumberFormat(locale === "zh-cn" ? "zh-CN" : locale === "zh-tw" ? "zh-TW" : locale);
  const compact = new Intl.NumberFormat(locale === "zh-cn" ? "zh-CN" : locale === "zh-tw" ? "zh-TW" : locale, { notation: "compact", maximumFractionDigits: 1 });
  const body = root.querySelector<HTMLElement>("[data-tl-rows]");
  const status = root.querySelector<HTMLElement>("[data-tl-status]");
  const retry = root.querySelector<HTMLButtonElement>("[data-tl-retry]");
  const profilePanel = root.querySelector<HTMLElement>("[data-tl-profile]");
  const form = root.querySelector<HTMLFormElement>("[data-tl-find]");
  const input = root.querySelector<HTMLInputElement>("[data-tl-find-input]");
  const findError = root.querySelector<HTMLElement>("[data-tl-find-error]");
  const search = new URLSearchParams(options.location?.search ?? (typeof location !== "undefined" ? location.search : ""));
  let period = parseLeaderboardPeriod(search.get("period"));
  let metric = parseLeaderboardMetric(search.get("metric"));
  let sequence = 0;
  let profileSequence = 0;

  const setPressed = () => {
    for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-tl-period]"))) {
      button.setAttribute("aria-pressed", String(button.dataset.tlPeriod === period));
    }
    for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-tl-metric]"))) {
      button.setAttribute("aria-pressed", String(button.dataset.tlMetric === metric));
    }
  };

  const setStatus = (text: string, showRetry: boolean) => {
    if (status) {
      status.textContent = text;
      status.hidden = text.length === 0;
    }
    if (retry) retry.hidden = !showRetry;
  };

  const renderRows = (snapshot: LeaderboardSnapshot) => {
    if (!body) return;
    body.replaceChildren();
    for (const entry of snapshot.entries) {
      const row = document.createElement("tr");
      const rank = document.createElement("td");
      rank.className = "tl-rank";
      rank.textContent = number.format(entry.rank);
      const who = document.createElement("td");
      const link = document.createElement("a");
      link.className = "tl-who";
      link.href = `?profile=${encodeURIComponent(entry.handle)}#leaderboard`;
      link.addEventListener("click", event => {
        event.preventDefault();
        void showProfile(entry.handle);
      });
      const avatar = document.createElement("span");
      avatar.className = "tl-avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.style.setProperty("background-color", avatarColor(entry.avatar));
      avatar.textContent = initial(entry.displayName);
      const name = document.createElement("span");
      name.className = "tl-name";
      name.textContent = entry.displayName;
      const handle = document.createElement("span");
      handle.className = "tl-handle";
      handle.textContent = `@${entry.handle}`;
      link.append(avatar, name, handle);
      who.append(link);
      const tokens = document.createElement("td");
      tokens.className = "tl-num";
      tokens.textContent = compact.format(entry.tokens);
      tokens.title = number.format(entry.tokens);
      const requests = document.createElement("td");
      requests.className = "tl-num";
      requests.textContent = number.format(entry.requests);
      row.append(rank, who, tokens, requests);
      body.append(row);
    }
  };

  const load = async () => {
    const mine = ++sequence;
    setPressed();
    setStatus(copy.loading, false);
    try {
      const { status: code, body: payload } = await fetchJson(buildLeaderboardUrl(leaderboardEndpoint, period, metric), fetchImpl);
      if (mine !== sequence) return;
      const snapshot = code === 200 ? parseLeaderboard(payload) : null;
      if (!snapshot) {
        body?.replaceChildren();
        setStatus(copy.error, true);
        return;
      }
      renderRows(snapshot);
      setStatus(snapshot.entries.length === 0 ? copy.empty : "", false);
    } catch {
      if (mine !== sequence) return;
      body?.replaceChildren();
      setStatus(copy.error, true);
    }
  };

  const renderProfile = (view: PublicProfileView | null) => {
    if (!profilePanel) return;
    profilePanel.replaceChildren();
    profilePanel.hidden = false;
    if (!view) {
      const missing = document.createElement("p");
      missing.textContent = copy.profileNotFound;
      profilePanel.append(missing);
      return;
    }
    const header = document.createElement("div");
    header.className = "tl-profile-header";
    const avatar = document.createElement("span");
    avatar.className = "tl-avatar tl-avatar-lg";
    avatar.setAttribute("aria-hidden", "true");
    avatar.style.setProperty("background-color", avatarColor(view.avatar));
    avatar.textContent = initial(view.displayName);
    const titles = document.createElement("div");
    const name = document.createElement("h3");
    name.className = "tl-profile-name";
    name.textContent = view.displayName;
    const handle = document.createElement("span");
    handle.className = "tl-handle";
    handle.textContent = `@${view.handle}`;
    titles.append(name, handle);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tl-close";
    close.textContent = copy.profileClose;
    close.addEventListener("click", () => {
      profilePanel.hidden = true;
      profilePanel.replaceChildren();
      pageHistory?.replaceState(null, "", "#leaderboard");
    });
    header.append(avatar, titles, close);
    const grid = document.createElement("div");
    grid.className = "tl-profile-periods";
    const labels: Record<LeaderboardPeriod, string> = { day: copy.periodDay, week: copy.periodWeek, month: copy.periodMonth };
    for (const p of LEADERBOARD_PERIODS) {
      const cell = document.createElement("div");
      cell.className = "tl-profile-period";
      const label = document.createElement("span");
      label.className = "tl-label";
      label.textContent = labels[p];
      const rank = document.createElement("strong");
      rank.textContent = formatRankOf(copy, view.periods[p].rank, view.periods[p].of, number);
      const totals = document.createElement("span");
      totals.className = "tl-label";
      totals.textContent = `${compact.format(view.periods[p].tokens)} ${copy.metricTokens} · ${number.format(view.periods[p].requests)} ${copy.metricRequests}`;
      cell.append(label, rank, totals);
      grid.append(cell);
    }
    profilePanel.append(header, grid);
    if (view.families.length > 0) {
      const families = document.createElement("p");
      families.className = "tl-label";
      families.textContent = `${copy.profileFamilies}: ${view.families.slice(0, 5).map(row => row.family).join(", ")}`;
      profilePanel.append(families);
    }
  };

  const showProfile = async (rawHandle: string) => {
    const mine = ++profileSequence;
    const url = buildProfileUrl(profileEndpoint, rawHandle, metric);
    if (!url) {
      if (findError) {
        findError.textContent = copy.findInvalid;
        findError.hidden = false;
      }
      return;
    }
    if (findError) findError.hidden = true;
    try {
      const { status: code, body: payload } = await fetchJson(url, fetchImpl);
      // A later lookup started while this one was in flight: its answer wins.
      if (mine !== profileSequence) return;
      renderProfile(code === 200 ? parsePublicProfile(payload) : null);
      const handle = normalizeLeaderboardHandle(rawHandle)!;
      pageHistory?.replaceState(null, "", `?profile=${encodeURIComponent(handle)}#leaderboard`);
    } catch {
      if (mine === profileSequence) renderProfile(null);
    }
  };

  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-tl-period]"))) {
    button.addEventListener("click", () => {
      period = parseLeaderboardPeriod(button.dataset.tlPeriod);
      void load();
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-tl-metric]"))) {
    button.addEventListener("click", () => {
      metric = parseLeaderboardMetric(button.dataset.tlMetric);
      void load();
    });
  }
  retry?.addEventListener("click", () => { void load(); });
  form?.addEventListener("submit", event => {
    event.preventDefault();
    void showProfile(input?.value ?? "");
  });

  void load();
  const requested = search.get("profile");
  if (requested !== null) void showProfile(requested);
}

