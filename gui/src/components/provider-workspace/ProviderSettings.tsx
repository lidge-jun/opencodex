/**
 * ProviderSettings — adapter/baseUrl/defaultModel/authMode/note editing form
 * for the workspace Settings tab (WP091). Uses PATCH /api/providers via an
 * onUpdateProvider prop; the upstream wire panel below the adapter field is read-only
 * and never saves on its own. May fetch `/api/provider-presets` once per provider
 * to discover `baseUrlChoices` (e.g. Qwen Cloud endpoint picker).
 *
 * The form is keyed by dashboard target and provider name, so a same-name provider on
 * another server never inherits this draft. Unsaved drafts are parked in the page-owned
 * in-memory store; a changed saved baseline requires an explicit keep/use-saved choice.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { baseUrlForChoice, matchChoiceId, resolvedBaseUrlForChoice } from "../../base-url-choice";
import { readJsonIfOk } from "../../fetch-json";
import { confirmAction } from "../../action-dialogs";
import { createBoundedFetch } from "../../bounded-fetch";
import { startVisibilityPoll } from "../../visibility-poll";
import { useT } from "../../i18n/shared";
import { IconLock } from "../../icons";
import { Select } from "../../ui";
import { isCatalogProviderId } from "../../provider-icons";
import { openAiAccountProviderState } from "../../provider-payload";
import { canConfigureResponsesReasoningReplay } from "../../responses-reasoning-replay";
import { ResponsesReasoningReplayControl } from "../responses-reasoning-replay-control";
import { isVertexProvider, providerSupportsLiveModelDiscovery } from "../../provider-workspace/catalog";
import type { CatalogPreset } from "../provider-catalog/provider-presets";
import { authModeLabel } from "./ProviderRail";
import { ProviderProtocolPanel } from "./ProviderProtocolPanel";
import { ProviderKeyPacing, type KeyPacingDraft, type KeyPacingStatus } from "./ProviderKeyPacing";
import type { WorkspaceItem, ProviderUpdateCallback } from "./types";
import {
  createProviderDraftStore,
  draftRequestPacing,
  positiveInteger,
  positiveRpm,
  providerDraftTargetLabel,
  providerSettingsDraftFromItem,
  providerSettingsDirty,
  providerSettingsFieldsDirty,
  providerSettingsPacingDirty,
  providerSettingsDraftSignature,
  providerSettingsDeltaPatch,
  providerPacingConflicts,
  rebaseProviderSettingsDraft,
  type ProviderDraftStore,
  type ProviderSettingsDraft,
} from "../../provider-workspace/target-drafts";
import { useRenderTargetCapture } from "../../use-render-target-capture";

const ADAPTERS = ["openai-responses", "openai-chat", "anthropic", "google", "azure-openai", "cursor"] as const;
const EMPTY_MODELS: string[] = [];

type ChoicesStatus = "idle" | "loading" | "ready" | "error";
type PacingRule = { requestsPerMinute?: number; minIntervalMs?: number; maxConcurrentRequests?: number };
type PacingStatus = { enabled: boolean; queued: number; nextSlotInMs: number; lastStartedAt?: number; lastModelId?: string; keys?: KeyPacingStatus[] };
type CursorHttpVersion = "http2" | "http1.1";

/** One mounted form's token in the draft store; referential identity is the whole point. */
function createProviderDraftOwner(): symbol {
  return Symbol("provider-draft-owner");
}

type ProviderSettingsProps = {
  item: WorkspaceItem;
  availableModels?: string[];
  /** When set, load endpoint choices for catalog providers that expose baseUrlChoices. */
  apiBase?: string;
  /** Identity of the dashboard server this form edits; drafts are scoped to it. */
  targetKey?: string;
  /** Nonsecret label for the logical target; never a credential or machine key id. */
  targetLabel?: string;
  /** Page-owned in-memory store so drafts survive a target switch. */
  draftStore?: ProviderDraftStore;
  onUpdateProvider?: ProviderUpdateCallback;
  onDirtyChange?: (dirty: boolean) => void;
  /** Lets parent dialogs trigger the same save path as the sticky bar. */
  onRegisterSave?: (save: (() => Promise<boolean>) | null) => void;
  /** Lets the leave dialog use this form's owner-checked discard. */
  onRegisterDiscard?: (discard: (() => void) | null) => void;
  /**
   * A non-zero token asks this form to bring the Codex account mode control into view and focus
   * it (the Codex Auth mode badge, #8501). A token present at mount counts as a new request.
   */
  accountModeFocusToken?: number;
  /** Called once the account mode focus request has been handled. */
  onAccountModeFocused?: () => void;
};

/**
 * Target-scoped wrapper. A provider name is only unique within one dashboard server, so
 * changing the target remounts the form: the new target reads its own draft (or its saved
 * values), and the previous target's draft stays parked in the store for its return.
 */
export default function ProviderSettings(props: ProviderSettingsProps) {
  const targetKey = props.targetKey ?? "";
  const localStore = useMemo(() => props.draftStore ?? createProviderDraftStore(), [props.draftStore]);
  return (
    <ProviderSettingsForm
      key={`${targetKey}\u0000${props.item.name}`}
      {...props}
      targetKey={targetKey}
      draftStore={localStore}
    />
  );
}

function ProviderSettingsForm({
  item, availableModels = EMPTY_MODELS, apiBase, targetKey, targetLabel, draftStore, onUpdateProvider, onDirtyChange, onRegisterSave, onRegisterDiscard,
  accountModeFocusToken = 0, onAccountModeFocused,
}: ProviderSettingsProps & { targetKey: string; draftStore: ProviderDraftStore }) {
  const t = useT();
  // This mount's identity in the draft store. Created once per mount, so a newer
  // mount for the same target supersedes an older one.
  const [draftOwner] = useState(createProviderDraftOwner);
  const authorityRef = useRef(0);
  const [initial] = useState(() => {
    const base = providerSettingsDraftFromItem(item);
    const restored = draftStore.claim(targetKey, item.name, draftOwner, { draft: base, baseline: base });
    return {
      draft: restored.draft,
      baseline: restored.baseline,
    };
  });
  const liveModelDiscoverySupported = providerSupportsLiveModelDiscovery(item.name, item);
  const [adapter, setAdapter] = useState(initial.draft.adapter);
  const [baseUrl, setBaseUrl] = useState(initial.draft.baseUrl);
  const [project, setProject] = useState(initial.draft.project);
  const [location, setLocation] = useState(initial.draft.location);
  const [defaultModel, setDefaultModel] = useState(initial.draft.defaultModel);
  const [authMode, setAuthMode] = useState(initial.draft.authMode);
  const [apiKeyTransport, setApiKeyTransport] = useState(initial.draft.apiKeyTransport);
  const [note, setNote] = useState(initial.draft.note);
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(initial.draft.allowPrivateNetwork);
  const [preserveReasoningReplay, setPreserveReasoningReplay] = useState(initial.draft.preserveReasoningReplay);
  const [liveModels, setLiveModels] = useState(initial.draft.liveModels);
  const [cursorHttpVersion, setCursorHttpVersion] = useState<CursorHttpVersion>(initial.draft.cursorHttpVersion);
  const [baseline, setBaseline] = useState<ProviderSettingsDraft>(initial.baseline);
  const [saving, setSaving] = useState(false);
  // This form's render owns the target for every save it starts, including a mode change
  // confirmed after a dialog. A module target change that has not re-rendered the form
  // cannot retarget the save.
  const formCapture = useRenderTargetCapture(apiBase ?? "", targetKey);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [accountMode, setAccountMode] = useState<"pool" | "direct">(item.codexAccountMode ?? "pool");
  const [modeSaving, setModeSaving] = useState(false);
  const [modeMsg, setModeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const accountModeFieldRef = useRef<HTMLLabelElement>(null);
  // Starts at 0 so a deep link that mounts this form together with the Settings tab still focuses.
  const handledAccountModeFocusRef = useRef(0);
  useEffect(() => {
    if (!accountModeFocusToken || accountModeFocusToken === handledAccountModeFocusRef.current) return;
    handledAccountModeFocusRef.current = accountModeFocusToken;
    const field = accountModeFieldRef.current;
    if (field) {
      field.scrollIntoView?.({ block: "center" });
      // The trigger is disabled while a save or mode change runs; the field still takes focus.
      const trigger = field.querySelector<HTMLButtonElement>("#pws-codex-account-mode");
      if (trigger && !trigger.disabled) trigger.focus();
      else field.focus();
    }
    onAccountModeFocused?.();
  }, [accountModeFocusToken, onAccountModeFocused]);
  const [baseUrlChoices, setBaseUrlChoices] = useState<CatalogPreset["baseUrlChoices"]>();
  // "" is the same-origin dashboard and must load like any other server base.
  const [choicesStatus, setChoicesStatus] = useState<ChoicesStatus>(apiBase !== undefined ? "loading" : "idle");
  const [endpointChoice, setEndpointChoice] = useState(() => "custom");
  const [pacingEnabled, setPacingEnabled] = useState(initial.draft.pacingEnabled);
  const [keyPacing, setKeyPacing] = useState<KeyPacingDraft>(initial.draft.keyPacing);
  const [pacingRpm, setPacingRpm] = useState(initial.draft.pacingRpm);
  const [pacingDelay, setPacingDelay] = useState(initial.draft.pacingDelay);
  const [pacingConcurrency, setPacingConcurrency] = useState(initial.draft.pacingConcurrency);
  const [pacingModels, setPacingModels] = useState<Record<string, PacingRule>>(() => ({ ...initial.draft.pacingModels }));
  const [pacingModelId, setPacingModelId] = useState("");
  const [pacingModelRpm, setPacingModelRpm] = useState("");
  const [pacingModelDelay, setPacingModelDelay] = useState("");
  const [pacingModelConcurrency, setPacingModelConcurrency] = useState("");
  const [pacingStatus, setPacingStatus] = useState<PacingStatus | null>(null);

  const draft = useMemo<ProviderSettingsDraft>(() => ({
    adapter, baseUrl, project, location, defaultModel, authMode, apiKeyTransport, note,
    allowPrivateNetwork, preserveReasoningReplay, liveModels, cursorHttpVersion,
    pacingEnabled, keyPacing, pacingRpm, pacingDelay, pacingConcurrency, pacingModels,
  }), [adapter, allowPrivateNetwork, apiKeyTransport, authMode, baseUrl, cursorHttpVersion, defaultModel,
    keyPacing, liveModels, location, note, pacingConcurrency, pacingDelay, pacingEnabled, pacingModels, pacingRpm,
    preserveReasoningReplay, project]);

  const applyDraft = (next: ProviderSettingsDraft) => {
    setAdapter(next.adapter);
    setBaseUrl(next.baseUrl);
    setProject(next.project);
    setLocation(next.location);
    setDefaultModel(next.defaultModel);
    setAuthMode(next.authMode);
    setApiKeyTransport(next.apiKeyTransport);
    setNote(next.note);
    setAllowPrivateNetwork(next.allowPrivateNetwork);
    setPreserveReasoningReplay(next.preserveReasoningReplay);
    setLiveModels(next.liveModels);
    setCursorHttpVersion(next.cursorHttpVersion);
    setPacingEnabled(next.pacingEnabled);
    setKeyPacing({ ...next.keyPacing, ...(next.keyPacing.keys ? { keys: { ...next.keyPacing.keys } } : {}) });
    setPacingRpm(next.pacingRpm);
    setPacingDelay(next.pacingDelay);
    setPacingConcurrency(next.pacingConcurrency);
    setPacingModels(Object.fromEntries(Object.entries(next.pacingModels).map(([model, rule]) => [model, { ...rule }])));
  };

  const fieldsDirty = providerSettingsFieldsDirty(draft, item);
  const pacingDirty = providerSettingsPacingDirty(draft, item);
  const draftSignature = providerSettingsDraftSignature(draft);
  const baselineSignature = providerSettingsDraftSignature(baseline);
  /** A real user edit, as distinct from saved values arriving under an untouched form. */
  const edited = draftSignature !== baselineSignature;
  /** The bar follows the saved item until its refresh lands, even after a confirmed save. */
  const dirty = edited || fieldsDirty || pacingDirty;
  const baselineChanged = providerSettingsDirty(baseline, item);
  const pacingConflictPaths = providerPacingConflicts(baseline, draft, item.requestPacing);
  /** Saved values moved under a dirty draft; the user must choose a side. */
  const conflict = (edited && baselineChanged) || pacingConflictPaths.length > 0;
  const targetKeyRef = useRef(targetKey);
  const baseUrlRef = useRef(baseUrl);
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    targetKeyRef.current = targetKey;
    baseUrlRef.current = baseUrl;
    draftRef.current = draft;
  });

  // Adopt saved values while rendering: the React pattern for a prop-driven reset.
  // A clean form follows the saved item in the same commit, and a dirty draft keeps
  // what the user typed, so the conflict banner can ask which side wins.
  const savedDraft = providerSettingsDraftFromItem(item);
  const savedSignature = providerSettingsDraftSignature(savedDraft);
  const [syncedSignature, setSyncedSignature] = useState(savedSignature);
  if (syncedSignature !== savedSignature) {
    setSyncedSignature(savedSignature);
    if (!edited) {
      applyDraft(savedDraft);
      setBaseline(savedDraft);
      setEndpointChoice(matchChoiceId(baseUrlChoices, savedDraft.baseUrl));
      setMsg(null);
      setModeMsg(null);
    }
  }

  // Park this target's draft (or clear it once it matches the saved values). Memory only:
  // credentials must never be persisted by the dashboard without an explicit request.
  useEffect(() => {
    draftStore.writeOwned(targetKey, item.name, draftOwner, { draft, baseline });
  }, [baseline, draft, draftOwner, draftStore, edited, item.name, targetKey]);

  // Account mode is adopted separately from the settings fields above: a mode PATCH
  // refresh must not reset an in-progress draft, and the same render-phase pattern
  // keeps the select on the saved value without a second render.
  const savedAccountMode = item.codexAccountMode ?? "pool";
  const [syncedAccountMode, setSyncedAccountMode] = useState(savedAccountMode);
  if (syncedAccountMode !== savedAccountMode) {
    setSyncedAccountMode(savedAccountMode);
    setAccountMode(savedAccountMode);
  }

  useEffect(() => {
    if (apiBase === undefined) return;
    let cancelled = false;
    const providerId = item.name;
    fetch(`${apiBase}/api/provider-presets`)
      .then(r => readJsonIfOk<{ providers?: CatalogPreset[] }>(r))
      .then((d) => {
        if (cancelled) return;
        if (!d) {
          setBaseUrlChoices(undefined);
          setChoicesStatus("error");
          return;
        }
        const preset = (d.providers ?? []).find(p => p.id === providerId);
        const choices = preset?.baseUrlChoices;
        setBaseUrlChoices(choices);
        setChoicesStatus("ready");
        setEndpointChoice(matchChoiceId(choices, baseUrlRef.current));
      })
      .catch(() => {
        if (cancelled) return;
        setBaseUrlChoices(undefined);
        setChoicesStatus("error");
      });
    return () => { cancelled = true; };
    // Remount per target/provider; the current draft base URL picks the endpoint choice.
  }, [apiBase, item.name]);

  useEffect(() => {
    if (apiBase === undefined) return;
    let active = true;
    let inFlight = false;
    const load = () => {
      // Guarded + bounded: a hung pacing read must never stack or pin the panel.
      if (inFlight) return;
      inFlight = true;
      const bounded = createBoundedFetch(10_000);
      fetch(`${apiBase}/api/provider-request-pacing?name=${encodeURIComponent(item.name)}`, { signal: bounded.signal })
        .then(r => readJsonIfOk<PacingStatus>(r))
        .then(status => { if (active && status) setPacingStatus(status); })
        .catch(() => undefined)
        .finally(() => { bounded.clear(); inFlight = false; });
    };
    load();
    const stop = startVisibilityPoll(load, 2_000);
    return () => { active = false; stop(); };
  }, [apiBase, item.name]);

  const supportsReasoningReplay = !isCatalogProviderId(item.name)
    && canConfigureResponsesReasoningReplay({ adapter, baseUrl, authMode });
  const vertexSettings = isVertexProvider(item) && (item.name === "google-vertex" || adapter.trim() === "google");
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);

  const modelOptions = useMemo(() => {
    const set = new Set(availableModels);
    if (defaultModel.trim()) set.add(defaultModel.trim());
    if (item.defaultModel) set.add(item.defaultModel);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [availableModels, defaultModel, item.defaultModel]);

  const adapterOptions = useMemo(() => {
    const list = [...ADAPTERS] as string[];
    if (adapter && !list.includes(adapter)) list.unshift(adapter);
    return list;
  }, [adapter]);

  const isPreset = isCatalogProviderId(item.name);
  const hasEndpointPicker = choicesStatus === "ready" && !!(baseUrlChoices && baseUrlChoices.length > 0);
  const supportsApiKeyTransport = adapter.trim() === "anthropic" && authMode === "key";
  const openAiState = item.name === "openai" ? openAiAccountProviderState(item) : "invalid";
  const isCanonicalOpenAi = openAiState === "ready" || openAiState === "disabled";
  // Lock plain baseUrl for presets while loading or when there is no picker.
  // On fetch error, keep it editable so allowBaseUrlOverride providers are not trapped.
  const plainBaseUrlLocked = isPreset && choicesStatus !== "error";

  const save = async (): Promise<boolean> => {
    if (!onUpdateProvider) { setMsg({ ok: false, text: t("pws.updatesUnavailable") }); return false; }
    if (modeSaving) return false;
    if (conflict) { setMsg({ ok: false, text: t("pws.draftConflictResolveFirst") }); return false; }
    const saveTarget = targetKey;
    const saveProvider = item.name;
    const saveAuthority = authorityRef.current;
    const submittedSignature = providerSettingsDraftSignature(draft);
    const pacingDraft = draftRequestPacing(draft);
    const nextBaseUrl = hasEndpointPicker
      ? resolvedBaseUrlForChoice(baseUrlChoices, endpointChoice, baseUrl)
      : baseUrl.trim();
    if (!adapter.trim() || !nextBaseUrl) { setMsg({ ok: false, text: t("pws.adapterBaseRequired") }); return false; }
    setSaving(true);
    setMsg(null);
    try {
      const rpmInvalid = pacingRpm.trim() !== "" && (positiveRpm(pacingRpm) === undefined || Number(pacingRpm) > 60_000);
      const delayInvalid = pacingDelay.trim() !== ""
        && (positiveInteger(pacingDelay) === undefined || Number(pacingDelay) > 3_600_000);
      const concurrencyInvalid = pacingConcurrency.trim() !== "" && positiveInteger(pacingConcurrency) === undefined;
      if (concurrencyInvalid) {
        setMsg({ ok: false, text: t("pws.pacingCapInvalid") }); return false;
      }
      if (rpmInvalid || delayInvalid) {
        setMsg({ ok: false, text: t("pws.pacingValueInvalid") }); return false;
      }
      if (Object.entries(keyPacing.keys ?? {}).some(([field, value]) =>
        !Number.isFinite(value) || value <= 0
        || (field !== "requestsPerMinute" && !Number.isSafeInteger(value))
        || (field === "requestsPerMinute" && (value < 1 / 60 || value > 60_000))
        || (field === "minIntervalMs" && value > 3_600_000))) {
        setMsg({ ok: false, text: t("pws.keyLimitInvalid") }); return false;
      }
      if (pacingEnabled && !pacingDraft.requestsPerMinute && !pacingDraft.minIntervalMs && !pacingDraft.maxConcurrentRequests && !pacingDraft.models && !pacingDraft.keys && pacingDraft.keySelection !== "round-robin") {
        setMsg({ ok: false, text: t("pws.pacingRuleRequired") }); return false;
      }
      const { patch } = providerSettingsDeltaPatch(draft, baseline, item, nextBaseUrl);
      if (Object.keys(patch).length === 0) {
        setBaseline(draft);
        draftStore.clear(saveTarget, saveProvider);
        setMsg({ ok: true, text: t("pws.settingsSaved") });
        return true;
      }
      const res = await onUpdateProvider(item.name, patch, formCapture);
      if (authorityRef.current !== saveAuthority) return res.ok;
      // The save belongs to the target that started it. If the dashboard moved while the
      // request was in flight, its result must not be announced or applied on the new target.
      if (targetKeyRef.current !== saveTarget) {
        if (res.ok) {
          const stored = draftStore.read(saveTarget, saveProvider);
          if (stored && providerSettingsDraftSignature(stored.draft) !== submittedSignature) {
            draftStore.writeOwned(saveTarget, saveProvider, draftOwner, { draft: stored.draft, baseline: draft });
          } else {
            draftStore.writeOwned(saveTarget, saveProvider, draftOwner, { draft, baseline: draft });
          }
        }
        return res.ok;
      }
      setMsg(res.ok ? { ok: true, text: t("pws.settingsSaved") } : { ok: false, text: res.error || t("prov.saveFailed") });
      if (res.ok) {
        const currentDraft = draftRef.current;
        setBaseline(draft);
        if (providerSettingsDraftSignature(currentDraft) === submittedSignature) {
          draftStore.writeOwned(saveTarget, saveProvider, draftOwner, { draft, baseline: draft });
        } else {
          draftStore.writeOwned(saveTarget, saveProvider, draftOwner, { draft: currentDraft, baseline: draft });
        }
      }
      return res.ok;
    } finally {
      if (targetKeyRef.current === saveTarget) setSaving(false);
    }
  };

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    if (!onRegisterSave) return;
    onRegisterSave(() => saveRef.current());
    return () => onRegisterSave(null);
  }, [onRegisterSave]);

  const applyAccountMode = async (next: "pool" | "direct", capture = formCapture) => {
    if (modeSaving || saving || next === accountMode) return;
    if (!onUpdateProvider) { setModeMsg({ ok: false, text: t("pws.updatesUnavailable") }); return; }
    const modeTarget = targetKey;
    setModeSaving(true);
    setModeMsg(null);
    try {
      const res = await onUpdateProvider("openai", { codexAccountMode: next }, capture);
      if (targetKeyRef.current !== modeTarget) return;
      if (res.ok) {
        setAccountMode(next);
        setModeMsg({ ok: true, text: t("pws.accountModeSaved") });
      } else {
        setModeMsg({ ok: false, text: res.error || t("pws.accountModeFailed") });
      }
    } catch {
      setModeMsg({ ok: false, text: t("pws.accountModeFailed") });
    } finally {
      setModeSaving(false);
    }
  };

  /**
   * Asks before switching, because flipping modes rebinds running threads and changes quota
   * accounting. Written as a named async function rather than a promise chain inside the
   * handler: a floating `.then` in a JSX handler has no rejection path and is what
   * `no-floating-then-in-jsx-handler` exists to catch.
   */
  const requestAccountMode = async (next: "pool" | "direct") => {
    // A refusal leaves `accountMode` unchanged, and the Select only ever shows that state,
    // so the declined option never appears chosen.
    // Capture before the dialog: the confirmation belongs to the target that opened it.
    const capture = formCapture;
    if (await confirmAction({ message: t("pws.accountModeConfirm") })) await applyAccountMode(next, capture);
  };

  const discard = () => {
    const next = providerSettingsDraftFromItem(item);
    applyDraft(next);
    setBaseline(next);
    setMsg(null);
    authorityRef.current += 1;
    draftStore.clearOwned(targetKey, item.name, draftOwner);
    draftStore.claim(targetKey, item.name, draftOwner, { draft: next, baseline: next });
    setEndpointChoice(matchChoiceId(baseUrlChoices, next.baseUrl));
  };

  const discardRef = useRef(discard);
  useEffect(() => { discardRef.current = discard; });
  useEffect(() => {
    if (!onRegisterDiscard) return;
    onRegisterDiscard(() => discardRef.current());
    return () => onRegisterDiscard(null);
  }, [onRegisterDiscard]);

  /** Explicit conflict resolution: keep the saved values, or rebase the draft onto them. */
  const useSavedValues = () => discard();
  const keepDraft = () => {
    const latest = providerSettingsDraftFromItem(item);
    const rebased = rebaseProviderSettingsDraft(baseline, draft, latest);
    applyDraft(rebased);
    setBaseline(latest);
    setEndpointChoice(matchChoiceId(baseUrlChoices, rebased.baseUrl));
    setMsg(null);
  };

  const endpointLabel = (id: string, fallback: string) => {
    switch (id) {
      case "token-plan": return t("modal.endpoint.tokenPlan");
      case "payg": return t("modal.endpoint.payAsYouGo");
      case "custom": return t("modal.endpoint.custom");
      default: return fallback;
    }
  };

  const addPacingModel = () => {
    const modelId = pacingModelId.trim();
    const rpm = positiveRpm(pacingModelRpm);
    const delay = positiveInteger(pacingModelDelay);
    const cap = positiveInteger(pacingModelConcurrency);
    if ((pacingModelRpm.trim() !== "" && (rpm === undefined || Number(pacingModelRpm) > 60_000))
      || (pacingModelDelay.trim() !== "" && (delay === undefined || Number(pacingModelDelay) > 3_600_000))
      || (pacingModelConcurrency.trim() !== "" && cap === undefined)) {
      setMsg({ ok: false, text: pacingModelConcurrency.trim() !== "" && cap === undefined ? t("pws.pacingCapInvalid") : t("pws.pacingValueInvalid") });
      return;
    }
    if (!modelId || (rpm === undefined && delay === undefined && cap === undefined)) return;
    setPacingModels(current => ({
      ...current,
      [modelId]: {
        ...(rpm !== undefined ? { requestsPerMinute: rpm } : {}),
        ...(delay !== undefined ? { minIntervalMs: delay } : {}),
        ...(cap !== undefined ? { maxConcurrentRequests: cap } : {}),
      },
    }));
    setPacingModelId(""); setPacingModelRpm(""); setPacingModelDelay(""); setPacingModelConcurrency("");
  };

  return (
    <div className="pwi-settings-form">
      <label className="pwi-settings-field">
        <span className="pwi-settings-label"><IconLock style={{ width: 12, height: 12 }} /> {t("pws.providerId")}</span>
        <input className="input" value={item.name} readOnly disabled />
      </label>
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("modal.adapter")}</span>
        {isPreset ? <input className="input" value={adapter} readOnly disabled /> : (
          <Select fullWidth label={t("modal.adapter")} value={adapter} onChange={setAdapter}
            options={adapterOptions.map(a => ({ value: a, label: a }))} />
        )}
      </label>
      <ProviderProtocolPanel
        apiBase={apiBase}
        providerName={item.name}
        savedAdapter={item.adapter}
        draftAdapter={adapter.trim()}
        refreshKey={`${item.baseUrl}|${item.authMode ?? ""}`}
      />
      {hasEndpointPicker ? (
        <>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("modal.endpoint")}</span>
            <Select
              fullWidth
              label={t("modal.endpoint")}
              value={endpointChoice}
              onChange={id => {
                setEndpointChoice(id);
                setBaseUrl(baseUrlForChoice(baseUrlChoices, id, baseUrl));
              }}
              options={baseUrlChoices!.map(c => ({ value: c.id, label: endpointLabel(c.id, c.label) }))}
            />
          </label>
          {endpointChoice === "custom" && (
            <label className="pwi-settings-field">
              <span className="pwi-settings-label">{t("modal.baseUrl")}</span>
              <input className="input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={t("modal.baseUrlPlaceholder")} />
            </label>
          )}
        </>
      ) : (
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("modal.baseUrl")}</span>
          <input className="input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} readOnly={plainBaseUrlLocked} disabled={plainBaseUrlLocked} />
        </label>
      )}
      {vertexSettings && <>
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("modal.vertexProject")}</span>
          <input className="input" value={project} onChange={e => setProject(e.target.value)} />
        </label>
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("modal.vertexLocation")}</span>
          <input className="input" value={location} onChange={e => setLocation(e.target.value)} placeholder="us-central1" />
        </label>
      </>}
      {adapter.trim() === "cursor" && (
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("pws.cursorTransport")}</span>
          <Select
            fullWidth
            label={t("pws.cursorTransport")}
            value={cursorHttpVersion}
            onChange={value => setCursorHttpVersion(value as CursorHttpVersion)}
            options={[
              { value: "http2", label: t("pws.cursorTransportHttp2") },
              { value: "http1.1", label: t("pws.cursorTransportHttp1") },
            ]}
          />
          <span className="pwi-settings-hint">{t("pws.cursorTransportDesc")}</span>
        </label>
      )}
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("pws.cell.defaultModel")}</span>
        {modelOptions.length > 0 ? (
          <Select fullWidth label={t("pws.cell.defaultModel")} value={defaultModel} onChange={setDefaultModel}
            options={[{ value: "", label: t("pws.defaultModelNone") }, ...modelOptions.map(m => ({ value: m, label: m }))]} />
        ) : (
          <input className="input" value={defaultModel} onChange={e => setDefaultModel(e.target.value)} placeholder={t("pws.optionalPlaceholder")} />
        )}
      </label>
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("pws.authMode")}</span>
        {isPreset ? <input className="input" value={authModeLabel(item, t)} readOnly disabled /> : (
          <Select fullWidth label={t("pws.authMode")} value={authMode} onChange={setAuthMode} options={[
            { value: "key", label: t("modal.badge.apiKey") },
            { value: "forward", label: t("pws.auth.chatgptPassthrough") },
            { value: "oauth", label: t("modal.badge.oauth") },
            { value: "local", label: t("modal.badge.local") },
          ]} />
        )}
      </label>
      {isCanonicalOpenAi && (
        <label className="pwi-settings-field" ref={accountModeFieldRef} tabIndex={-1}>
          <span className="pwi-settings-label">{t("codexAuth.accountModeTitle")}</span>
          <Select
            fullWidth
            id="pws-codex-account-mode"
            label={t("codexAuth.accountModeTitle")}
            value={accountMode}
            disabled={modeSaving || saving}
            onChange={value => {
              const next = value as "pool" | "direct";
              if (next === accountMode) return;
              void requestAccountMode(next);
            }}
            options={[
              { value: "pool", label: t("codexAuth.accountModePool") },
              { value: "direct", label: t("codexAuth.accountModeDirect") },
            ]}
          />
          <span className="pwi-settings-hint">
            {accountMode === "direct" ? t("codexAuth.accountModeDirectDesc") : t("codexAuth.accountModePoolDesc")}
          </span>
          {modeSaving && <span className="muted text-label">{t("pws.accountSwitching")}</span>}
          {modeMsg && (
            <span
              role={modeMsg.ok ? "status" : "alert"}
              className={modeMsg.ok ? "pwi-settings-mode-msg pwi-settings-mode-msg--ok" : "pwi-settings-mode-msg pwi-settings-mode-msg--err"}
            >
              {modeMsg.text}
            </span>
          )}
        </label>
      )}
      {supportsApiKeyTransport && (
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("modal.apiKeyTransport")}</span>
          <Select fullWidth label={t("modal.apiKeyTransport")} value={apiKeyTransport}
            onChange={value => setApiKeyTransport(value as "x-api-key" | "bearer")} options={[
              { value: "x-api-key", label: t("modal.apiKeyTransportNative") },
              { value: "bearer", label: t("modal.apiKeyTransportBearer") },
            ]} />
        </label>
      )}
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("pws.note")}</span>
        <textarea className="input pwi-settings-textarea" value={note} onChange={e => setNote(e.target.value)} rows={2} />
      </label>
      <label className="pwi-settings-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={allowPrivateNetwork} onChange={e => setAllowPrivateNetwork(e.target.checked)} />
        <span className="pwi-settings-label">{t("pws.allowPrivateNetwork")}</span>
      </label>
      {supportsReasoningReplay && <ResponsesReasoningReplayControl checked={preserveReasoningReplay} onChange={setPreserveReasoningReplay} />}
      <label className="pwi-settings-field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <input
          type="checkbox"
          checked={liveModels}
          disabled={!liveModelDiscoverySupported}
          onChange={e => setLiveModels(e.target.checked)}
        />
        <span>
          <span className="pwi-settings-label">{t("pws.liveModels")}</span>
          <span className="muted text-label" style={{ display: "block", marginTop: 2 }}>{t("pws.liveModelsDesc")}</span>
        </span>
      </label>
      <section className="pwi-pacing-card" aria-labelledby="pwi-pacing-title">
        <div className="pwi-pacing-head">
          <div><h3 id="pwi-pacing-title">{t("pws.pacingTitle")}</h3><p>{t("pws.pacingDesc")}</p></div>
          <label className="pwi-pacing-toggle"><input type="checkbox" checked={pacingEnabled} onChange={e => setPacingEnabled(e.target.checked)} /> {t("pws.pacingEnabled")}</label>
        </div>
        <div className="pwi-pacing-grid">
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingRpm")}</span><input className="input" type="number" min="0.016667" step="any" value={pacingRpm} onChange={e => setPacingRpm(e.target.value)} placeholder="38" /></label>
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingDelay")}</span><input className="input" type="number" min="1" step="1" value={pacingDelay} onChange={e => setPacingDelay(e.target.value)} placeholder="1600" /></label>
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingConcurrency")}</span><input className="input" type="number" min="1" step="1" value={pacingConcurrency} onChange={e => setPacingConcurrency(e.target.value)} placeholder="8" /></label>
        </div>
        <p className="pwi-settings-hint">{t("pws.pacingSlowerWins")}</p>
        <div className="pwi-pacing-status" aria-live="polite">
          <span><strong>{pacingStatus?.queued ?? 0}</strong> {t("pws.pacingQueued")}</span>
          <span><strong>{pacingStatus?.nextSlotInMs ?? 0} ms</strong> {t("pws.pacingNextSlot")}</span>
          <span><strong>{pacingStatus?.lastModelId ?? t("pws.pacingNone")}</strong> {t("pws.pacingLastModel")}</span>
        </div>
        {authMode !== "oauth" && authMode !== "forward" && <ProviderKeyPacing value={keyPacing} onChange={setKeyPacing} status={pacingStatus?.keys} />}
        <h4>{t("pws.pacingModelOverrides")}</h4>
        <div className="pwi-pacing-grid pwi-pacing-grid--model">
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingModel")}</span><input className="input" list={`pacing-models-${item.name}`} value={pacingModelId} onChange={e => setPacingModelId(e.target.value)} /><datalist id={`pacing-models-${item.name}`}>{availableModels.map(model => <option key={model} value={model} />)}</datalist></label>
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingRpm")}</span><input className="input" type="number" min="0.016667" step="any" value={pacingModelRpm} onChange={e => setPacingModelRpm(e.target.value)} /></label>
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingDelay")}</span><input className="input" type="number" min="1" step="1" value={pacingModelDelay} onChange={e => setPacingModelDelay(e.target.value)} /></label>
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingConcurrency")}</span><input className="input" type="number" min="1" step="1" value={pacingModelConcurrency} onChange={e => setPacingModelConcurrency(e.target.value)} /></label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={addPacingModel}>{t("pws.pacingAdd")}</button>
        </div>
        {Object.entries(pacingModels).length > 0 && <div className="pwi-pacing-overrides">{Object.entries(pacingModels).map(([model, rule]) => <div key={model} className="pwi-pacing-row"><code>{model}</code><span>{[
          rule.requestsPerMinute !== undefined ? `${rule.requestsPerMinute} ${t("pws.pacingRpmUnit")}` : undefined,
          rule.minIntervalMs !== undefined ? `${rule.minIntervalMs} ms` : undefined,
          rule.maxConcurrentRequests !== undefined ? `${rule.maxConcurrentRequests} ${t("pws.pacingCapUnit")}` : undefined,
        ].filter(part => part !== undefined).join(" · ")}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => setPacingModels(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== model)))} aria-label={t("pws.pacingRemoveModel", { model })}>{t("pws.pacingRemove")}</button></div>)}</div>}
      </section>
      {conflict && (
        <div className="pwi-settings-conflict" role="alert">
          <p>{t("pws.draftConflict")}</p>
          {pacingConflictPaths.length > 0 && (
            <div className="pwi-settings-conflict-fields">
              <p>{t("pws.draftConflictFields")}</p>
              <ul>{pacingConflictPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul>
            </div>
          )}
          <div className="pwi-settings-sticky-bar-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={useSavedValues} disabled={saving}>{t("pws.draftConflictUseSaved")}</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={keepDraft} disabled={saving}>{t("pws.draftConflictKeepDraft")}</button>
          </div>
        </div>
      )}
      {dirty && (
        <div className="pwi-settings-sticky-bar">
          <span className="muted">{t("pws.settingsUnsavedBar")} <span className="pwi-settings-target">{t("pws.draftTarget", { target: targetLabel ?? providerDraftTargetLabel(targetKey) })}</span></span>
          <div className="pwi-settings-sticky-bar-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={discard} disabled={saving}>{t("pws.discardSettings")}</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving || modeSaving || conflict}>{saving ? t("pws.saving") : t("pws.saveSettings")}</button>
          </div>
        </div>
      )}
      {msg && (
        <div role={msg.ok ? "status" : "alert"} className={msg.ok ? "pwi-settings-msg pwi-settings-msg--ok" : "pwi-settings-msg pwi-settings-msg--err"}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
