import { useState } from "react";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import type { CompletionProbeStatus, CompletionTestResult } from "./ProviderCompletionTest";

export interface CompletionProbeSnapshot {
  epoch: number;
  model: string;
  status: CompletionProbeStatus;
  result?: CompletionTestResult | null;
  error?: string | null;
}

export interface ProviderProbeController {
  connectionProbeKey: string;
  completionModels: string[];
  probeEpoch: number;
  selectedModel: string;
  completionProbe: CompletionProbeSnapshot | null;
  reverifyModel: string | null;
  selectModel: (next: string) => void;
  reportStatus: (state: {
    status: CompletionProbeStatus;
    model: string;
    result?: CompletionTestResult | null;
    error?: string | null;
  }) => void;
  clearIfTesting: () => void;
}

export function buildConnectionProbeKey(
  apiBase: string | undefined,
  item: WorkspaceItem,
  connectionIdentity?: string,
  mutationRevision = 0,
): string {
  return JSON.stringify([
    apiBase ?? null,
    item.name,
    item.adapter,
    item.baseUrl,
    item.authMode ?? null,
    item.apiKeyTransport ?? null,
    item.upstreamHttpVersion ?? null,
    item.requestPacing ?? null,
    item.liveModels ?? null,
    item.disabled === true,
    item.hasApiKey === true,
    item.hasHeaders === true,
    item.allowPrivateNetwork === true,
    item.keyOptional === true,
    item.activeNeedsReauth === true,
    connectionIdentity ?? null,
    mutationRevision,
  ]);
}

export function buildCompletionModels(item: WorkspaceItem, availableModels: readonly string[] = []): string[] {
  return [
    ...new Set([
      ...(item.models ?? []),
      ...availableModels,
      ...(item.defaultModel ? [item.defaultModel] : []),
    ]),
  ];
}

export function useProviderProbeState(
  item: WorkspaceItem,
  apiBase: string | undefined,
  connectionIdentity: string | undefined,
  availableModels: readonly string[] = [],
  mutationRevision = 0,
): ProviderProbeController {
  const connectionProbeKey = buildConnectionProbeKey(apiBase, item, connectionIdentity, mutationRevision);
  const completionModels = buildCompletionModels(item, availableModels);

  const [seenProvider, setSeenProvider] = useState(item.name);
  const [seenProbeKey, setSeenProbeKey] = useState(connectionProbeKey);
  const [probeEpoch, setProbeEpoch] = useState(0);
  const [selectedModel, setSelectedModel] = useState("");
  const [completionProbe, setCompletionProbe] = useState<CompletionProbeSnapshot | null>(null);
  const [reverifyState, setReverifyState] = useState<{ model: string; invalidated: boolean } | null>(null);

  // Render-time adjustments keep the probe state consistent even while Overview is unmounted on another tab.
  if (seenProvider !== item.name) {
    setSeenProvider(item.name);
    setSeenProbeKey(connectionProbeKey);
    setProbeEpoch(epoch => epoch + 1);
    if (selectedModel !== "") setSelectedModel("");
    if (completionProbe !== null) setCompletionProbe(null);
    if (reverifyState !== null) setReverifyState(null);
  } else {
    const modelRemoved = selectedModel !== "" && !completionModels.includes(selectedModel);
    const probeModelRemoved = completionProbe !== null
      && completionProbe.model !== ""
      && !completionModels.includes(completionProbe.model);
    const reverifyModelRemoved = reverifyState !== null && !completionModels.includes(reverifyState.model);

    if (modelRemoved || probeModelRemoved || reverifyModelRemoved) {
      setProbeEpoch(epoch => epoch + 1);
      if (modelRemoved) setSelectedModel("");
      if (completionProbe !== null) setCompletionProbe(null);
      if (reverifyState !== null) setReverifyState(null);
    }

    if (seenProbeKey !== connectionProbeKey) {
      setSeenProbeKey(connectionProbeKey);
      setProbeEpoch(epoch => epoch + 1);
      if (completionProbe !== null) setCompletionProbe(null);
      if (reverifyState !== null && !reverifyState.invalidated && !reverifyModelRemoved) {
        setReverifyState({ ...reverifyState, invalidated: true });
      }
    } else if (completionProbe !== null && completionProbe.epoch !== probeEpoch) {
      setProbeEpoch(epoch => epoch + 1);
      setCompletionProbe(null);
    }
  }

  const activeSelectedModel = completionModels.includes(selectedModel) ? selectedModel : "";
  const reverifyModel = reverifyState?.invalidated === true
    && completionModels.includes(reverifyState.model)
    && (completionProbe === null || completionProbe.status === "untested")
    ? reverifyState.model
    : null;

  return {
    connectionProbeKey,
    completionModels,
    probeEpoch,
    selectedModel: activeSelectedModel,
    completionProbe,
    reverifyModel,
    selectModel(next: string) {
      if (next === activeSelectedModel) return;
      setSelectedModel(next);
      setProbeEpoch(epoch => epoch + 1);
      setCompletionProbe(null);
      setReverifyState(null);
    },
    reportStatus(next) {
      setCompletionProbe({
        epoch: probeEpoch,
        model: next.model,
        status: next.status,
        result: next.result ?? null,
        error: next.error ?? null,
      });
      if (next.status === "failed") {
        setReverifyState({ model: next.model, invalidated: false });
      } else if (next.status === "ok" || next.status === "not-applicable") {
        setReverifyState(null);
      }
    },
    clearIfTesting() {
      if (completionProbe?.status === "testing") {
        setProbeEpoch(epoch => epoch + 1);
        setCompletionProbe(null);
      }
    },
  };
}
