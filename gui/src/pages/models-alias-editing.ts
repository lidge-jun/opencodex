import type { TFn } from "../i18n/shared";
import { requestTextValue } from "../action-dialogs";

/**
 * Alias editing for the models page, extracted so Models.tsx can host the in-page dialog
 * without growing: that file sits on its recorded line cap, and the cap only ever moves
 * down (tests/fixtures/file-size-baseline.json).
 *
 * Both editors used to open `window.prompt()`, which the app's webview cannot draw at all —
 * wry implements no text input panel — so inside the app these two pencil buttons could
 * not be used. See devlog/_plan/260921_app_runtime_ownership/050_webview_dialogs.md.
 */
export interface AliasEditingDeps {
  apiBase: string;
  t: TFn;
  /** Re-reads /api/aliases so the row shows what the server now holds. */
  reloadAliases: () => Promise<void>;
  publishFeedback: (ok: boolean, message: string) => void;
}

/** Renames a provider. An empty value clears the alias, as the field label says. */
export async function editProviderAlias(
  provider: string,
  current: string,
  { apiBase, t, reloadAliases, publishFeedback }: AliasEditingDeps,
): Promise<void> {
  const entered = await requestTextValue({ message: t("models.aliasPrompt"), initialValue: current });
  // Dismissal is not an empty alias: a cancelled edit must write nothing.
  if (entered === null) return;
  const response = await fetch(`${apiBase}/api/providers/${encodeURIComponent(provider)}/alias`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: entered.trim() || null }),
  });
  if (!response.ok) { publishFeedback(false, t("models.aliasConflict")); return; }
  await reloadAliases();
  publishFeedback(true, t("models.aliasSaved"));
}

/** Renames one model within a provider. An empty value removes the alias. */
export async function editModelAlias(
  provider: string,
  model: string,
  current: string,
  { apiBase, t, reloadAliases, publishFeedback }: AliasEditingDeps,
): Promise<void> {
  const entered = await requestTextValue({ message: t("models.modelAliasPrompt"), initialValue: current });
  if (entered === null) return;
  const body = entered.trim() ? { set: { [model]: entered.trim() } } : { remove: [model] };
  const response = await fetch(`${apiBase}/api/providers/${encodeURIComponent(provider)}/model-aliases`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) { publishFeedback(false, t("models.aliasConflict")); return; }
  await reloadAliases();
  publishFeedback(true, t("models.aliasSaved"));
}
