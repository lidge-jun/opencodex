import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Window } from "../../gui/node_modules/happy-dom";
import { createElement } from "../../gui/node_modules/react";
import { renderToStaticMarkup } from "../../gui/node_modules/react-dom/server";
import { DICTS, I18nContext, type TFn } from "../../gui/src/i18n/shared";
import { StartupHeroSection } from "../../gui/src/pages/startup-sections";
import { DashboardOverviewHead } from "../../gui/src/pages/dashboard-overview-head";
import type { StartupHealthData } from "../../gui/src/pages/startup-shared";
import { diagnoseMacDesktopStartup } from "../../src/service/desktop-startup";
import { repoPath } from "../helpers/repo-root";
import {
  PROJECT_CONFIG_DIAGNOSTICS_POLL_MS,
  beginPollEpochs,
  desktopBadgeKey,
  desktopManagesStartup,
  mapStartupHealthProbe,
  mergeStartupProbe,
  probeNeedsFastRetry,
  seedStartupHealthFromSettings,
  settingsPollMayCommit,
  startupChecklistDone,
  startupPresentation,
  startupRiskDetailKey,
} from "../../gui/src/startup-health-ui";

// Classic is a partial overlay: resolve its relative imports as Vite's classic overlay does.
const classicRoot = repoPath("gui/classic/src");
const sharedRoot = repoPath("gui/src");
Bun.plugin({ name: "classic-test-overlay", setup(build) {
  build.onLoad({ filter: /gui[\\/]classic[\\/]src[\\/].*\.tsx$/ }, ({ path }) => {
    const contents = readFileSync(path, "utf8").replace(/(from\s+["'])(\.[^"']+)(["'])/g, (_match, prefix, specifier, quote) => {
      const shared = join(sharedRoot, path.slice(classicRoot.length + 1), "..", specifier);
      for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const candidate = shared + suffix;
        const classic = join(classicRoot, candidate.slice(sharedRoot.length + 1));
        if (existsSync(classic)) return prefix + classic.replaceAll("\\", "/") + quote;
        if (existsSync(candidate)) return prefix + candidate.replaceAll("\\", "/") + quote;
      }
      throw new Error(`Cannot resolve Classic import ${specifier} from ${path}`);
    });
    return { contents, loader: "tsx" };
  });
} });

describe("startup health UI decisions", () => {
  test("confirmed absent supervision reaches both dashboard editions and their recovery guidance", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-startup-ui-"));
    try {
      const id = join(home, "Library/Application Support/com.opencodex.desktop/install-id");
      mkdirSync(dirname(id), { recursive: true });
      writeFileSync(id, "installation-a");
      const desktop = diagnoseMacDesktopStartup({ platform: "darwin", home,
        ownership: () => ({ kind: "owned", revision: 1, ownership: { owner: "desktop", installId: "installation-a", consentGeneration: 1 } }),
        readPid: () => 100, readRuntimePortPid: () => null,
        run: (_command, args) => args[1] === "100" ? `200 ${process.execPath}` : `1 ${process.execPath}`,
      })!;
      expect(desktop).toMatchObject({ owned: true, running: false, viable: false, loginState: "unknown" });
      expect(desktop.supervisionUnknown).not.toBe(true);
      const data = { status: "at-risk", routingKind: "opencodex-local", desktop, diagnosticStale: false,
        protection: "none", shimCoverage: "none", autostartEnabled: false } as StartupHealthData;
      const status = mapStartupHealthProbe(data);
      expect(status).toBe("at-risk");
      const t: TFn = key => DICTS.en[key];
      const wrap = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nContext.Provider,
        { value: { locale: "en", setLocale: () => {}, t } }, child));
      const hero = wrap(createElement(StartupHeroSection, { failed: false, data }));
      expect(hero).toContain("Action required");
      expect(hero).toContain("Reopen the desktop app");
      const headProps = { locale: "en" as const, health: null, providers: [], usage30d: null, usageLoading: false,
        healthLoading: false, startupHealth: status, projectConfigWarnings: [] };
      const main = wrap(createElement(DashboardOverviewHead, headProps));
      expect(main).toContain(DICTS.en["startup.summary.atRisk"]);
      expect(main).not.toContain(DICTS.en["startup.unverified"]);
      const { DashboardOverviewHead: ClassicHead } = await import("../../gui/classic/src/pages/dashboard-overview-head");
      const { StartupHeroSection: ClassicHero } = await import("../../gui/classic/src/pages/startup-sections");
      const window = new Window();
      const renderClassic = (health: StartupHealthData) => {
        const head = wrap(createElement(ClassicHead, { ...headProps, startupHealth: mapStartupHealthProbe(health),
          maMode: "default", maBusy: false, maHelpTriggerRef: { current: null }, maHelpOpen: false,
          setMaHelpOpen: () => {}, switchMaMode: async () => {}, maError: null }));
        const hero = wrap(createElement(ClassicHero, { failed: false, data: health }));
        const headNode = window.document.createElement("div");
        const heroNode = window.document.createElement("div");
        headNode.innerHTML = head;
        heroNode.innerHTML = hero;
        return { head: headNode.textContent ?? "", hero: heroNode.textContent ?? "" };
      };
      const risk = renderClassic(data);
      expect(risk.head).toContain(DICTS.en["startup.summary.atRisk"]);
      expect(risk.head).not.toContain(DICTS.en["startup.unverified"]);
      expect(risk.hero).toContain(DICTS.en["startup.status.atRisk"]);
      expect(risk.hero).toContain(DICTS.en["startup.desktopRecovery"]);

      const runningDesktop = { ...desktop, running: true, loginState: "unknown", loginEnabled: false, viable: false } as const;
      const unknown = renderClassic({ ...data, desktop: runningDesktop });
      expect(unknown.head).toContain(DICTS.en["startup.unverified"]);
      expect(unknown.hero).toContain(DICTS.en["startup.loginUnverifiedTitle"]);
      expect(unknown.hero).not.toContain(DICTS.en["startup.status.atRisk"]);

      const enabled = renderClassic({ ...data, status: "protected", protection: "desktop", rebootSafe: true,
        desktop: { ...runningDesktop, loginState: "enabled", loginEnabled: true, viable: true } });
      expect(enabled.head).toContain(DICTS.en["startup.summary.protected"]);
      expect(enabled.hero).toContain(DICTS.en["startup.safeDetail"]);
      expect(enabled.hero).not.toContain(DICTS.en["startup.status.atRisk"]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  test("desktop login evidence distinguishes unverified, disabled and protected presentation", () => {
    const base = {
      status: "at-risk", routingKind: "opencodex-local", routingInjected: true,
      localRoutingDependency: true, autostartEnabled: true, rebootSafe: false, protection: "none",
      serviceInstalled: false, serviceViable: false, serviceEnabled: false, serviceRunning: false,
      serviceStale: false, serviceConflict: false, serviceSupported: true,
      shimInstalled: false, shimHealthy: false, shimCoverage: "none", platform: "darwin",
      recommendedCommand: null, diagnosticStale: false,
      commands: { installService: "ocx service install", repairService: "ocx service repair",
        installShim: "ocx codex-shim install", restoreNative: "ocx restore" },
    } as const;
    const t: TFn = key => DICTS.en[key];
    const render = (loginState: "unknown" | "disabled" | "enabled", running = true) => {
      const enabled = loginState === "enabled";
      const data = { ...base, ...(enabled ? { status: "protected", rebootSafe: true, protection: "desktop" } : {}),
        desktop: { owned: true, running, loginEnabled: enabled, loginState, viable: enabled && running } } as StartupHealthData;
      return renderToStaticMarkup(createElement(I18nContext.Provider,
        { value: { locale: "en", setLocale: () => {}, t } },
        createElement(StartupHeroSection, { failed: false, data })));
    };
    expect(render("unknown")).not.toContain("Action required");
    expect(render("unknown", false)).toContain("Action required");
    expect(render("unknown", false)).toContain("Reopen the desktop app");
    expect(render("disabled")).toContain("Action required");
    expect(render("enabled")).not.toContain("Action required");
    const cold = renderToStaticMarkup(createElement(I18nContext.Provider,
      { value: { locale: "en", setLocale: () => {}, t } },
      createElement(StartupHeroSection, { failed: true, data: { ...base, diagnosticStale: true } as StartupHealthData })));
    expect(cold).not.toContain("Action required");
    expect(cold).not.toContain("OpenCodex menu");
  });

  test("desktop uncertainty does not hide independently protected or unrelated routing", () => {
    const desktop = { owned: true, loginState: "unknown" };
    expect(startupPresentation({ status: "at-risk", routingKind: "opencodex-local", desktop })).toBe("unverified");
    expect(startupPresentation({ status: "at-risk", routingKind: "opencodex-local", desktop: { ...desktop, loginState: "disabled" } })).toBe("at-risk");
    expect(startupPresentation({ status: "at-risk", routingKind: "opencodex-local", desktop: { ...desktop, loginState: "enabled" } })).toBe("at-risk");
    expect(startupPresentation({ status: "protected", routingKind: "opencodex-local", desktop })).toBe("protected");
    expect(startupPresentation({ status: "at-risk", routingKind: "custom-local", desktop })).toBe("at-risk");
    expect(startupPresentation({ status: "at-risk", routingKind: "opencodex-local", desktop: { owned: false, supervisor: null } })).toBe("at-risk");
    expect(startupPresentation({ status: "at-risk", routingKind: "opencodex-local", desktop: { owned: false, supervisor: {} } })).toBe("at-risk");
    expect(mapStartupHealthProbe({ status: "at-risk", routingKind: "opencodex-local", desktop })).toBe("unverified");
    expect(startupChecklistDone({ status: "at-risk", routingKind: "opencodex-local", desktop, protection: "none" })).toBeUndefined();
    expect(startupChecklistDone({ status: "protected", routingKind: "opencodex-local", desktop, protection: "desktop" })).toBe(true);
    expect(startupPresentation({ status: "at-risk", routingKind: "opencodex-local", diagnosticStale: true, desktop: { ...desktop, loginState: "disabled" } })).toBe("unverified");
    expect(startupPresentation({ status: "at-risk", routingKind: "opencodex-local", diagnosticStale: true })).toBe("unverified");
    expect(startupPresentation({ status: "at-risk", routingKind: "opencodex-local", diagnosticStale: true }, true)).toBe("unverified");
    expect(mergeStartupProbe({ status: "unverified", stale: true }, true)).toEqual({ status: "unverified", desktopManaged: true });
    expect(mergeStartupProbe({ status: "error", stale: false }, true)).toEqual({ status: "unverified", desktopManaged: true });
    expect(mergeStartupProbe({ status: "error", stale: false }, false)).toEqual({ status: "error", desktopManaged: false });
    expect(mergeStartupProbe({ status: "protected", stale: false, desktopManaged: true }, false)).toEqual({ status: "protected", desktopManaged: true });
    expect(seedStartupHealthFromSettings(null, { status: "at-risk", diagnosticStale: true, routingKind: "opencodex-local", desktop })).toBe("unverified");
    expect(seedStartupHealthFromSettings(null, { status: "at-risk", diagnosticStale: true, routingKind: "opencodex-local" })).toBe("unverified");
  });
  test("fresh stopped Desktop supervision is actionable even when login is unknown", () => {
    const desktop = { owned: true, loginState: "unknown", running: false, viable: false };
    const health = { status: "at-risk", routingKind: "opencodex-local", diagnosticStale: false, desktop } as const;
    expect(startupPresentation(health)).toBe("at-risk");
    expect(mapStartupHealthProbe(health)).toBe("at-risk");
    expect(seedStartupHealthFromSettings(null, health)).toBe("at-risk");
    expect(startupChecklistDone({ ...health, protection: "none" })).toBe(false);
    expect(startupPresentation({ ...health, diagnosticStale: true })).toBe("unverified");
    expect(startupPresentation({ ...health, desktop: { ...desktop, running: true } })).toBe("unverified");
    expect(startupPresentation({ ...health, desktop: { ...desktop, supervisionUnknown: true } })).toBe("unverified");
    expect(startupPresentation({ ...health, desktop: { ...desktop, loginState: "enabled", supervisionUnknown: true } })).toBe("unverified");
    expect(startupPresentation({ ...health, desktop: { ...desktop, loginState: "disabled", supervisionUnknown: true } })).toBe("at-risk");
    expect(startupPresentation({ ...health, status: "protected" })).toBe("protected");
  });
  test("settings seeds recover from stale data without replacing a dedicated probe", () => {
    const stale = { status: "at-risk", diagnosticStale: true, routingKind: "opencodex-local" } as const;
    const fresh = { status: "protected", diagnosticStale: false, routingKind: "opencodex-local" } as const;
    expect(seedStartupHealthFromSettings("protected", stale, true)).toBe("protected");
    expect(seedStartupHealthFromSettings("unverified", fresh, false)).toBe("protected");
    expect(seedStartupHealthFromSettings("unverified", fresh, true)).toBe("unverified");
  });
  test("dashboard uses a generic unverified label when Desktop context is absent", () => {
    const t: TFn = key => DICTS.en[key];
    const markup = renderToStaticMarkup(createElement(I18nContext.Provider,
      { value: { locale: "en", setLocale: () => {}, t } },
      createElement(DashboardOverviewHead, { locale: "en", health: null, providers: [], usage30d: null,
        usageLoading: false, healthLoading: false, startupHealth: "unverified", projectConfigWarnings: [] })));
    expect(markup).toContain(DICTS.en["startup.unverified"]);
    expect(markup).not.toContain(DICTS.en["startup.loginUnverifiedTitle"]);
  });
  test("selects the shared risk-detail message", () => {
    expect(startupRiskDetailKey({ routingKind: "custom-local", shimCoverage: "none" }))
      .toBe("startup.riskDetailCustomLocal");
    expect(startupRiskDetailKey({ routingKind: "opencodex-local", shimCoverage: "cli-only" }))
      .toBe("startup.riskDetailWindowsShim");
    expect(startupRiskDetailKey({ routingKind: "unknown", shimCoverage: "none" }))
      .toBe("startup.riskDetail");
  });

  test("desktop startup management requires ownership or verified supervision", () => {
    const supervisor = { supervisorPid: 123, runtimePid: 456, app: "/Applications/OpenCodex.app" };
    expect(desktopManagesStartup({})).toBe(false);
    expect(desktopManagesStartup({ desktop: { owned: false } })).toBe(false);
    expect(desktopManagesStartup({ desktop: { owned: false, supervisor: undefined } })).toBe(false);
    expect(desktopManagesStartup({ desktop: { owned: true } })).toBe(true);
    expect(desktopManagesStartup({ desktop: { owned: false, supervisor } })).toBe(true);
    expect(desktopManagesStartup({ desktop: { owned: true, supervisor } })).toBe(true);
  });

  test("desktop risk details distinguish ownership from live supervision", () => {
    const base = { routingKind: "opencodex-local", shimCoverage: "cli-only" } as const;
    const supervisor = { supervisorPid: 123, runtimePid: 456, app: "/Applications/OpenCodex.app" };
    expect(startupRiskDetailKey({ ...base, desktop: { owned: true } })).toBe("startup.desktopRecovery");
    expect(startupRiskDetailKey({ ...base, desktop: { owned: false, supervisor } }))
      .toBe("startup.desktopSupervisedRecovery");
    expect(startupRiskDetailKey({ ...base, desktop: { owned: true, supervisor } }))
      .toBe("startup.desktopRecovery");
    expect(startupRiskDetailKey({ ...base, desktop: { owned: false } }))
      .toBe("startup.riskDetailWindowsShim");
    expect(startupRiskDetailKey({ ...base, routingKind: "custom-local", desktop: { owned: false, supervisor } }))
      .toBe("startup.riskDetailCustomLocal");
  });

  test("a running desktop app with unverified Start at Login is not labelled unhealthy (#6963)", () => {
    const supervisor = { supervisorPid: 123, runtimePid: 456, app: "/Applications/OpenCodex.app" };
    const loginOff = { running: true, loginEnabled: false, viable: false };
    expect(desktopBadgeKey({ owned: true, ...loginOff, loginState: "disabled" }, false)).toBe("startup.loginDisabled");
    expect(desktopBadgeKey({ owned: false, supervisor, ...loginOff }, false)).toBe("startup.desktopLoginUnverified");
    expect(desktopBadgeKey({ owned: true, ...loginOff }, false)).toBe("startup.desktopLoginUnverified");
    // A failed or stale read never vouches for the running process it last saw.
    expect(desktopBadgeKey({ owned: false, supervisor, ...loginOff }, true)).toBe("startup.unhealthy");
    expect(desktopBadgeKey({ owned: true, running: true, loginEnabled: true, viable: true }, true)).toBe("startup.unhealthy");
    // Stopped, or neither owned nor supervised, stays unhealthy.
    expect(desktopBadgeKey({ owned: true, running: false, loginEnabled: false, viable: false }, false)).toBe("startup.unhealthy");
    expect(desktopBadgeKey({ owned: true, running: false, loginEnabled: true, viable: false }, false)).toBe("startup.unhealthy");
    expect(desktopBadgeKey({ owned: false, ...loginOff }, false)).toBe("startup.unhealthy");
    expect(desktopBadgeKey({ owned: false, supervisor, running: true, loginEnabled: true, viable: true }, false)).toBe("startup.viable");
  });

  test("custom-local guidance takes precedence over stale owned or supervised desktop guidance", () => {
    const base = { routingKind: "custom-local", shimCoverage: "none" } as const;
    const supervisor = { supervisorPid: 123, runtimePid: 456, app: "/Applications/OpenCodex.app" };
    for (const diagnosticStale of [false, true]) {
      expect(startupRiskDetailKey({ ...base, diagnosticStale, desktop: { owned: false, supervisor } }))
        .toBe("startup.riskDetailCustomLocal");
      expect(startupRiskDetailKey({ ...base, diagnosticStale, desktop: { owned: true } }))
        .toBe("startup.riskDetailCustomLocal");
    }
    expect(startupRiskDetailKey(base)).toBe("startup.riskDetailCustomLocal");
  });

  test("desktop guidance only applies to opencodex-local routing", () => {
    const supervisor = { supervisorPid: 123, runtimePid: 456, app: "/Applications/OpenCodex.app" };
    for (const desktop of [{ owned: true }, { owned: false, supervisor }]) {
      expect(startupRiskDetailKey({ routingKind: "opencodex-local", shimCoverage: "none", diagnosticStale: true, desktop }))
        .toBe("startup.desktopReopenRecovery");
      for (const routingKind of ["native", "custom-remote", "unknown"] as const) {
        for (const diagnosticStale of [false, true]) {
          expect(startupRiskDetailKey({ routingKind, shimCoverage: "none", diagnosticStale, desktop }))
            .toBe("startup.riskDetail");
          expect(startupRiskDetailKey({ routingKind, shimCoverage: "cli-only", diagnosticStale, desktop }))
            .toBe("startup.riskDetailWindowsShim");
        }
      }
    }
  });

  test("startup hero localizes desktop guidance and never displays the server action", () => {
    const data: StartupHealthData = {
      status: "at-risk", routingKind: "opencodex-local", routingInjected: true,
      localRoutingDependency: true, autostartEnabled: true, rebootSafe: false, protection: "none",
      serviceInstalled: false, serviceViable: false, serviceEnabled: false, serviceRunning: false,
      serviceStale: false, serviceConflict: false, serviceSupported: true,
      shimInstalled: false, shimHealthy: false, shimCoverage: "none", platform: "darwin",
      recommendedCommand: null, recommendedAction: "Server English guidance must not reach the GUI",
      diagnosticStale: false,
      desktop: { owned: false, loginEnabled: false, running: true, viable: false,
        supervisor: { supervisorPid: 123, runtimePid: 456, app: "/Applications/OpenCodex.app" } },
      commands: { installService: "ocx service install", repairService: "ocx service repair",
        installShim: "ocx codex-shim install", restoreNative: "ocx restore" },
    };
    for (const locale of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
      const t: TFn = key => DICTS[locale][key];
      for (const diagnosticStale of [false, true]) {
        const markup = renderToStaticMarkup(createElement(I18nContext.Provider,
          { value: { locale, setLocale: () => {}, t } },
          createElement(StartupHeroSection, { failed: false, data: { ...data, diagnosticStale } })));
        const guidance = "startup.loginUnverifiedAction";
        const localized = t(guidance);
        expect(typeof localized).toBe("string");
        // The guidance is the hero's own paragraph, whatever classes the paragraph carries.
        const escaped = renderToStaticMarkup(createElement("p", null, localized)).slice("<p>".length, -"</p>".length);
        expect(markup).toMatch(new RegExp(`<p[^>]*>${escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`));
        expect(markup).not.toContain(data.recommendedAction!);
      }
    }
  });

  test("custom local routing retains its own guidance when Desktop owns the proxy", () => {
    const data = { status: "at-risk", routingKind: "custom-local", desktop: { owned: true, running: true, viable: false },
      protection: "none", shimCoverage: "none", autostartEnabled: false } as StartupHealthData;
    const t: TFn = key => DICTS.en[key];
    for (const Hero of [StartupHeroSection]) {
      const markup = renderToStaticMarkup(createElement(I18nContext.Provider,
        { value: { locale: "en", setLocale: () => {}, t } }, createElement(Hero, { failed: false, data })));
      expect(markup).toContain("Codex points to a custom local gateway.");
      expect(markup).not.toContain(DICTS.en["startup.loginUnverifiedAction"]);
    }
  });

  test("rejects stale or mutation-racing settings polls", () => {
    const started = { request: 4, mutation: 2 };
    expect(settingsPollMayCommit(started, { request: 4, mutation: 2, mutationInFlight: false })).toBe(true);
    expect(settingsPollMayCommit(started, { request: 5, mutation: 2, mutationInFlight: false })).toBe(false);
    expect(settingsPollMayCommit(started, { request: 4, mutation: 3, mutationInFlight: false })).toBe(false);
    expect(settingsPollMayCommit(started, { request: 4, mutation: 2, mutationInFlight: true })).toBe(false);
  });

  test("keeps payload status when diagnostics are stale and rejects invalid payloads", () => {
    // diagnosticStale is SWR refresh, not a hard read failure — do not map to "error".
    expect(mapStartupHealthProbe({ status: "protected", diagnosticStale: true })).toBe("protected");
    expect(mapStartupHealthProbe({ status: "at-risk", diagnosticStale: true })).toBe("at-risk");
    expect(mapStartupHealthProbe({ status: "native", diagnosticStale: false })).toBe("native");
    expect(mapStartupHealthProbe({ status: "nope" })).toBeNull();
  });

  test("settings may seed while unknown or hard-error, but not overwrite a real status", () => {
    expect(seedStartupHealthFromSettings(null, { status: "protected", diagnosticStale: false })).toBe("protected");
    expect(seedStartupHealthFromSettings("error", { status: "protected", diagnosticStale: false })).toBe("protected");
    // A stale seed is a server-side placeholder and must not color the chip.
    expect(seedStartupHealthFromSettings(null, { status: "at-risk", diagnosticStale: true })).toBeNull();
    expect(seedStartupHealthFromSettings("error", { status: "at-risk", diagnosticStale: true })).toBe("error");
    expect(seedStartupHealthFromSettings("at-risk", { status: "protected", diagnosticStale: false })).toBe("at-risk");
  });
});

describe("stale startup-health fast retry", () => {
  // The chip used to sit on the server's conservative placeholder until the next 30s
  // poll, which is why it only appeared to sync when the user clicked something.
  test("a stale answer asks for a fast re-check", () => {
    expect(probeNeedsFastRetry({ status: "at-risk", stale: true })).toBe(true);
    expect(probeNeedsFastRetry({ status: "protected", stale: true })).toBe(true);
    expect(probeNeedsFastRetry({ status: "native", stale: true })).toBe(true);
  });

  test("a settled answer does not", () => {
    expect(probeNeedsFastRetry({ status: "protected", stale: false })).toBe(false);
    expect(probeNeedsFastRetry({ status: "at-risk", stale: false })).toBe(false);
  });

  test("a hard error is left to the ordinary poll", () => {
    // A read failure will not resolve itself in two seconds; retrying fast would just
    // hammer a down endpoint.
    expect(probeNeedsFastRetry({ status: "error", stale: true })).toBe(false);
    expect(probeNeedsFastRetry({ status: "error", stale: false })).toBe(false);
  });

  test("no snapshot yet is not a retry trigger", () => {
    expect(probeNeedsFastRetry(undefined)).toBe(false);
    expect(probeNeedsFastRetry(null)).toBe(false);
  });
});

describe("dashboard poll epochs", () => {
  test("captures and bumps request epochs before fetches", () => {
    const refs = {
      settingsRequest: { current: 0 },
      settingsMutation: { current: 2 },
      shadowRequest: { current: 0 },
      shadowMutation: { current: 4 },
    };
    const first = beginPollEpochs(refs);
    const second = beginPollEpochs(refs);
    expect(first.settings).toEqual({ request: 1, mutation: 2 });
    expect(second.settings).toEqual({ request: 2, mutation: 2 });
    expect(first.shadow).toEqual({ request: 1, mutation: 4 });
    expect(second.shadow.request).toBe(2);
  });

  test("stale poll after successful mutation cannot commit", () => {
    const started = beginPollEpochs({
      settingsRequest: { current: 3 },
      settingsMutation: { current: 1 },
      shadowRequest: { current: 3 },
      shadowMutation: { current: 1 },
    });
    expect(settingsPollMayCommit(started.settings, {
      request: started.settings.request,
      mutation: 2,
      mutationInFlight: false,
    })).toBe(false);
    expect(settingsPollMayCommit(started.shadow, {
      request: started.shadow.request,
      mutation: 2,
      mutationInFlight: false,
    })).toBe(false);
  });

  test("overlapping polls resolving out of order keep only the latest request identity", () => {
    const refs = {
      settingsRequest: { current: 0 },
      settingsMutation: { current: 0 },
      shadowRequest: { current: 0 },
      shadowMutation: { current: 0 },
    };
    const older = beginPollEpochs(refs);
    const newer = beginPollEpochs(refs);
    expect(settingsPollMayCommit(older.settings, {
      request: refs.settingsRequest.current,
      mutation: 0,
      mutationInFlight: false,
    })).toBe(false);
    expect(settingsPollMayCommit(newer.settings, {
      request: refs.settingsRequest.current,
      mutation: 0,
      mutationInFlight: false,
    })).toBe(true);
  });

  test("project-config diagnostics uses a single 30s owner cadence", () => {
    expect(PROJECT_CONFIG_DIAGNOSTICS_POLL_MS).toBe(30_000);
  });
});
