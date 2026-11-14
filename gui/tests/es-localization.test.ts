import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { en, type TKey } from "../src/i18n/en";
import { es } from "../src/i18n/es";
import { DICTS, LOCALES, detectInitial, interpolate } from "../src/i18n/shared";
import { NATIVE_MAIN_EN, NATIVE_MAIN_TRANSLATIONS } from "../src/i18n/native-main-translations";
import { labSupplement } from "../src/i18n/lab-translations";
import { logGuardLabel } from "../src/i18n/log-guard-labels";
import { logGuardOperationLabel } from "../src/i18n/log-guard-operation-labels";
import { ROUTING_COMPATIBILITY_FIELD_LABELS } from "../src/i18n/routing-compatibility-labels";
import { visionReasoningLabel } from "../src/i18n/vision-reasoning-labels";
import { formatResetFuture } from "../src/components/QuotaBars";
import { statusCodeInfo } from "../src/status-codes";

const placeholders = (value: string): string[] => [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
  .map(match => match[1]!).sort();

function numericResidue(english: string, spanish: string): [string[], string[]] {
  const tokens = (value: string): string[] => value.match(/\d+(?:[.,]\d+)*/g) ?? [];
  const translated = tokens(spanish);
  // Retain literal versions, protocol IDs and code samples before interpreting locale separators.
  const missing = tokens(english).filter(token => {
    const index = translated.indexOf(token);
    if (index < 0) return true;
    translated.splice(index, 1);
    return false;
  });
  return [missing.map(value => value.replaceAll(",", "")).sort(), translated.map(value =>
    /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(value)
      ? value.replaceAll(".", "").replace(",", ".") : value.replace(",", ".")).sort()];
}

const machineIdentifiers = /--[a-z][a-z0-9-]*|\/api\/[a-zA-Z0-9_/:.{}-]+|\b[a-z][a-z0-9-]*\/<[a-zA-Z][a-zA-Z0-9_-]*>|\b[a-z][a-z0-9-]*-\*|\b[a-z]+(?:_[a-z]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\bcodex-auth export\b|__main__|\[[a-z][a-z0-9_.-]*\]/g;
const machineTokens = (value: string): Set<string> => new Set((value.match(machineIdentifiers) ?? [])
  .map(token => token.replace(/\.+$/, "")));

// Reviewed identical spellings: Spanish cognates, brands, protocol/strategy names,
// wire identifiers and compact units. New English prose does not enter this list automatically.
const identicalValues = new Set([
  "Error", "Total", "Normal", "Original", "Local", "General", "Alias", "Ultra", "Zoom", "no", "No", "auto", "Manual",
  "Manual: {mode}", "{active}/{total} visible", " · local", "arena {total}",
  "Pool", "Direct", "Home", "Child", "Hub", "Proxy", "Backend", "Combos", "Combo", "Round-robin", "Suite", "Fallback",
  "Anthropic", "Anthropic · Pool 2", "OpenAI", "Claude", "Codex", "GitHub", "Google", "Grok", "Grok Build",
  "Claude Code", "Claude Desktop", "Kiro CLI", "Builder ID", "Cursor", "OpenCode", "Pi", "OMP", "Hermes", "OpenClaw",
  "gjc", "DSH", "DeepSeek Harness (DSH)", "ZCode", "Aside", "Raycast", "omo", "Qoder", "Cline CLI", "Kilo",
  "Factory Droid", "GentleShell", "Kimi CLI", "MCode", "Prime CLI", "Codex CLI", "TypeSafe",
  "Gentle Shell", "Kimi Code", "MiniMax Code", "Command Code", "Prime Agent", "Command Code - Auth",
  "OrcaRouter - API", "OrcaRouter - Auth", "Volcengine Ark", "Volcengine Ark Coding Plan", "Volcengine Ark Agent Plan",
  "Command Code - OAuth", "Command Code - API", "Windows PowerShell", "macOS", "Windows", "Linux",
  "AWS IAM Identity Center", "npm (global)", "Qoder CN", "WorkBuddy (CN)", "WorkBuddy AI", "T3 Code", "GOAT",
  "Responses", "Messages", "Chat Completions", "Responses API", "Messages API", "Chat Completions API",
  "CODEX_HOME", "AGENTS.md", "ArrayBuffers", "OAuth", "API", "IR", "ID", "TTFT", "JEV", "RPM", "rev",
  "v1", "v2", "base", "200k", "1M", "claude-sonnet-4-6", "OK", "https://...",
  "codex-work, codex-alt, team...",
  "Opus", "Fable", "Haiku", "Sonnet",
  "Tokens", "tokens", "Tokens (30d)", "{tokens} tokens", "{bytes} bytes", "I · {model}",
  "{count} req / {errors} err", "Req.", "tok/s", "≥ 50 tok/s", "p50", "p95", "p99",
  "d", "h", "m", "s", "/h", "5h", "6h", "24h", "3d", "7d", "30d", "{n}m", "{n}h", "{n}d", "A–Z", "Z–A",
]);

describe("Spanish localization contract", () => {
  test("base and effective catalogs are complete, nonempty, and preserve placeholder multiplicity", () => {
    expect(LOCALES.find(locale => locale.code === "es")).toEqual({ code: "es", htmlLang: "es" });
    expect(es["lang.nativeName"]).toBe("Español");
    expect(DICTS.es["shellV2.navHome"]).toBe("Inicio");
    expect(DICTS.es["nav.startup"]).toBe("Arranque");
    for (const catalog of [es, DICTS.es]) {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en) as TKey[]) {
        expect(catalog[key].trim(), key).not.toBe("");
        expect(placeholders(catalog[key]), key).toEqual(placeholders(en[key]));
        expect(catalog[key], key).not.toMatch(/ZXQ\d|QXZ|\u2047|\uFFFD/);
        expect(catalog[key], key).not.toMatch(/tarifa limitada|teclas (?:API|activas)|rotación de teclas|discapacitad|\bAmable\b|escritorio Claude|Claude escritorio/i);
      }
    }
    for (const key of Object.keys(NATIVE_MAIN_EN) as (keyof typeof NATIVE_MAIN_EN)[]) {
      expect(placeholders(NATIVE_MAIN_TRANSLATIONS.es[key]), key).toEqual(placeholders(NATIVE_MAIN_EN[key]));
    }
  });

  test("does not ship untranslated English prose in either catalog", () => {
    for (const catalog of [es, DICTS.es]) {
      const accidental = (Object.keys(en) as TKey[]).filter(key => catalog[key] === en[key]
        && /\p{L}/u.test(en[key].replace(/\{[^}]+\}/g, "")) && !identicalValues.has(en[key]));
      expect(accidental).toEqual([]);
    }
  });

  test("keeps CLI commands, API routes and environment names executable", () => {
    const identifiers = /\bocx (?:start|ensure|tray|claude|opencode|doctor|sync|link|update)\b|(?<![a-zA-Z])\/(?:v1\/(?:models|chat\/completions|responses|messages)|compact|model)\b|\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/g;
    for (const catalog of [es, DICTS.es]) {
      for (const key of Object.keys(en) as TKey[]) {
        for (const token of en[key].match(identifiers) ?? []) {
          expect(catalog[key], `${key}: ${token}`).toContain(token);
        }
      }
    }
  });

  test("preserves numeric contracts, protocol versions and machine identifiers", () => {
    for (const catalog of [es, DICTS.es]) {
      for (const key of Object.keys(en) as TKey[]) {
        const [canonical, translated] = numericResidue(en[key], catalog[key]);
        expect(translated, `${key}: numeric values and versions`).toEqual(canonical);
        const actual = machineTokens(catalog[key]);
        expect([...machineTokens(en[key])].filter(token => !actual.has(token)), `${key}: machine identifiers`).toEqual([]);
      }
    }
  });

  test("browser regions, persisted preference and blocked storage agree before and after mount", async () => {
    const guards = await Promise.all(["../index.html", "../classic/index.html"].map(async path => {
      const html = await Bun.file(new URL(path, import.meta.url)).text();
      const guard = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      if (!guard) throw new Error("Missing language bootstrap in " + path);
      return guard;
    }));
    const prior = ["navigator", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    try {
      for (const language of ["es", "es-BO", "es-MX", "es-ES", "es-419", "ES-ar"]) {
        for (const stored of [null, "invalid", "es-MX", "es", "en"]) {
          for (const blocked of [false, true]) {
            const localStorage = { getItem: (key: string): string | null => {
              if (blocked) throw new Error("storage blocked");
              return key === "ocx-lang" ? stored : null;
            } };
            const navigator = { language };
            Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
            Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
            const expected = stored === "en" && !blocked ? "en" : "es";
            expect(detectInitial()).toBe(expected);
            for (const guard of guards) {
              const document = { documentElement: { lang: "en", setAttribute: () => {}, removeAttribute: () => {} } };
              runInNewContext(guard, { localStorage, navigator, document });
              expect(document.documentElement.lang).toBe(expected);
            }
          }
        }
      }
    } finally {
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test("auxiliary surfaces retain their localized meaning", () => {
    expect(DICTS.es["lab.title"]).toBe("Laboratorio de compatibilidad");
    expect(labSupplement("es", "selectVerdict", { subject: "probe-a" })).toContain("probe-a");
    expect(labSupplement("es", "artifact.corrupt")).toBe("Corrupto");
    expect(labSupplement("es", "community.notLocalVerdict")).toContain("local");
    expect(logGuardLabel("es", "cancel")).toBe("Cancelar");
    expect(logGuardLabel("es", "compact")).toBe("Compactar");
    expect(logGuardLabel("es", "repair")).toBe("Reparar protección");
    expect(DICTS.es["lab.subjectKind"]).toBe("Tipo");
    expect(DICTS.es["lab.col.subject"]).toBe("Sujeto");
    expect(DICTS.es["lab.verdict.CLAIMED"]).toBe("Declarado");
    expect(DICTS.es["lab.verdict.DEGRADED"]).toBe("Degradado");
    expect(logGuardOperationLabel("es", "error.generic")).not.toBe(logGuardOperationLabel("en", "error.generic"));
    expect(visionReasoningLabel("es", "xhigh")).toBe("Muy alto");
    expect(ROUTING_COMPATIBILITY_FIELD_LABELS.es.unknownEvidence).toBe("Evidencia desconocida");
    expect(NATIVE_MAIN_TRANSLATIONS.es["nativeMain.recoveryHint"]).toContain("confirm");
    expect(DICTS.es["pws.completion.confirm"]).toContain("32 tokens");
    expect(DICTS.es["integrations.lazycodexRoles.omoComments"]).toContain("[codex].agents.{role}");
  });

  test("specific and generic HTTP errors recognize Spanish regional variants", () => {
    expect(statusCodeInfo(200, "es")).toBeNull();
    for (const locale of ["es", "es-BO", "es-MX", "es-ES", "ES-ar"]) {
      expect(statusCodeInfo(401, locale)?.label).toBe("Sin autorización");
      expect(statusCodeInfo(404, locale)?.label).toBe("No encontrado");
      expect(statusCodeInfo(408, locale)?.label).toBe("Tiempo de espera de la solicitud agotado");
      expect(statusCodeInfo(429, locale)?.label).toBe("Límite de solicitudes alcanzado");
      expect(statusCodeInfo(418, locale)?.label).toBe("Error en la solicitud");
      expect(statusCodeInfo(599, locale)?.label).toBe("Error del servidor o del proveedor de origen");
    }
  });

  test("quota reset times use Spanish regional formatting", () => {
    const date = new Date("2026-12-20T12:34:00Z");
    const keys: string[] = [];
    // Ten days apart forces the dated branch across time zones.
    const formatted = formatResetFuture(date.getTime(), (key, vars) => {
      keys.push(key);
      return interpolate(es[key], vars);
    }, "es", Date.UTC(2026, 11, 10, 0));
    expect(keys).toEqual(["quota.resetsAt"]);
    expect(formatted).not.toBe("");
    expect(formatted).toMatch(/\b(?:20|21)\s+dic\b/i);
    expect(formatted).toMatch(/\d{2}:\d{2}/);
  });
});
