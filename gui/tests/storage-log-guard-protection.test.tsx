import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import StorageWorkspace, { type StorageReport } from "../src/components/storage-workspace/StorageWorkspace";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS, I18nContext, interpolate, type TFn } from "../src/i18n/shared";

function report(state: "off" | "active" | "drifted" = "active"): StorageReport {
  const desiredMode = state === "off" ? "off" : "compat";
  const observedMode = state === "active" ? "compat" : "off";
  return {
    codexHome: "/home/user/.codex",
    generatedAt: 1,
    total: { bytes: 1024, fileCount: 1 },
    buckets: [],
    codexLogs: {
      generatedAt: 1,
      externalSqliteHome: false,
      snapshot: "checkpointed",
      files: { databaseBytes: 8192, walBytes: 0, shmBytes: 0 },
      schema: { state: "compatible" },
      capabilities: {
        inspection: { state: "supported" },
        protection: { state: "supported" },
        reclaim: { state: "supported" },
      },
      protection: { desiredMode, observedMode, state },
      metrics: null,
    },
  } satisfies StorageReport;
}

function render(value: StorageReport): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <StorageWorkspace
        report={value}
        locale="en"
        logGuardBusy={false}
        onLogGuardAction={() => {}}
      />
    </LanguageProvider>,
  );
}

function germanT(): TFn {
  return (key, vars) => interpolate(DICTS.de[key] ?? DICTS.en[key] ?? key, vars);
}

test("Storage exposes compatibility, quiet, and disable protection controls", () => {
  const html = render(report("active"));
  expect(html).toContain('data-testid="log-guard-protection"');
  expect(html).toContain("Protection");
  expect(html).toContain("Compatibility");
  expect(html).toContain("Quiet");
  expect(html).toContain("Disable protection");
  expect(html).toContain("Active");
  expect(html).not.toContain(">active<");
  expect(html).not.toContain("Compact");
});

test("Storage exposes explicit repair only when protection drifted", () => {
  const html = render(report("drifted"));
  expect(html).toContain("Needs repair");
  expect(html).not.toContain(">drifted<");
  expect(html).toContain("Repair protection");
});

test("Storage localizes protection state and desired/observed modes", () => {
  const html = renderToStaticMarkup(
    <I18nContext.Provider value={{ locale: "de", setLocale: () => {}, t: germanT() }}>
      <StorageWorkspace
        report={report("drifted")}
        locale="de"
        logGuardBusy={false}
        onLogGuardAction={() => {}}
      />
    </I18nContext.Provider>,
  );

  expect(html).toContain("Reparatur erforderlich");
  expect(html).toContain("Kompatibilität");
  expect(html).toContain("Aus");
  expect(html).not.toContain(">drifted<");
  expect(html).not.toContain(">compat<");
});

test("Storage disables protection mutation controls for an unsupported schema", () => {
  const value = report("off");
  value.codexLogs = {
    ...value.codexLogs!,
    schema: { state: "unsupported", reason: "unknown_schema" },
    capabilities: {
      inspection: { state: "supported" },
      protection: { state: "unsupported", reason: "unknown_schema" },
      reclaim: { state: "unsupported", reason: "unknown_schema" },
    },
  };
  const html = render(value);
  expect(html).toMatch(/data-testid="log-guard-protect-compat"[^>]*disabled/);
  expect(html).toMatch(/data-testid="log-guard-protect-quiet"[^>]*disabled/);
  expect(html).not.toContain("Compact");
});
