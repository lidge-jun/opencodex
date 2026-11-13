import { useState } from "react";
import { useT } from "../../i18n/shared";
import type { TKey } from "../../i18n/en";
import { REASONING_EFFORT_LEVELS } from "../../pages/models-shared";
import { formatProviderDisplayName } from "../../provider-icons";
import {
  formatContextWindow,
  memberRestorePatch,
  memberSettingsPatch,
  type CapabilitySource,
  type ContextBasis,
  type MemberDraft,
  type MemberFacts,
} from "../../route-board-model";
import type { EditableChannel } from "./ChannelEditor";

const MODALITIES = ["text", "image"];

const SOURCE_KEYS: Record<CapabilitySource, TKey> = {
  reported: "routeBoard.source.reported",
  inferred: "routeBoard.source.inferred",
  manual: "routeBoard.source.manual",
  unknown: "routeBoard.source.unknown",
};

/** Saves one member model's settings; resolves to an error message, or null once saved and reloaded. */
export type SaveMemberModel = (provider: string, modelId: string, patch: Record<string, unknown>) => Promise<string | null>;

interface Editing {
  key: string;
  draft: MemberDraft;
  error?: string;
  saving?: boolean;
}

/**
 * What each channel can take (context, input, effort levels) and what that makes the combo.
 * Every cell says where its value comes from; a row opens in place to change the provider's
 * per-model settings, which every combo using that model shares.
 */
export function MemberTable({
  channels,
  facts,
  labels,
  combo,
  onSaveModel,
}: {
  channels: readonly EditableChannel[];
  facts: readonly MemberFacts[];
  labels?: ReadonlyMap<string, string>;
  combo: { context?: number; basis: ContextBasis; modalities?: readonly string[]; efforts?: readonly string[] };
  onSaveModel?: SaveMemberModel;
}) {
  const t = useT();
  const [editing, setEditing] = useState<Editing | null>(null);
  const providerName = (provider: string) => labels?.get(provider) ?? formatProviderDisplayName(provider, t);
  const modalityWord = (value: string) => value === "text" ? t("routeBoard.members.text") : value === "image" ? t("routeBoard.members.image") : value;
  const listText = (list: readonly string[] | undefined, word?: (value: string) => string) =>
    list === undefined ? t("routeBoard.members.unknown") : list.length === 0 ? t("routeBoard.members.none") : list.map((v) => word ? word(v) : v).join(" · ");
  const sourceTag = (source: CapabilitySource | undefined) => (
    <span className={`rb-src rb-src--${source ?? "unknown"}`}>{t(SOURCE_KEYS[source ?? "unknown"])}</span>
  );

  const open = (channel: EditableChannel, fact: MemberFacts) => setEditing({
    key: channel.key,
    draft: {
      context: fact.contextWindow ? String(fact.contextWindow) : "",
      input: fact.inputModalities ?? [],
      efforts: fact.reasoningEfforts ?? [],
    },
  });
  const toggle = (list: readonly string[], value: string) => list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  const send = async (channel: EditableChannel, patch: Record<string, unknown>) => {
    if (!onSaveModel || Object.keys(patch).length === 0) { setEditing(null); return; }
    setEditing((current) => current && { ...current, saving: true, error: undefined });
    const error = await onSaveModel(channel.provider, channel.model, patch);
    setEditing((current) => current?.key !== channel.key ? current : error ? { ...current, saving: false, error } : null);
  };

  return (
    <table className="rb-members">
      <caption>{t("routeBoard.members.title")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("routeBoard.members.channel")}</th>
          <th scope="col">{t("routeBoard.members.context")}</th>
          <th scope="col">{t("routeBoard.members.input")}</th>
          <th scope="col">{t("routeBoard.members.efforts")}</th>
          <th scope="col"><span className="sr-only">{t("routeBoard.members.actions")}</span></th>
        </tr>
      </thead>
      <tbody>
        {channels.map((channel, index) => {
          const fact = facts[index] ?? {};
          const name = `${providerName(channel.provider)} ${channel.model}`;
          const row = (
            <tr key={channel.key}>
              <th scope="row">
                {providerName(channel.provider)}
                <code className="rb-members-model">{channel.model}</code>
              </th>
              {/* An unknown value is just the "unknown" tag, not the word twice. */}
              <td>{fact.contextWindow ? <>{formatContextWindow(fact.contextWindow)} </> : null}{sourceTag(fact.contextWindow ? fact.sources?.context : "unknown")}</td>
              <td>{fact.inputModalities ? <>{listText(fact.inputModalities, modalityWord)} </> : null}{sourceTag(fact.inputModalities ? fact.sources?.input : "unknown")}</td>
              <td>{fact.reasoningEfforts ? <>{listText(fact.reasoningEfforts)} </> : null}{sourceTag(fact.reasoningEfforts ? fact.sources?.efforts : "unknown")}</td>
              <td className="rb-members-actions">
                {onSaveModel && editing?.key !== channel.key && (
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={t("routeBoard.members.editAria", { name })}
                    onClick={() => open(channel, fact)}>{t("routeBoard.members.edit")}</button>
                )}
              </td>
            </tr>
          );
          if (editing?.key !== channel.key) return row;
          const { draft } = editing;
          const set = (next: Partial<MemberDraft>) => setEditing({ ...editing, draft: { ...draft, ...next }, error: undefined });
          const restore = memberRestorePatch(fact.sources);
          const save = () => {
            const result = memberSettingsPatch(fact, draft, REASONING_EFFORT_LEVELS);
            if (result.invalid) { setEditing({ ...editing, error: t("routeBoard.members.contextInvalid") }); return; }
            void send(channel, result.patch);
          };
          return [
            row,
            <tr key={`${channel.key}:edit`} className="rb-members-editrow">
              <td colSpan={5}>
                <div className="rb-member-edit" role="group" aria-label={t("routeBoard.members.editAria", { name })}>
                  <label className="rb-member-field">
                    <span>{t("routeBoard.members.context")}</span>
                    <input
                      className="input input-sm"
                      value={draft.context}
                      placeholder={t("routeBoard.members.contextPlaceholder")}
                      onChange={(event) => set({ context: event.target.value })}
                    />
                  </label>
                  <div className="rb-member-field">
                    <span>{t("routeBoard.members.input")}</span>
                    <span className="rb-chips">
                      {MODALITIES.map((modality) => (
                        <button key={modality} type="button" className="rb-chip" aria-pressed={draft.input.includes(modality)}
                          onClick={() => set({ input: toggle(draft.input, modality) })}>{modalityWord(modality)}</button>
                      ))}
                    </span>
                  </div>
                  <div className="rb-member-field">
                    <span>{t("routeBoard.members.efforts")}</span>
                    <span className="rb-chips">
                      {REASONING_EFFORT_LEVELS.map((level) => (
                        <button key={level} type="button" className="rb-chip" aria-pressed={draft.efforts.includes(level)}
                          onClick={() => set({ efforts: toggle(draft.efforts, level) })}>{level}</button>
                      ))}
                    </span>
                  </div>
                  <p className="rb-member-note">{t("routeBoard.members.scopeNote", { name })}</p>
                  <p className="rb-member-note">{t("routeBoard.probe.note")}</p>
                  {editing.error && <p className="rb-member-error" role="alert">{editing.error}</p>}
                  <div className="rb-member-buttons">
                    <button type="button" className="btn btn-ghost btn-sm" disabled title={t("routeBoard.probe.pending")}>
                      {t("routeBoard.probe.run")}
                    </button>
                    {Object.keys(restore).length > 0 && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={editing.saving}
                        onClick={() => void send(channel, restore)}>{t("routeBoard.members.restore")}</button>
                    )}
                    <span className="rb-editor-spacer" />
                    <button type="button" className="btn btn-ghost btn-sm" disabled={editing.saving}
                      onClick={() => setEditing(null)}>{t("common.cancel")}</button>
                    <button type="button" className="btn btn-primary btn-sm" disabled={editing.saving} onClick={save}>
                      {t("common.save")}
                    </button>
                  </div>
                </div>
              </td>
            </tr>,
          ];
        })}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">{t("routeBoard.members.combo")}</th>
          <td>
            {combo.context ? formatContextWindow(combo.context) : t("routeBoard.members.unknown")}
            {combo.basis !== "catalog" && <span className="rb-members-basis"> {t(combo.basis === "max" ? "routeBoard.contextBasis.max" : "routeBoard.contextBasis.min")}</span>}
          </td>
          <td>{listText(combo.modalities, modalityWord)}</td>
          <td>{listText(combo.efforts)}</td>
          <td />
        </tr>
      </tfoot>
    </table>
  );
}
