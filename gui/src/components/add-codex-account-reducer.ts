export type AddCodexAccountStep = "pick" | "oauth-waiting";
export type ManualCodeState = "idle" | "submitting" | "waiting";
export type StatusTone = "ok" | "warn";

export interface AddCodexAccountUiState {
  step: AddCodexAccountStep;
  id: string;
  error: string;
  authUrl: string;
  /** Short human code for a device login; empty for the browser callback flow. */
  deviceCode: string;
  /** Provider-supplied prose that accompanies the code. */
  instructions: string;
  manualCode: string;
  manualCodeState: ManualCodeState;
  statusNotice: string;
  statusTone: StatusTone;
  flowId: string | null;
}

export const initialAddCodexAccountUiState = (reauthAccountId?: string): AddCodexAccountUiState => ({
  step: reauthAccountId ? "oauth-waiting" : "pick",
  id: "",
  error: "",
  authUrl: "",
  deviceCode: "",
  instructions: "",
  manualCode: "",
  manualCodeState: "idle",
  statusNotice: "",
  statusTone: "ok",
  flowId: null,
});

export type AddCodexAccountUiAction =
  | { type: "set-step"; step: AddCodexAccountStep }
  | { type: "set-id"; id: string }
  | { type: "set-error"; error: string }
  | { type: "set-auth-url"; authUrl: string }
  | { type: "set-login-hint"; authUrl: string; deviceCode?: string; instructions?: string }
  | { type: "set-manual-code"; manualCode: string }
  | { type: "set-manual-code-state"; manualCodeState: ManualCodeState }
  | { type: "set-status-notice"; statusNotice: string; statusTone?: StatusTone }
  | { type: "set-flow-id"; flowId: string | null }
  | { type: "clear-manual-code" }
  | { type: "reset-oauth-start" }
  | { type: "oauth-code-submitted" };

export function addCodexAccountUiReducer(state: AddCodexAccountUiState, action: AddCodexAccountUiAction): AddCodexAccountUiState {
  switch (action.type) {
    case "set-step":
      return { ...state, step: action.step };
    case "set-id":
      return { ...state, id: action.id };
    case "set-error":
      return { ...state, error: action.error };
    case "set-auth-url":
      return { ...state, authUrl: action.authUrl };
    case "set-login-hint":
      return {
        ...state,
        authUrl: action.authUrl,
        deviceCode: action.deviceCode ?? "",
        instructions: action.instructions ?? "",
      };
    case "set-manual-code":
      return { ...state, manualCode: action.manualCode };
    case "set-manual-code-state":
      return { ...state, manualCodeState: action.manualCodeState };
    case "set-status-notice":
      return { ...state, statusNotice: action.statusNotice, statusTone: action.statusTone ?? state.statusTone };
    case "set-flow-id":
      return { ...state, flowId: action.flowId };
    case "clear-manual-code":
      return { ...state, manualCode: "", manualCodeState: "idle", statusNotice: "", statusTone: "ok" };
    case "reset-oauth-start":
      return { ...state, error: "", statusNotice: "", statusTone: "ok", flowId: null };
    case "oauth-code-submitted":
      return { ...state, error: "", manualCode: "", manualCodeState: "waiting", statusTone: "ok", statusNotice: "" };
    default:
      return state;
  }
}
