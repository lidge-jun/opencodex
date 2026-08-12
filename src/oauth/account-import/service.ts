import { parseCockpitAccountDocument } from "./parser";
import { resolveAccountImportAdapter, type AccountImportRegistryResult } from "./registry";
import {
  AccountImportAbortError,
  throwIfAccountImportAborted,
} from "./types";
import type {
  AccountImportRequest,
  AccountImportResult,
  AccountImportRecordResult,
} from "./types";

export type AccountImportServiceResult =
  | { ok: true; result: AccountImportResult }
  | {
    ok: false;
    status: 400 | 408;
    code: "unsupported_provider" | "unsupported_format" | "invalid_document" | "import_cancelled";
    /** True when at least one credential was committed before the terminal failure. */
    changed?: boolean;
  };

export interface AccountImportServiceDeps {
  resolveAdapter(provider: string, format: string): AccountImportRegistryResult;
}

export async function importAccounts(
  request: AccountImportRequest,
  deps: AccountImportServiceDeps = { resolveAdapter: resolveAccountImportAdapter },
): Promise<AccountImportServiceResult> {
  // Provider/format admission intentionally precedes any traversal or serialization of the
  // credential-bearing document.
  const resolved = deps.resolveAdapter(request.provider, request.format);
  if (!resolved.ok) return { ok: false, status: 400, code: resolved.code };

  const parsed = parseCockpitAccountDocument(request.document);
  if (!parsed.ok) return { ok: false, status: 400, code: parsed.code };

  const results: AccountImportRecordResult[] = [];
  try {
    for (const item of parsed.records) {
      throwIfAccountImportAborted(request.signal);
      if ("code" in item) {
        results.push({ index: item.index, status: "failed", code: item.code });
        continue;
      }
      const outcome = await resolved.adapter.importRecord(item.record, request.signal);
      results.push({ index: item.index, ...outcome });
      // Record the committed outcome before observing cancellation. The route uses this
      // internal signal to reconcile live stores and caches even when the public response
      // is the terminal 408 DTO.
      throwIfAccountImportAborted(request.signal);
    }
  } catch (error) {
    if (error instanceof AccountImportAbortError) {
      const changed = results.some(result => result.status === "imported" || result.status === "updated");
      return { ok: false, status: 408, code: "import_cancelled", ...(changed ? { changed: true } : {}) };
    }
    throw error;
  }

  const count = (status: AccountImportRecordResult["status"]) =>
    results.filter(result => result.status === status).length;
  return {
    ok: true,
    result: {
      totalCount: results.length,
      importedCount: count("imported"),
      updatedCount: count("updated"),
      failedCount: count("failed"),
      unsupportedCount: count("unsupported"),
      results,
    },
  };
}
