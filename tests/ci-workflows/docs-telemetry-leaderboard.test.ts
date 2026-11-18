import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "../../gui/node_modules/happy-dom";
import {
  LEADERBOARD_AVATAR_COLORS,
  LEADERBOARD_HANDLE_RE,
  TELEMETRY_LEADERBOARD_ENDPOINT,
  TELEMETRY_PROFILE_BY_HANDLE_ENDPOINT,
  buildLeaderboardUrl,
  buildProfileUrl,
  mountTelemetryLeaderboard,
  normalizeLeaderboardHandle,
  parseLeaderboard,
  parsePublicProfile,
} from "../../docs-site/src/components/telemetry-dashboard/leaderboard";
import {
  TELEMETRY_LEADERBOARD_LOCALES,
  TELEMETRY_LEADERBOARD_STRINGS,
} from "../../docs-site/src/data/telemetry-leaderboard-i18n";
import { PROFILE_AVATARS, PROFILE_HANDLE_RE } from "../../src/telemetry/profile/contract";
import { repoPath } from "../helpers/repo-root";

const LEADERBOARD = {
  schemaVersion: 1, period: "week", metric: "tokens", from: "2026-11-02", to: "2026-11-08", generatedAt: "2026-11-09T00:00:00.000Z", total: 2,
  entries: [
    { rank: 1, handle: "alpha", displayName: "<img src=x onerror=alert(1)>", avatar: "teal", tokens: 1_500_000, requests: 120 },
    { rank: 2, handle: "bravo", displayName: "Bravo", avatar: "unknown-colour", tokens: 900, requests: 3 },
    { rank: 3, handle: "Bad Handle!", displayName: "x", avatar: "red", tokens: 1, requests: 1 },
  ],
};
const PROFILE = {
  ok: true,
  profile: { handle: "alpha", displayName: "Alpha", avatar: "teal" },
  metric: "tokens",
  periods: {
    day: { rank: null, of: 4, tokens: 0, requests: 0 },
    week: { rank: 1, of: 2, tokens: 1_500_000, requests: 120 },
    month: { rank: 3, of: 9, tokens: 2_000_000, requests: 300 },
  },
  families: [{ family: "claude-opus", tokens: 1_200_000, requests: 90 }],
};

describe("docs-site leaderboard", () => {
  test("handle rule and palette match the profile contract", () => {
    expect(LEADERBOARD_HANDLE_RE.source).toBe(PROFILE_HANDLE_RE.source);
    expect(Object.keys(LEADERBOARD_AVATAR_COLORS)).toEqual([...PROFILE_AVATARS]);
    expect(TELEMETRY_LEADERBOARD_ENDPOINT).toBe("https://telemetry.opencodex.me/v1/leaderboard");
    expect(TELEMETRY_PROFILE_BY_HANDLE_ENDPOINT).toBe("https://telemetry.opencodex.me/v1/profiles/by-handle/");
  });

  test("every site locale carries complete leaderboard copy", () => {
    const configured = ["en", ...readFileSync(repoPath("docs-site/astro.config.mjs"), "utf8")
      .matchAll(/^\s*["']?([a-z]{2}(?:-[a-z]{2})?)["']?:\s*\{\s*label:/gm)]
      .map(value => typeof value === "string" ? value : value[1]!);
    expect([...TELEMETRY_LEADERBOARD_LOCALES].sort()).toEqual(configured.sort());
    const keys = Object.keys(TELEMETRY_LEADERBOARD_STRINGS.en).sort();
    const hangul = /[\uac00-\ud7af]/;
    for (const locale of TELEMETRY_LEADERBOARD_LOCALES) {
      const copy = TELEMETRY_LEADERBOARD_STRINGS[locale];
      expect(Object.keys(copy).sort()).toEqual(keys);
      for (const [key, value] of Object.entries(copy)) {
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
        if (locale !== "ko") expect(hangul.test(value), `${locale}.${key}`).toBe(false);
      }
      expect(copy.profileRankOf).toContain("{rank}");
      expect(copy.profileRankOf).toContain("{of}");
    }
  });

  test("no request URL is ever built from an invalid handle", () => {
    expect(buildProfileUrl(TELEMETRY_PROFILE_BY_HANDLE_ENDPOINT, " Alpha ", "tokens"))
      .toBe("https://telemetry.opencodex.me/v1/profiles/by-handle/alpha?metric=tokens");
    for (const bad of ["../stats", "a/b", "x?y=1", "%2e%2e", "ab", "a--b", "1234", "<script>"]) {
      expect(buildProfileUrl(TELEMETRY_PROFILE_BY_HANDLE_ENDPOINT, bad, "tokens")).toBeNull();
      expect(normalizeLeaderboardHandle(bad)).toBeNull();
    }
    expect(buildLeaderboardUrl(TELEMETRY_LEADERBOARD_ENDPOINT, "day", "requests"))
      .toBe("https://telemetry.opencodex.me/v1/leaderboard?period=day&metric=requests&limit=50");
  });

  test("parsers drop malformed rows and keep only documented fields", () => {
    const board = parseLeaderboard(LEADERBOARD)!;
    expect(board.entries.map(entry => entry.handle)).toEqual(["alpha", "bravo"]);
    expect(parseLeaderboard({ entries: "nope" })).toBeNull();
    const view = parsePublicProfile(PROFILE)!;
    expect(view.periods.day.rank).toBeNull();
    expect(view.periods.month).toEqual({ rank: 3, of: 9, tokens: 2_000_000, requests: 300 });
    expect(parsePublicProfile({ ...PROFILE, profile: { handle: "../x", displayName: "x" } })).toBeNull();
  });

  test("renders names as text, follows ?profile=, and never fetches an invalid handle", async () => {
    const win = new Window({ url: "https://opencodex.me/dashboard/" });
    const doc = win.document;
    const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, "document");
    const previousDocument = Reflect.get(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: doc });
    try {
      const astro = readFileSync(repoPath("docs-site/src/components/TelemetryLeaderboard.astro"), "utf8");
      const markup = astro.slice(astro.indexOf("<section"), astro.indexOf("</section>") + "</section>".length)
        .replace(/\{periods\.map[^}]*\}\)\}/s, '<button type="button" data-tl-period="day">Day</button><button type="button" data-tl-period="week">Week</button>')
        .replace(/\{metrics\.map[^}]*\}\)\}/s, '<button type="button" data-tl-metric="tokens">Tokens</button><button type="button" data-tl-metric="requests">Requests</button>')
        .replace(/\{copy\.[a-zA-Z]+\}/g, "")
        .replace(/data-copy=\{[^}]*\}\}/, "")
        .replace(/\s[a-z-]+=\{[^}]*\}/g, "");
      doc.body.innerHTML = markup;
      const root = doc.querySelector("[data-telemetry-leaderboard]") as unknown as HTMLElement;
      root.dataset.copy = JSON.stringify(TELEMETRY_LEADERBOARD_STRINGS.en);
      root.dataset.locale = "en";
      const fetched: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        fetched.push(url);
        return Response.json(url.includes("/by-handle/") ? PROFILE : LEADERBOARD);
      }) as typeof fetch;
      const replaced: string[] = [];
      mountTelemetryLeaderboard({
        root: doc as unknown as ParentNode,
        fetchImpl,
        location: { search: "?profile=alpha&period=week" },
        history: { replaceState: (_d, _u, url) => { replaced.push(String(url)); } },
      });
      await new Promise(resolve => setTimeout(resolve, 30));
      const rows = doc.querySelectorAll("[data-tl-rows] tr");
      expect(rows.length).toBe(2);
      expect(doc.querySelector("[data-tl-rows] img")).toBeNull();
      expect(rows[0]!.textContent).toContain("<img src=x onerror=alert(1)>");
      expect(doc.querySelector("[data-tl-profile]")!.textContent).toContain("#1 of 2");
      expect(fetched).toContain("https://telemetry.opencodex.me/v1/profiles/by-handle/alpha?metric=tokens");
      expect(replaced).toContain("?profile=alpha#leaderboard");

      const input = doc.querySelector("[data-tl-find-input]") as unknown as HTMLInputElement;
      input.value = "../stats";
      const before = fetched.length;
      doc.querySelector("[data-tl-find]")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fetched.length).toBe(before);
      expect(doc.querySelector("[data-tl-find-error]")!.textContent).toBe(TELEMETRY_LEADERBOARD_STRINGS.en.findInvalid);
    } finally {
      if (hadDocument) Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: previousDocument });
      else Reflect.deleteProperty(globalThis, "document");
      await win.happyDOM.close();
    }
  });

  test("the client never writes HTML and the dashboard page mounts the section", () => {
    const client = readFileSync(repoPath("docs-site/src/components/telemetry-dashboard/leaderboard.ts"), "utf8");
    expect(client).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    const mdx = readFileSync(repoPath("docs-site/src/content/docs/dashboard.mdx"), "utf8");
    expect(mdx).toContain("import TelemetryLeaderboard from '../../components/TelemetryLeaderboard.astro'");
    expect(mdx).toContain("<TelemetryLeaderboard />");
    expect(mdx.indexOf("<TelemetryDashboard />")).toBeLessThan(mdx.indexOf("<TelemetryLeaderboard />"));
  });
});
