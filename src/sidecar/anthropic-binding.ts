import type { OcxConfig } from "../types";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";
import { configuredAnthropicInstance } from "../providers/anthropic-instance";
import { anthropicRoutingFor } from "../oauth/anthropic-routing";
import { resolveAnthropicModelRouteForInstance, routeCandidates } from "../oauth/anthropic-model-routes";
import type { OAuthAccessSnapshot } from "../oauth";
import { AnthropicHelperUnavailableError } from "./auth";
import { captureAnthropicPhysicalSendOwnership, anthropicPhysicalSendOwnershipIsCurrent } from "../oauth/anthropic-send-ownership";
import { recordAnthropicAccountQuotaFromHeadersForInstance } from "../providers/quota/account-cache";
import { captureConfigGeneration } from "../lib/state-store-sweeper";
import { getAccountCredentialWithStatus } from "../oauth/store";
import { bindAnthropicRefusalCredentialForSend } from "../oauth/anthropic-account-refusal";

/** The one Messages URL builder shared by helper executors and the physical-send fence. */
export function anthropicHelperMessagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/messages`;
}

/**
 * Select the helper's account the way the legacy sidecar token path does: a read of the pool's
 * selection for this model route, with no promotion. A helper never moves the active pointer and
 * never consumes an operator's one-dispatch manual choice; the physical send is still fenced by
 * the captured target/config, the account's credential generation and its send ownership.
 */
export async function resolveAnthropicHelperSnapshot(config: OcxConfig, instance: AnthropicInstanceId, model: string): Promise<OAuthAccessSnapshot> {
  const target = config.providers[instance]?.baseUrl;
  const assertConfigured = () => {
    const provider = config.providers[instance];
    if (!provider || provider.disabled || provider.authMode !== "oauth" || provider.adapter !== "anthropic"
      || configuredAnthropicInstance(config, instance) !== instance || provider.baseUrl !== target) {
      throw new AnthropicHelperUnavailableError(instance);
    }
  };
  assertConfigured();
  const routing = anthropicRoutingFor(instance);
  for (let attempt = 0; attempt < 3; attempt++) {
    const route = resolveAnthropicModelRouteForInstance(instance, config, model);
    if (route.error) throw new AnthropicHelperUnavailableError(instance);
    const selection = routing.resolveAnthropicAccountForSession(null, config, Date.now(), route.decision, model);
    if (!selection.accountId) throw new AnthropicHelperUnavailableError(instance);
    const snapshot = await routing.getAnthropicPoolAccessSnapshot(selection.accountId);
    assertConfigured();
    const current = resolveAnthropicModelRouteForInstance(instance, config, model);
    if (current.error || JSON.stringify(current.decision) !== JSON.stringify(route.decision)) continue;
    if (snapshot.provider === instance && snapshot.accountId === selection.accountId) return snapshot;
  }
  throw new AnthropicHelperUnavailableError(instance);
}

/** One physical helper send; reset replays call this boundary again with the same snapshot. */
export async function fetchAnthropicHelper(
  config: OcxConfig, snapshot: OAuthAccessSnapshot, model: string,
  capturedTarget: string, url: string, init: RequestInit,
): Promise<Response> {
  const instance = snapshot.provider;
  if (instance !== "anthropic" && instance !== "anthropic2") throw new Error("Invalid Anthropic helper instance");
  const row = config.providers[instance];
  const live = getAccountCredentialWithStatus(instance, snapshot.accountId);
  if (!row || row.disabled || row.authMode !== "oauth" || row.adapter !== "anthropic"
    || configuredAnthropicInstance(config, instance) !== instance || row.baseUrl !== capturedTarget
    || url !== anthropicHelperMessagesUrl(capturedTarget) || !live || live.paused || live.needsReauth
    || new Headers(init.headers).get("authorization") !== `Bearer ${snapshot.accessToken}`) {
    throw new AnthropicHelperUnavailableError(instance);
  }
  const route = resolveAnthropicModelRouteForInstance(instance, config, model);
  const routing = anthropicRoutingFor(instance);
  if (route.error || !routeCandidates(routing.getEligibleAnthropicAccounts(Date.now(), model), route.decision).includes(snapshot.accountId)) {
    throw new AnthropicHelperUnavailableError(instance);
  }
  const owner = captureAnthropicPhysicalSendOwnership(snapshot);
  if (!owner) throw new AnthropicHelperUnavailableError(instance);
  const writer = captureConfigGeneration();
  const response = await fetch(url, init);
  if (anthropicPhysicalSendOwnershipIsCurrent(owner)) {
    recordAnthropicAccountQuotaFromHeadersForInstance(instance, snapshot.accountId, response.headers, writer, response.status, model);
    bindAnthropicRefusalCredentialForSend(response, owner);
  }
  return response;
}
