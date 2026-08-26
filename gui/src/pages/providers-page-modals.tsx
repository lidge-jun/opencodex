import AddProviderModal from "../components/AddProviderModal";
import AddCodexAccountModal from "../components/AddCodexAccountModal";
import OAuthTosWarningModal from "../components/OAuthTosWarningModal";
import { RemoveConfirmDialog, UnsavedLeaveDialog } from "../components/provider-workspace/ProviderDialogs";
import type { AddProviderIntent } from "../components/provider-workspace/ProviderWorkspaceShell";
import type { AccountLoginRow, AccountLoginStatus } from "../components/provider-catalog/ProviderCatalog";
import type { ProvidersConfig } from "./providers-shared";
import { oauthLabel } from "./providers-shared";
import type { CodexAccountMutationCompletion } from "../codex-account-mutation";

export function ProvidersPageModals({
  apiBase,
  config,
  adding,
  addIntent,
  busy,
  addModalAccountRows,
  accountLoginStatus,
  accountLoginHint,
  removeConfirmName,
  removeDefaultProvider,
  codexLoginOpen,
  jsonLeaveOpen,
  jsonSaving,
  oauthTosPending,
  onCloseAdd,
  onAdded,
  onAccountLogin,
  onAccountCancelLogin,
  onAccountLogout,
  onAccountManage,
  onOpenAdd,
  onCloseCodexLogin,
  onCodexAdded,
  onCancelRemove,
  onConfirmRemove,
  onCancelJsonLeave,
  onDiscardJson,
  onSaveJson,
  onCancelOauthTos,
  onContinueOauthTos,
}: {
  apiBase: string;
  config: ProvidersConfig;
  adding: boolean;
  addIntent: AddProviderIntent | null;
  busy: string | null;
  addModalAccountRows: AccountLoginRow[];
  accountLoginStatus: Record<string, AccountLoginStatus>;
  accountLoginHint?: { provider: string; url?: string; instructions?: string; deviceCode?: string } | null;
  removeConfirmName: string | null;
  removeDefaultProvider: string | null;
  codexLoginOpen: boolean;
  jsonLeaveOpen?: boolean;
  jsonSaving?: boolean;
  oauthTosPending: { provider: string; addAccount: boolean } | null;
  onCloseAdd: () => void;
  onAdded: (name: string) => void;
  onAccountLogin: (provider: string, addAccount?: boolean) => void;
  onAccountCancelLogin: (provider: string) => void;
  onAccountLogout: (provider: string) => void;
  onAccountManage?: (provider: string) => void;
  onOpenAdd: () => void;
  onCloseCodexLogin: () => void;
  onCodexAdded: (completion: CodexAccountMutationCompletion) => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  onCancelJsonLeave?: () => void;
  onDiscardJson?: () => void;
  onSaveJson?: () => void;
  onCancelOauthTos: () => void;
  onContinueOauthTos: () => void;
}) {
  return (
    <>
      {adding && (
        <AddProviderModal
          apiBase={apiBase}
          existingNames={Object.keys(config.providers)}
          initialTier={addIntent?.tier}
          initialCustom={addIntent?.custom}
          onClose={onCloseAdd}
          onAdded={onAdded}
          accountRows={addModalAccountRows}
          accountStatus={accountLoginStatus}
          accountBusy={busy}
          accountLoginHint={accountLoginHint ?? null}
          onAccountLogin={onAccountLogin}
          onAccountCancelLogin={onAccountCancelLogin}
          onAccountLogout={onAccountLogout}
          onAccountManage={onAccountManage}
          onOpen={onOpenAdd}
        />
      )}
      {codexLoginOpen && (
        <AddCodexAccountModal
          apiBase={apiBase}
          onClose={onCloseCodexLogin}
          onAdded={onCodexAdded}
        />
      )}
      {removeConfirmName && (
        <RemoveConfirmDialog
          providerName={removeConfirmName}
          defaultProviderName={removeDefaultProvider}
          onCancel={onCancelRemove}
          onConfirm={onConfirmRemove}
        />
      )}
      {jsonLeaveOpen && onCancelJsonLeave && onDiscardJson && onSaveJson && (
        <UnsavedLeaveDialog
          saving={jsonSaving ?? false}
          onCancel={onCancelJsonLeave}
          onDiscard={onDiscardJson}
          onSave={onSaveJson}
        />
      )}
      {oauthTosPending && (
        <OAuthTosWarningModal
          key={`${oauthTosPending.provider}:${oauthTosPending.addAccount ? "add" : "login"}`}
          providerId={oauthTosPending.provider}
          providerLabel={oauthLabel(oauthTosPending.provider)}
          onCancel={onCancelOauthTos}
          onContinue={onContinueOauthTos}
        />
      )}
    </>
  );
}
