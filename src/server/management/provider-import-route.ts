import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { parseAndNormalizeProviderJson } from "../../providers/json-import";
import { hasOwnProvider, isValidProviderName } from "../../config";
import { saveConfigPreservingClaudeCode } from "../../config";
import { importCodexAccounts } from "../../codex/bulk-import";

export async function handleProviderImportRoute(ctx: ManagementContext): Promise<Response> {
  const { req, config, convergeCodexCatalog } = ctx;

  let body: unknown;
  try {
    body = await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const rawInput = body && typeof body === "object" && "json" in body
    ? (body as Record<string, unknown>).json
    : body;

  const overwrite = Boolean(body && typeof body === "object" && (body as Record<string, unknown>).overwrite);

  try {
    const result = parseAndNormalizeProviderJson(rawInput);
    const added: string[] = [];
    const skipped: string[] = [];

    for (const [name, provConfig] of Object.entries(result.providers)) {
      if (!isValidProviderName(name)) continue;
      if (hasOwnProvider(config.providers, name) && !overwrite) {
        skipped.push(name);
        continue;
      }
      config.providers[name] = provConfig;
      added.push(name);
    }

    let codexImportedCount = 0;
    let codexImportedIds: string[] = [];
    if (result.codexAccounts.length > 0) {
      const codexResult = await importCodexAccounts(result.codexAccounts, { config, overwrite });
      codexImportedCount = codexResult.imported.length;
      codexImportedIds = codexResult.imported;
      if (codexResult.errors.length > 0) {
        result.warnings.push(...codexResult.errors);
      }
    }

    if (added.length > 0) {
      await saveConfigPreservingClaudeCode(config);
    }

    if (added.length > 0 || codexImportedCount > 0) {
      await convergeCodexCatalog();
    }

    return jsonResponse({
      success: true,
      sourceKind: result.sourceKind,
      imported: added,
      skipped,
      count: added.length,
      codexAccounts: codexImportedCount,
      codexAccountIds: codexImportedIds,
      warnings: result.warnings,
    });
  } catch (err: unknown) {
    return jsonResponse({ error: (err as Error).message || "Import failed" }, 400);
  }
}
