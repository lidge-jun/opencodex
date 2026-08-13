import { createAntigravityAccountImportAdapter } from "./google-antigravity-adapter";
import {
  ACCOUNT_IMPORT_FORMAT,
  ACCOUNT_IMPORT_PROVIDER,
  type AccountImportAdapter,
} from "./types";

export type AccountImportRegistryResult =
  | { ok: true; adapter: AccountImportAdapter }
  | { ok: false; code: "unsupported_provider" | "unsupported_format" };

const antigravityAdapter = createAntigravityAccountImportAdapter();

export function resolveAccountImportAdapter(provider: string, format: string): AccountImportRegistryResult {
  if (provider !== ACCOUNT_IMPORT_PROVIDER) return { ok: false, code: "unsupported_provider" };
  if (format !== ACCOUNT_IMPORT_FORMAT) return { ok: false, code: "unsupported_format" };
  return { ok: true, adapter: antigravityAdapter };
}
