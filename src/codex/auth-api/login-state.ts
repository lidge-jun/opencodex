import { ResourceAdmissionError } from "../../lib/admission";

export const MAX_CODEX_LOGIN_STATE_ROWS = 32;
export const CODEX_LOGIN_TERMINAL_TTL_MS = 300_000;
export interface CodexLoginStateRow {
  status: string;
  startedAt: number;
  accountId?: string;
  email?: string;
  error?: string;
  code?: string;
  needsReauth?: boolean;
  catalogRefreshPending?: boolean;
  validationPending?: boolean;
  doneAt?: number;
}
export const codexAuthLoginState = new Map<string, CodexLoginStateRow>();
export class CodexLoginStateBusyError extends ResourceAdmissionError {
  constructor() { super("codex_login_state_rows", MAX_CODEX_LOGIN_STATE_ROWS); this.name = "CodexLoginStateBusyError"; }
}

export function setCodexLoginState(flowId: string, patch: Partial<CodexLoginStateRow>): void {
  const row = codexAuthLoginState.get(flowId);
  if (row) Object.assign(row, patch);
}

export function pruneCodexLoginState(now = Date.now()): void {
  for (const [id, row] of codexAuthLoginState) {
    if (row.doneAt !== undefined && now - row.doneAt >= CODEX_LOGIN_TERMINAL_TTL_MS) codexAuthLoginState.delete(id);
  }
  while (codexAuthLoginState.size >= MAX_CODEX_LOGIN_STATE_ROWS) {
    const terminal = [...codexAuthLoginState].filter(([, row]) => row.doneAt !== undefined)
      .sort((a, b) => (a[1].doneAt ?? 0) - (b[1].doneAt ?? 0))[0];
    if (!terminal) break;
    codexAuthLoginState.delete(terminal[0]);
  }
}

export function expireCodexAuthFlow(flowId: string, error = "Login cancelled"): void {
  const owner = codexAuthLoginState.get(flowId);
  if (!owner || owner.status !== "pending") return;
  Object.assign(owner, { status: "error", error, doneAt: Date.now() });
  setTimeout(() => { if (codexAuthLoginState.get(flowId) === owner) codexAuthLoginState.delete(flowId); }, 30_000);
}
/** Package-internal admission-test seam: seed synthetic login-flow rows and return a prefix-scoped cleanup. */
export function seedLoginRowsForTests(prefix: string, count: number): () => void {
  for (let index = 0; index < count; index++) {
    codexAuthLoginState.set(`${prefix}-login-${index}`, { status: "starting", startedAt: Date.now() });
  }
  return () => {
    for (const key of [...codexAuthLoginState.keys()]) if (key.startsWith(prefix)) codexAuthLoginState.delete(key);
  };
}
