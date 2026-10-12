import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../src/i18n/en";
import { I18nContext, interpolate, type TFn } from "../src/i18n/shared";
import { ModelCatalogDelivery } from "../src/pages/models-catalog-state";

const t: TFn = (key, vars) => interpolate(en[key], vars);

function render(props: { connected: boolean; catalogSyncedAt?: string }): string {
  return renderToStaticMarkup(createElement(
    I18nContext.Provider,
    { value: { locale: "en", setLocale: () => {}, t } },
    createElement(ModelCatalogDelivery, props),
  ));
}

function steps(html: string): string[] {
  return [...html.matchAll(/data-step="([a-z]+)"/g)].map(match => match[1]!);
}

test("standalone installs show two steps, folded closed, with no hub sync step", () => {
  const html = render({ connected: false, catalogSyncedAt: "2026-09-23T01:00:00.000Z" });
  expect(html.match(/^<details[^>]*>/)?.[0]).toBe('<details class="models-delivery">');
  expect(steps(html)).toEqual(["saved", "loaded"]);
  expect(html).toContain(en["models.delivery.chip.saved"]);
  expect(html).not.toContain(en["models.delivery.savedHub.title"]);
  expect(html).not.toContain(en["models.delivery.synced.title"]);
});

test("ocx connect clients add the hub sync step with its recorded time", () => {
  const html = render({ connected: true, catalogSyncedAt: "2026-09-23T01:00:00.000Z" });
  expect(steps(html)).toEqual(["saved", "synced", "loaded"]);
  expect(html).toContain(en["models.delivery.chip.savedHub"]);
  expect(html).toContain("Synced ");
  expect(html).toContain("This machine last downloaded the hub catalog on ");
  expect(html).not.toContain(en["models.delivery.chip.syncedUnknown"]);
});

test("a client without a usable sync time says so instead of inventing one", () => {
  for (const catalogSyncedAt of [undefined, "not-a-date"]) {
    const html = render({ connected: true, catalogSyncedAt });
    expect(steps(html)).toEqual(["saved", "synced", "loaded"]);
    expect(html).toContain(en["models.delivery.chip.syncedUnknown"]);
    expect(html).toContain(en["models.delivery.synced.bodyUnknown"]);
    expect(html).not.toContain("{time}");
  }
});
