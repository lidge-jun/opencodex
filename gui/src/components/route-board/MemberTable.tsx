import { Fragment, useState, type ReactNode } from "react";
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
  type InferredValue,
  type MemberDraft,
  type MemberFacts,
  type ProbeOutcome,
} from "../../route-board-model";
import type { EditableChannel } from "./ChannelEditor";
import { ProbeResult, type ProbeMemberModel, type ProbeState } from "./MemberProbe";

const MODALITIES = ["text", "image"];

const SOURCE_KEYS: Record<CapabilitySource, TKey> = {
  manual: "routeBoard.source.manual",
  probed: "routeBoard.source.probed",
  reported: "routeBoard.source.reported",
  inferred: "routeBoard.source.inferred",
  unknown: "routeBoard.source.unknown",
};

const BASIS_KEYS: Record<InferredValue<unknown>["basis"]["source"], TKey> = {
  registry: "routeBoard.basis.registry",
  vendor: "routeBoard.basis.vendor",
  provider: "routeBoard.basis.provider",
  aggregator: "routeBoard.basis.aggregator",
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
 * Every cell says where its value comes from. A gap with a same-name estimate shows it and can
 * adopt it as a manual declaration; a row opens in place to change the provider's per-model
 * settings, which every combo using that model shares; "Test it" probes what the relay accepts.
 */
export function MemberTable({
  channels,
  facts,
  labels,
  combo,
  onSaveModel,
  onProbeModel,
}: {
  channels: readonly EditableChannel[];
  facts: readonly MemberFacts[];
  labels?: ReadonlyMap<string, string>;
  combo: { context?: number; basis: ContextBasis; modalities?: readonly string[]; efforts?: readonly string[]; includesInferred?: boolean };
  onSaveModel?: SaveMemberModel;
  onProbeModel?: ProbeMemberModel;
}) {
  const t = useT();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [adoptError, setAdoptError] = useState<{ key: string; message: string } | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
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
  /** An estimate becomes the operator's declaration through the same per-model settings write. */
  const adopt = async (channel: EditableChannel, field: string, value: unknown) => {
    if (!onSaveModel) return;
    setAdopting(`${channel.key}:${field}`);
    setAdoptError(null);
    const error = await onSaveModel(channel.provider, channel.model, { [field]: value });
    setAdopting(null);
    if (error) setAdoptError({ key: channel.key, message: error });
  };
  const probe = async (channel: EditableChannel, confirmed: boolean) => {
    if (!onProbeModel) return;
    setProbes((all) => ({ ...all, [channel.key]: { phase: "running" } }));
    const outcome: ProbeOutcome = await onProbeModel(channel.provider, channel.model, confirmed);
    setProbes((all) => ({ ...all, [channel.key]: { phase: "settled", outcome } }));
  };

  /** One cell: the value with its source, or the estimate for the gap with an "Adopt" button. */
  const cell = (
    channel: EditableChannel,
    name: string,
    known: ReactNode | undefined,
    source: CapabilitySource | undefined,
    inferred: InferredValue<unknown> | undefined,
    shown: string | undefined,
    field: string,
  ) => {
    const adoptable = inferred !== undefined && onSaveModel !== undefined && (known === undefined || source === "inferred");
    return (
      <td>
        {known !== undefined ? <>{known} {sourceTag(source)}</> : inferred && shown ? (
          <span className="rb-inferred">
            {t("routeBoard.inferred.cell", {
              value: shown,
              basis: t(BASIS_KEYS[inferred.basis.source], { provider: inferred.basis.provider }),
            })}
          </span>
        ) : sourceTag("unknown")}
        {adoptable && (
          <button
            type="button"
            className="btn btn-ghost btn-sm rb-adopt"
            disabled={adopting !== null}
            aria-label={t("routeBoard.inferred.adoptAria", { name, value: shown ?? "" })}
            onClick={() => void adopt(channel, field, inferred!.value)}
          >{t("routeBoard.inferred.adopt")}</button>
        )}
      </td>
    );
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
          const probeState = probes[channel.key];
          const blocked = probeState?.phase === "settled" && probeState.outcome.kind === "inapplicable";
          const inferred = fact.inferred;
          const row = (
            <tr>
              <th scope="row">
                {providerName(channel.provider)}
                <code className="rb-members-model">{channel.model}</code>
              </th>
              {cell(channel, name, fact.contextWindow ? formatContextWindow(fact.contextWindow) : undefined, fact.sources?.context,
                inferred?.context, inferred?.context ? formatContextWindow(inferred.context.value) : undefined, "contextWindow")}
              {cell(channel, name, fact.inputModalities ? listText(fact.inputModalities, modalityWord) : undefined, fact.sources?.input,
                inferred?.input, inferred?.input ? listText(inferred.input.value, modalityWord) : undefined, "inputModalities")}
              {cell(channel, name, fact.reasoningEfforts ? listText(fact.reasoningEfforts) : undefined, fact.sources?.efforts,
                inferred?.efforts, inferred?.efforts ? listText(inferred.efforts.value) : undefined, "reasoningEfforts")}
              <td className="rb-members-actions">
                {onProbeModel && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={blocked || probeState?.phase === "running"}
                    aria-label={t("routeBoard.probe.runAria", { name })} onClick={() => void probe(channel, false)}>
                    {t("routeBoard.probe.run")}
                  </button>
                )}
                {onSaveModel && editing?.key !== channel.key && (
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={t("routeBoard.members.editAria", { name })}
                    onClick={() => open(channel, fact)}>{t("routeBoard.members.edit")}</button>
                )}
              </td>
            </tr>
          );
          const extra: ReactNode[] = [];
          if (adoptError?.key === channel.key) {
            extra.push(
              <tr key="adopt" className="rb-members-editrow">
                <td colSpan={5}><p className="rb-member-error" role="alert">{adoptError.message}</p></td>
              </tr>,
            );
          }
          if (probeState) {
            extra.push(
              <tr key="probe" className="rb-members-editrow">
                <td colSpan={5}>
                  <ProbeResult
                    state={probeState}
                    onConfirm={() => void probe(channel, true)}
                    onDismiss={() => setProbes((all) => {
                      const { [channel.key]: _closed, ...rest } = all;
                      return rest;
                    })}
                  />
                </td>
              </tr>,
            );
          }
          if (editing?.key === channel.key) {
            const { draft } = editing;
            const set = (next: Partial<MemberDraft>) => setEditing({ ...editing, draft: { ...draft, ...next }, error: undefined });
            const restore = memberRestorePatch(fact.sources);
            const save = () => {
              const result = memberSettingsPatch(fact, draft, REASONING_EFFORT_LEVELS);
              if (result.invalid) { setEditing({ ...editing, error: t("routeBoard.members.contextInvalid") }); return; }
              void send(channel, result.patch);
            };
            extra.push(
              <tr key="edit" className="rb-members-editrow">
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
                    {editing.error && <p className="rb-member-error" role="alert">{editing.error}</p>}
                    <div className="rb-member-buttons">
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
            );
          }
          return <Fragment key={channel.key}>{row}{extra}</Fragment>;
        })}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">
            {t("routeBoard.members.combo")}
            {combo.includesInferred && <span className="rb-src rb-src--inferred">{t("routeBoard.members.includesInferred")}</span>}
          </th>
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
