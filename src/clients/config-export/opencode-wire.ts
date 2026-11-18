import { captureRouteStaticPolicy, previewRouteModel } from "../../router";
import { nativeChatDeclineReason } from "../../server/chat-native-eligibility";
import type { OcxConfig } from "../../types";
import type { OpencodeCatalogModel } from "./contracts";

/** Prefer Chat only when it preserves the wire of a direct, native-eligible route. */
export function opencodeModelUsesChat(model: OpencodeCatalogModel, config: OcxConfig): boolean {
  if (model.native || !model.provider || !model.id || !model.namespaced.startsWith(`${model.provider}/`)) return false;
  try {
    const route = previewRouteModel(config, model.namespaced);
    if (route.routeKind !== "explicit-provider" || route.routeReason !== "explicit-provider-namespace"
      || route.providerName !== model.provider || route.modelId !== model.id
      || route.staticPolicy.model.adapter !== "openai-chat") return false;
    // A registry default may depend on the incoming protocol. Matching Chat must not change
    // an otherwise Responses upstream into a Chat upstream just to enable passthrough.
    const chat = captureRouteStaticPolicy(route.providerName, route.modelId, route.provider,
      route.staticPolicy.effectiveAlias, "chat");
    return chat.model.adapter === "openai-chat"
      && nativeChatDeclineReason({ ...route, provider: { ...route.provider, adapter: chat.model.adapter } }, {}) === undefined;
  } catch {
    // A stale catalog or a route that cannot currently resolve gives no native wire guarantee.
    return false;
  }
}
