import { useState } from "react";
import {
  buildComboSuggestions,
  channelTier,
  extendedCombo,
  suggestionDraft,
  type ChannelTier,
  type ComboSuggestion,
  type SuggestedMember,
  type SuggestionModel,
  type SuggestionProvider,
} from "../../combo-suggestions";
import { isValidComboId, type ComboDraftError, type ComboItem } from "../../combo-workspace-data";
import { useT, type TKey } from "../../i18n/shared";
import { makeCollapseStore } from "../../pages/collapse-store";
import { formatProviderDisplayName } from "../../provider-icons";
import { moveChannel } from "../../route-board-model";
import { ProviderIcon } from "../provider-workspace/ProviderRail";
import { SuggestionExcludeProviders } from "./SuggestionExcludeProviders";

type SaveResult = { ok: boolean; error?: string };

const dismissedStore = makeCollapseStore("ocx.combos.suggestions.dismissed.v1");
const COLLAPSED_COUNT = 3;

const TIER_LABEL: Record<ChannelTier, TKey> = {
  "own-subscription": "comboSuggest.tier.ownSubscription",
  subscription: "comboSuggest.tier.subscription",
  vertex: "comboSuggest.tier.vertex",
  metered: "comboSuggest.tier.metered",
};

export interface ComboSuggestionsProps {
  combos: readonly ComboItem[];
  models: readonly SuggestionModel[];
  hiddenModels: ReadonlySet<string>;
  providers: readonly SuggestionProvider[];
  remainingPercent: (provider: string, model: string) => number | undefined;
  validate: (item: ComboItem, isCreate: boolean) => ComboDraftError | null;
  errorText: (code: ComboDraftError, item: ComboItem) => string;
  onCreate: (item: ComboItem) => Promise<SaveResult>;
  onExtend: (item: ComboItem) => Promise<SaveResult>;
  /** Providers left out of suggestions (config.json); with `onExcludedChange`, offers to change them. */
  excludedProviders?: readonly string[];
  onExcludedChange?: (next: readonly string[]) => Promise<boolean>;
}

/** Suggested combos above the overview: same-name models across providers, one click to a draft. */
export function ComboSuggestions(props: ComboSuggestionsProps) {
  const t = useT();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => dismissedStore.read() ?? new Set());
  const [showAll, setShowAll] = useState(false);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const excluded = props.excludedProviders ?? [];
  const suggestions = buildComboSuggestions({ ...props, dismissed, excludedProviders: new Set(excluded) });
  if (suggestions.length === 0 && excluded.length === 0) return null;

  const dismiss = (key: string) => {
    const next = new Set(dismissed).add(key);
    dismissedStore.write(next);
    setDismissed(next);
    if (draftKey === key) setDraftKey(null);
  };
  const providerByName = new Map(props.providers.map((provider) => [provider.name, provider]));
  const tierOf = (provider: string, model: string): ChannelTier => {
    const known = providerByName.get(provider);
    return known ? channelTier(known, model) : "metered";
  };
  const shown = showAll ? suggestions : suggestions.slice(0, COLLAPSED_COUNT);

  return (
    <section className="rb-suggest" aria-label={t("comboSuggest.title")}>
      <header className="rb-suggest-head">
        <strong>{t("comboSuggest.title")}</strong>
        <span>{t("comboSuggest.lede")}</span>
        {props.onExcludedChange && (
          <SuggestionExcludeProviders
            providers={props.providers.filter((provider) => !provider.disabled && !provider.hiddenFromPicker).map((provider) => provider.name)}
            excluded={excluded}
            onChange={props.onExcludedChange}
          />
        )}
      </header>
      {suggestions.length === 0 && <p className="rb-suggest-hint rb-suggest-empty">{t("comboSuggest.exclude.none")}</p>}
      <ul className="rb-suggest-list">
        {shown.map((suggestion) => (
          <SuggestionCard
            key={suggestion.key}
            suggestion={suggestion}
            drafting={draftKey === suggestion.key}
            combos={props.combos}
            tierOf={tierOf}
            validate={props.validate}
            errorText={props.errorText}
            onCreate={props.onCreate}
            onExtend={props.onExtend}
            onDraft={(open) => setDraftKey(open ? suggestion.key : null)}
            onDismiss={() => dismiss(suggestion.key)}
          />
        ))}
      </ul>
      {suggestions.length > COLLAPSED_COUNT && (
        <button type="button" className="btn btn-ghost btn-sm rb-suggest-more" onClick={() => setShowAll((value) => !value)}>
          {showAll ? t("comboSuggest.showFewer") : t("comboSuggest.showAll", { count: suggestions.length })}
        </button>
      )}
    </section>
  );
}

function MemberChips({ members }: { members: readonly SuggestedMember[] }) {
  const t = useT();
  return (
    <span className="rb-order">
      {members.map((member, index) => (
        <span key={`${member.provider}/${member.model}`} className="rb-order-item">
          {index > 0 && <span className="rb-order-sep" aria-hidden="true">→</span>}
          {formatProviderDisplayName(member.provider, t)}
          <span className={`rb-suggest-tier rb-suggest-tier--${member.tier}`}>{t(TIER_LABEL[member.tier])}</span>
        </span>
      ))}
    </span>
  );
}

function SuggestionCard({
  suggestion,
  drafting,
  combos,
  tierOf,
  validate,
  errorText,
  onCreate,
  onExtend,
  onDraft,
  onDismiss,
}: {
  suggestion: ComboSuggestion;
  drafting: boolean;
  combos: readonly ComboItem[];
  tierOf: (provider: string, model: string) => ChannelTier;
  validate: ComboSuggestionsProps["validate"];
  errorText: ComboSuggestionsProps["errorText"];
  onCreate: ComboSuggestionsProps["onCreate"];
  onExtend: ComboSuggestionsProps["onExtend"];
  onDraft: (open: boolean) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async (item: ComboItem, isCreate: boolean) => {
    const error = validate(item, isCreate);
    if (error) return setMessage(errorText(error, item));
    setBusy(true);
    setMessage(null);
    try {
      const result = await (isCreate ? onCreate(item) : onExtend(item));
      if (!result.ok) setMessage(result.error ?? t("cws.saveFailed"));
      else if (isCreate) onDraft(false);
    } finally {
      setBusy(false);
    }
  };

  const providers = [...new Set(suggestion.members.map((member) => member.provider))];
  const target = suggestion.kind === "extend" ? combos.find((combo) => combo.id === suggestion.comboId) : undefined;
  return (
    <li className="rb-suggest-card">
      <div className="rb-row-main">
        <span className="rb-icons" aria-hidden="true">
          {providers.slice(0, 4).map((provider) => (
            <ProviderIcon key={provider} name={provider} cls="provider-icon provider-icon-sm rb-icon" />
          ))}
        </span>
        <span className="rb-row-body">
          <span className="rb-row-title">
            <strong>{suggestion.comboId}</strong>
            <span className="rb-suggest-note">
              {suggestion.kind === "create"
                ? t("comboSuggest.servedBy", { count: suggestion.members.length })
                : t("comboSuggest.canAdd", { providers: providers.map((provider) => formatProviderDisplayName(provider, t)).join(", ") })}
            </span>
          </span>
          <MemberChips members={suggestion.members} />
        </span>
        <span className="rb-suggest-actions">
          {suggestion.kind === "create" ? (
            <button type="button" className="btn btn-primary btn-sm" aria-expanded={drafting} disabled={busy} onClick={() => onDraft(!drafting)}>
              {t("comboSuggest.generate")}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !target}
              onClick={() => target && void save(extendedCombo(target, suggestion.members, tierOf), false)}
            >
              {t("comboSuggest.addTo")}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onDismiss}>{t("comboSuggest.dismiss")}</button>
        </span>
      </div>
      {message && <p className="rb-row-message" role="alert">{message}</p>}
      {drafting && suggestion.kind === "create" && (
        <SuggestionDraft
          suggestion={suggestion}
          busy={busy}
          onSave={(item) => void save(item, true)}
          onCancel={() => { setMessage(null); onDraft(false); }}
        />
      )}
    </li>
  );
}

function SuggestionDraft({
  suggestion,
  busy,
  onSave,
  onCancel,
}: {
  suggestion: ComboSuggestion & { kind: "create" };
  busy: boolean;
  onSave: (item: ComboItem) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [comboId, setComboId] = useState(suggestion.comboId);
  const [members, setMembers] = useState<SuggestedMember[]>(suggestion.members);
  const idOk = isValidComboId(comboId.trim());
  return (
    <div className="rb-suggest-draft">
      <label className="rb-suggest-field">
        <span>{t("comboSuggest.draft.id")}</span>
        <input className="input rb-suggest-id" value={comboId} onChange={(event) => setComboId(event.target.value)} aria-invalid={!idOk} />
      </label>
      <p className="rb-suggest-hint">{t("comboSuggest.draft.orderHint")}</p>
      <ol className="rb-suggest-members">
        {members.map((member, index) => {
          const name = `${formatProviderDisplayName(member.provider, t)} ${member.model}`;
          return (
          <li key={`${member.provider}/${member.model}`}>
            <ProviderIcon name={member.provider} cls="provider-icon provider-icon-sm" />
            <span className="rb-suggest-member-name">{formatProviderDisplayName(member.provider, t)}</span>
            <code>{member.model}</code>
            <span className={`rb-suggest-tier rb-suggest-tier--${member.tier}`}>{t(TIER_LABEL[member.tier])}</span>
            {member.remainingPercent !== undefined && (
              <span className="rb-suggest-note">{t("comboSuggest.draft.left", { percent: Math.round(member.remainingPercent) })}</span>
            )}
            <span className="rb-suggest-move">
              <button type="button" className="btn btn-ghost btn-sm rb-suggest-icon-btn" disabled={index === 0} aria-label={t("routeBoard.edit.moveUp", { name })}
                onClick={() => setMembers((list) => moveChannel(list, index, index - 1))}>↑</button>
              <button type="button" className="btn btn-ghost btn-sm rb-suggest-icon-btn" disabled={index === members.length - 1} aria-label={t("routeBoard.edit.moveDown", { name })}
                onClick={() => setMembers((list) => moveChannel(list, index, index + 1))}>↓</button>
              <button type="button" className="btn btn-ghost btn-sm rb-suggest-icon-btn" disabled={members.length <= 1} aria-label={t("routeBoard.edit.remove", { name })}
                onClick={() => setMembers((list) => list.filter((_, at) => at !== index))}>×</button>
            </span>
          </li>
          );
        })}
      </ol>
      <div className="rb-suggest-draft-actions">
        <span className="rb-suggest-note">{t("comboSuggest.draft.strategy")}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !idOk}
          onClick={() => onSave(suggestionDraft(comboId.trim(), members))}>
          {busy ? t("comboSuggest.draft.saving") : t("comboSuggest.draft.save")}
        </button>
      </div>
    </div>
  );
}
