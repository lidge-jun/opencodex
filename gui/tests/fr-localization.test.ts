import { describe, expect, test } from "bun:test";
import { formatResetFuture } from "../src/components/QuotaBars";
import { formatUptime } from "../src/formatUptime";
import type { TKey } from "../src/i18n";
import { DICTS, LOCALES } from "../src/i18n/shared";
import { labSupplement } from "../src/i18n/lab-translations";
import { ROUTING_COMPATIBILITY_FIELD_LABELS } from "../src/i18n/routing-compatibility-labels";
import { visionReasoningLabel } from "../src/i18n/vision-reasoning-labels";
import { formatCreditDate, formatCreditDateTime } from "../src/intl-formatters";
import { formatCreatedDate } from "../src/pages/api-keys-utils";
import { statusCodeInfo } from "../src/status-codes";

const FR_CATALOG_URL = new URL("../src/i18n/fr.ts", import.meta.url);
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

const INTENTIONAL_ENGLISH = new Set<TKey>([
  // Units, symbols, protocol values, machine labels, and product names.
  "uptime.hour",
  "uptime.second",
  "common.github",
  "common.ok",
  "nav.api",
  "nav.grok",
  "grok.title",
  "claude.pageTitle",
  "claude.tabCode",
  "claude.tabDesktop",
  "claudeDesktop.title",
  "dash.backendAnthropic",
  "dash.backendOpenAI",
  "api.protocolResponses",
  "api.protocolChatCompletions",
  "api.protocolMessages",
  "provider.name.commandCodeAuth",
  "provider.name.commandCodeApi",
  "provider.name.volcengine",
  "provider.name.volcengineCodingPlan",
  "provider.name.volcengineAgentPlan",
  "routing.unavailable",
  "routing.analyticsP50",
  "routing.analyticsP95",
  "routing.analyticsP99",
  "dash.mem.arrayBuffers",
  "dash.mem.perHour",
  "dash.shadowCallOriginal",
  "dash.backendAuto",
  "dash.updateVersionTransition",
  "prov.accountId",
  "models.shadowCallOriginal",
  "models.v2Mode_v1",
  "models.v2Mode_default",
  "models.v2Mode_v2",
  "logs.filter.surface.claude",
  "logs.filter.surface.codex",
  "logs.filter.surface.grok",
  "logs.badge.claude",
  "logs.badge.grok",
  "logs.col.estimatedCost",
  "logs.detail.ttft",
  "storage.card.home",
  "storage.cleanup.preset",
  "modal.badge.oauth",
  "modal.accountsCodexAuthLink",
  "modal.apiKeyTransportBearer",
  "modal.baseUrlPlaceholder",
  "integrations.tab.codex",
  "integrations.tab.claude",
  "integrations.tab.grok",
  "integrations.tab.opencode",
  "integrations.tab.pi",
  "integrations.tab.omp",
  "integrations.tab.hermes",
  "integrations.tab.openclaw",
  "integrations.tab.kimi",
  "integrations.tab.gajae",
  "integrations.tab.dsh",
  "integrations.codex.title",
  "codexAuth.addIdPlaceholder",
  "api.clientConfig.clientOpencode",
  "api.clientConfig.clientPi",
  "api.clientConfig.clientOmp",
  "api.clientConfig.clientHermes",
  "api.clientConfig.clientOpenclaw",
  "api.clientConfig.clientKimi",
  "api.clientConfig.clientGajae",
  "api.clientConfig.clientDsh",
  "claudeDesktop.family.opus",
  "claudeDesktop.family.fable",
  "claudeDesktop.family.sonnet",
  "claudeDesktop.family.haiku",
  "claudeDesktop.supports1m",
  "claudeDesktop.effort.supported",
  // Correct French words whose spelling is identical to English.
  "routing.exclusions",
  "routing.score",
  "dash.workspace.sections",
  "dash.version",
  "dash.mem.storeTotal",
  "dash.maintenance",
  "prov.port",
  "prov.openaiModeDirect",
  "logs.filter.conversation.label",
  "logs.detail.conversation",
  "debug.streamInjection",
  "storage.trash.col.mode",
  "modal.badge.local",
  "modal.badge.direct",
  "pws.rail.suffixLocal",
  "pws.filterType",
  "pws.type.cloud",
  "pws.type.local",
  "pws.sort.az",
  "pws.sort.za",
  "pws.cell.note",
  "pws.stats.source",
  "pws.col.requests",
  "pws.note",
  "pws.notes",
  "accountPool.strategyQuota",
  "accountPool.priorityNormal",
  "accountPool.priorityOption",
  "api.colSource",
  "api.testSucceeded",
  "cws.count.total",
  "claudeDesktop.alias",
  "lab.filter.verdict",
  "lab.col.suite",
  "lab.col.verdict",
  "lab.observationCount",
  "lab.verdictCount",
  "lab.detailObservations",
]);

function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_RE)].map(match => match[1]!).sort();
}

describe("French base catalog", () => {
  test("ships one non-empty value for every English key and preserves placeholders", async () => {
    expect(await Bun.file(FR_CATALOG_URL).exists()).toBe(true);
    if (!(await Bun.file(FR_CATALOG_URL).exists())) return;

    const french = (await import("../src/i18n/fr")).fr;
    const english = DICTS.en;

    expect(Object.keys(french).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english) as TKey[]) {
      expect(french[key].trim().length, key).toBeGreaterThan(0);
      expect(placeholders(french[key]), key).toEqual(placeholders(english[key]));
    }
  });

  test("does not ship accidental English values", async () => {
    expect(await Bun.file(FR_CATALOG_URL).exists()).toBe(true);
    if (!(await Bun.file(FR_CATALOG_URL).exists())) return;

    const french = (await import("../src/i18n/fr")).fr;
    const accidental = (Object.keys(DICTS.en) as TKey[]).filter(key =>
      french[key] === DICTS.en[key] && !INTENTIONAL_ENGLISH.has(key)
    );

    expect(accidental).toEqual([]);
  });

  test("registers Français with the French HTML language tag", () => {
    const frenchLocale = LOCALES.find(locale => locale.code === ("fr" as never));
    expect(frenchLocale).toEqual({ code: "fr", htmlLang: "fr" });
    expect((DICTS as Record<string, Record<TKey, string>>).fr?.["lang.nativeName"]).toBe("Français");
  });
});

describe("French auxiliary localization surfaces", () => {
  test("localizes Lab copy and supplements", () => {
    const french = (DICTS as Record<string, Record<TKey, string>>).fr;
    expect(french?.["lab.title"]).toBe("Laboratoire de compatibilité");
    expect(labSupplement("fr" as never, "artifact.present")).toBe("Présent");
    expect(labSupplement("fr" as never, "selectVerdict", { subject: "sujet-a" })).toContain("sujet-a");
  });

  test("localizes specific and generic HTTP errors", () => {
    expect(statusCodeInfo(401, "fr")).toEqual({
      label: "Non autorisé",
      description: expect.stringContaining("identifiants"),
    });
    expect(statusCodeInfo(418, "fr")?.label).toBe("Erreur de requête");
    expect(statusCodeInfo(599, "fr")?.label).toBe("Erreur du serveur ou du fournisseur en amont");
    expect(statusCodeInfo(401, "fr-CA")?.label).toBe("Non autorisé");
  });

  test("localizes reasoning and routing compatibility labels", () => {
    expect(visionReasoningLabel("fr" as never, "xhigh")).toBe("Très élevé");
    expect((ROUTING_COMPATIBILITY_FIELD_LABELS as Record<string, {
      maxEvidenceAgeMs: string;
      unknownEvidence: string;
      degradedEvidence: string;
    }>).fr).toEqual({
      maxEvidenceAgeMs: "Âge maximal des preuves (ms)",
      unknownEvidence: "Preuves inconnues",
      degradedEvidence: "Preuves dégradées",
    });
  });

  test("uses French date, time, and duration formatting", () => {
    const iso = "2026-07-31T12:34:56Z";
    const date = new Date(iso);
    const expectedDate = new Intl.DateTimeFormat("fr-FR", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
    const expectedDateTime = new Intl.DateTimeFormat("fr-FR", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);

    expect(formatCreditDate(iso, "fr-FR")).toBe(expectedDate);
    expect(formatCreditDateTime(iso, "fr-FR")).toBe(expectedDateTime);
    expect(formatCreatedDate(iso, "fr-FR")).toBe(date.toLocaleDateString("fr-FR"));
    expect(formatUptime(90060, "fr" as never)).toBe("1j 1h");

    const french = (DICTS as Record<string, Record<TKey, string>>).fr;
    const t = (key: TKey, vars?: Record<string, string | number>) => {
      let value = french[key];
      for (const [name, replacement] of Object.entries(vars ?? {})) {
        value = value.replaceAll(`{${name}}`, String(replacement));
      }
      return value;
    };
    expect(formatResetFuture(
      Date.UTC(2026, 6, 31, 12, 34),
      t,
      "fr" as never,
      Date.UTC(2026, 6, 31, 10, 34),
    )).toBe("Réinitialisation dans 2 h");
  });
});
