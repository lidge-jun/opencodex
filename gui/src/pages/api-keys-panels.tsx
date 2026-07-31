import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconPlus, IconX } from "../icons";
import { useI18n } from "../i18n/shared";
import {
  externalModelId,
  gatewayInboundProtocols,
  type ExternalModelRow,
} from "../api-access-models";
import {
  formatCreatedDate,
  type ApiEndpointInfo,
  type ApiKeyEntry,
  type ModelTestState,
} from "./api-keys-utils";
import { DataSurfaceSkeleton } from "../components/data-surface";

function EndpointUrl({ url }: { url: string }) {
  return (
    <CopyOnClickTip
      text={url}
      hintKey="api.copyUrlHint"
      copiedKey="api.urlCopied"
      className="api-endpoint-url-btn"
    >
      <code className="api-code api-code-inline api-endpoint-url">{url}</code>
    </CopyOnClickTip>
  );
}

function CopyOnClickTip({
  text,
  hintKey,
  copiedKey,
  className,
  children,
}: {
  text: string;
  hintKey: "api.copyUrlHint" | "api.copyExampleHint";
  copiedKey: "api.urlCopied" | "api.exampleCopied";
  className: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const tipId = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const showTip = hover || copied;

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  useLayoutEffect(() => {
    // No reset on close: the portal and aria-describedby are already gated on showTip,
    // and reopening remeasures in this same layout effect before paint. Clearing here
    // only forced a second render.
    if (!showTip) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setCoords({
        top: Math.max(8, rect.top - 8),
        left: rect.left + rect.width / 2,
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [showTip]);

  const openTip = () => setHover(true);
  const closeTip = () => setHover(false);

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const tip = showTip && coords
    ? createPortal(
      <span
        id={tipId}
        className="ocx-tooltip-bubble api-copy-tip-fixed"
        role="tooltip"
        style={{ top: coords.top, left: coords.left }}
      >
        {copied ? t(copiedKey) : t(hintKey)}
      </span>,
      document.body,
    )
    : null;

  const shared = {
    ref: anchorRef as never,
    className: `ocx-tooltip ${className}`,
    onMouseEnter: openTip,
    onMouseLeave: closeTip,
    onFocus: openTip,
    onBlur: closeTip,
    onClick: (event: { currentTarget: EventTarget & Element; target: EventTarget | null; clientX: number; clientY: number }) => {
      if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
      const target = event.target;
      if (target instanceof HTMLElement && target !== event.currentTarget) {
        const rect = target.getBoundingClientRect();
        if (target.scrollHeight > target.clientHeight + 1 && event.clientX >= rect.right - 16) return;
        if (target.scrollWidth > target.clientWidth + 1 && event.clientY >= rect.bottom - 16) return;
      }
      void copyText();
    },
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key === "Escape") closeTip();
    },
    "aria-label": t(hintKey),
    "aria-describedby": showTip ? tipId : undefined,
  };

  return (
    <>
      <button type="button" {...shared}>
        {children}
      </button>
      {tip}
    </>
  );
}

function CopyableExample({ text }: { text: string }) {
  return (
    <CopyOnClickTip
      text={text}
      hintKey="api.copyExampleHint"
      copiedKey="api.exampleCopied"
      className="api-example-copy-btn"
    >
      <code className="api-code api-example-pre">{text}</code>
    </CopyOnClickTip>
  );
}

export function ApiKeysEndpointsPanel({
  endpoints,
  claudeCodeEnabled,
}: {
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="panel api-panel">
      <h3 className="panel-title">{t("api.endpointsTitle")}</h3>
      <div className="api-endpoints">
        <div>
          <span className="muted small">{t("api.baseUrl")}</span>
          <EndpointUrl url={endpoints.baseUrl} />
        </div>
        <div>
          <span className="muted small">{t("api.responsesEndpoint")}</span>
          <EndpointUrl url={endpoints.responses} />
        </div>
        <div>
          <span className="muted small">{t("api.chatCompletionsEndpoint")}</span>
          <EndpointUrl url={endpoints.chatCompletions} />
        </div>
        {claudeCodeEnabled && (
          <div>
            <span className="muted small">{t("api.messagesEndpoint")}</span>
            <EndpointUrl url={endpoints.messages} />
          </div>
        )}
        <div>
          <span className="muted small">{t("api.modelsEndpoint")}</span>
          <EndpointUrl url={endpoints.models} />
        </div>
      </div>
      <p className="muted small">{t("api.endpointNote")}</p>
      <details className="awi-inline-fold">
        <summary>{t("api.authTitle")}</summary>
        <div className="awi-inline-fold-body">
          <ul className="api-auth-list muted small">
            <li>{t("api.authChatCompletions")}</li>
            <li>{t("api.authResponses")}</li>
            {claudeCodeEnabled && <li>{t("api.authMessages")}</li>}
            <li>{t("api.authLoopback")}</li>
          </ul>
          <p className="muted small">{t("api.authBaseUrlNote")}</p>
        </div>
      </details>
    </div>
  );
}

export function ApiKeysManagePanel({
  keys,
  keysLoading = false,
  keysLoadFailed,
  newName,
  creating,
  newKey,
  copied,
  confirmDelete,
  localeTag,
  showKeyList = true,
  onNewNameChange,
  onCreate,
  onDismissNewKey,
  onCopyKey,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
}: {
  keys: ApiKeyEntry[];
  keysLoading?: boolean;
  keysLoadFailed: boolean;
  newName: string;
  creating: boolean;
  newKey: string | null;
  copied: boolean;
  confirmDelete: string | null;
  localeTag?: string;
  /** When false, only generate / reveal-new-key UI is shown (workspace rail owns the list). */
  showKeyList?: boolean;
  onNewNameChange: (value: string) => void;
  onCreate: () => void;
  onDismissNewKey: () => void;
  onCopyKey: () => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useI18n();

  return (
    <>
      {newKey && (
        <div className="panel api-panel panel-accent api-newkey-panel">
          <h3 className="panel-title">{t("api.newKeyTitle")}</h3>
          <p className="muted small">{t("api.newKeyNote")}</p>
          <div className="api-form-row">
            <code className="api-code" style={{ flex: 1, wordBreak: "break-all" }}>{newKey}</code>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onCopyKey}>
              {copied ? <><IconCheck /> {t("api.copied")}</> : t("api.copy")}
            </button>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }} onClick={onDismissNewKey}>
            {t("api.dismiss")}
          </button>
        </div>
      )}

      <div className="panel api-panel api-generate-panel">
        <h3 className="panel-title">{t("api.generateTitle")}</h3>
        <div className="api-form-row">
          <input
            id="api-key-name"
            type="text"
            placeholder={t("api.keyNamePlaceholder")}
            aria-label={t("api.keyNamePlaceholder")}
            value={newName}
            onChange={e => onNewNameChange(e.target.value)}
            className="input"
          />
          <button type="button" className="btn btn-primary" onClick={onCreate} disabled={creating}>
            <IconPlus /> {creating ? t("api.generating") : t("api.generate")}
          </button>
        </div>
      </div>

      {showKeyList && (
        <div className="panel api-panel" style={{ marginTop: "1rem" }} aria-busy={keysLoading}>
          <h3 className="panel-title">
            {keysLoading ? t("api.activeKeysLoading") : t("api.activeKeys", { count: keys.length })}
          </h3>
          {keysLoading ? (
            <div className="api-active-keys-skeleton" role="status" aria-label={t("common.loading")} />
          ) : keys.length > 0 ? (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>{t("api.colName")}</th><th>{t("api.colKey")}</th><th>{t("api.colCreated")}</th><th></th></tr>
                </thead>
                <tbody>
                  {keys.map(k => (
                    <tr key={k.id}>
                      <td>{k.name}</td>
                      <td><code>{k.prefix}</code></td>
                      <td>{formatCreatedDate(k.createdAt, localeTag)}</td>
                      <td>
                        {confirmDelete === k.id ? (
                          <span className="api-actions">
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => onDelete(k.id)}>{t("api.confirm")}</button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={onCancelDelete}>{t("common.cancel")}</button>
                          </span>
                        ) : (
                          <button type="button" className="btn btn-sm btn-ghost" aria-label={t("api.deleteAria")} onClick={() => onConfirmDelete(k.id)}><IconX /></button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : keysLoadFailed ? (
            <p className="muted">{t("api.keysLoadFailed")}</p>
          ) : (
            <p className="muted">{t("api.noKeys")}</p>
          )}
        </div>
      )}
    </>
  );
}

export function ApiKeysModelsPanel({
  filteredModels,
  modelsLoading,
  modelsLoadFailed,
  modelQuery,
  copiedModelId,
  modelTests,
  claudeCodeEnabled,
  onModelQueryChange,
  onCopyModelId,
  onTestModel,
  sourceLabel,
  protocolLabel,
}: {
  filteredModels: ExternalModelRow[];
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
  modelQuery: string;
  copiedModelId: string | null;
  modelTests: Record<string, { state: ModelTestState; detail?: string }>;
  claudeCodeEnabled: boolean;
  onModelQueryChange: (value: string) => void;
  onCopyModelId: (modelId: string) => void;
  onTestModel: (model: ExternalModelRow) => void;
  sourceLabel: (model: ExternalModelRow) => string;
  protocolLabel: (protocol: string) => string;
}) {
  const { t } = useI18n();
  return (
    <div className="panel api-panel api-models-panel">
      <div className="api-panel-head">
        <h3 className="panel-title">{t("api.modelsTitle")}</h3>
        <span className="muted mono text-label">{t("api.modelsCount", { count: filteredModels.length })}</span>
      </div>
      <p className="muted small">{t("api.modelsSubtitle")}</p>
      <input
        type="search"
        className="input"
        value={modelQuery}
        onChange={event => onModelQueryChange(event.target.value)}
        placeholder={t("api.modelsSearch")}
        aria-label={t("api.modelsSearch")}
      />
      {modelsLoading ? (
        <DataSurfaceSkeleton label={t("api.modelsLoading")} rows={3} />
      ) : modelsLoadFailed ? (
        // The page-level notice owns the persistent announcement and retry surface. Keeping this
        // panel mounted preserves the query field without adding a second live error region.
        null
      ) : filteredModels.length === 0 ? (
        <p className="muted small" style={{ marginTop: "0.75rem" }}>{t("api.modelsEmpty")}</p>
      ) : (
        <div className="api-models-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("api.colModel")}</th>
                <th>{t("api.colSource")}</th>
                <th>{t("api.colProtocols")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredModels.map(model => {
                const modelId = externalModelId(model);
                const testState = modelTests[modelId]?.state ?? "idle";
                return (
                  <tr key={modelId}>
                    <td>
                      <div className="api-model-cell">
                        <code>{modelId}</code>
                        {model.displayName !== model.id && <span className="muted small">{model.displayName}</span>}
                      </div>
                    </td>
                    <td>{sourceLabel(model)}</td>
                    <td>{gatewayInboundProtocols(claudeCodeEnabled).map(protocolLabel).join(", ")}</td>
                    <td>
                      <div className="api-model-actions">
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { onCopyModelId(modelId); }}>
                          {copiedModelId === modelId ? t("api.modelCopied") : t("api.copyModelId")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={testState === "testing"}
                          onClick={() => { onTestModel(model); }}
                        >
                          {testState === "testing" ? t("api.testingModel") : t("api.testModel")}
                        </button>
                      </div>
                      {testState === "ok" && <p className="muted small api-test-note api-test-note--ok">{t("api.testSucceeded")}</p>}
                      {testState === "error" && <p className="muted small api-test-note api-test-note--error">{modelTests[modelId]?.detail ?? t("api.testFailed")}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ApiKeysUsagePanel({
  endpoints,
  claudeCodeEnabled,
}: {
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
}) {
  const { t } = useI18n();
  const sampleInput = JSON.stringify(t("api.usageSampleInput"));

  const chatExample = `curl ${endpoints.chatCompletions} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": ${sampleInput}}]
  }'`;

  const responsesExample = `curl ${endpoints.responses} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": ${sampleInput}
  }'`;

  const messagesExample = `curl ${endpoints.messages} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": ${sampleInput}}]
  }'`;

  return (
    <details className="awi-usage-fold">
      <summary>{t("api.workspace.usageExamples")}</summary>
      <div className="awi-usage-fold-body">
        <div className="awi-usage-example">
          <h4 className="awi-usage-example-title">{t("api.usageChatTitle")}</h4>
          <CopyableExample text={chatExample} />
        </div>

        <div className="awi-usage-example">
          <h4 className="awi-usage-example-title">{t("api.usageResponsesTitle")}</h4>
          <CopyableExample text={responsesExample} />
        </div>

        {claudeCodeEnabled && (
          <div className="awi-usage-example">
            <h4 className="awi-usage-example-title">{t("api.usageMessagesTitle")}</h4>
            <CopyableExample text={messagesExample} />
          </div>
        )}
      </div>
    </details>
  );
}
