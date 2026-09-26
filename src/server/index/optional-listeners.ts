import type { Server } from "bun";
import type { OcxConfig } from "../../types";
import {
  createClaudeInterceptLifecycle,
  type ClaudeInterceptLifecycle,
} from "./claude-intercept-lifecycle";
import { createChatgptUnblockLifecycle, type ChatgptUnblockLifecycle } from "./chatgpt-unblock-lifecycle";
import {
  createLinkListenerLifecycle,
  linkRouteAllowed,
  type LinkListenerDeps,
  type LinkListenerLifecycle,
  type LinkListenerStatus,
} from "./link-listener";
import { createLinkSupervisor, type LinkSupervisor } from "../../link/supervisor";
import { saveConfigPreservingClaudeCode } from "../../config/live-reconcile";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
export { LINK_INGRESS_HOSTNAME } from "./link-listener";
import type { ServerIngress } from "./serve-options";

export interface OptionalListenerStartContext<T> {
  config: OcxConfig;
  publicPort: number;
  requestedPort?: number;
  maxRequestBodySize: number;
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
}

export interface OptionalListenerSet<T> {
  ingressOf(server: Server<T>): ServerIngress | undefined;
  linkRouteAllowed(url: URL, req: Request): boolean;
  linkAdmissionKeyIds(): ReadonlySet<string>;
  onAuthenticatedCatalog(listener: (apiKeyId: string) => void): () => void;
  notifyAuthenticatedCatalog(apiKeyId: string): void;
  status(): LinkListenerStatus;
  linkStatus(): LinkListenerStatus;
  linkSupervisor(): LinkSupervisor;
  start(ctx: OptionalListenerStartContext<T>): void;
  ensureStarted(): Promise<void>;
  close(): Promise<void>;
  registerSupervisorStop(stop: () => Promise<void>): () => void;
  stop(): Promise<void>;
}

export function createOptionalListenerSet<T>(linkDeps: LinkListenerDeps = {}): OptionalListenerSet<T> {
  const claudeIntercept: ClaudeInterceptLifecycle<T> = createClaudeInterceptLifecycle<T>();
  // Opt-in ChatGPT desktop send-unblock listener; like the Claude intercept it binds its own
  // loopback port, starts fire-and-forget and degrades to a warning.
  const chatgptUnblock: ChatgptUnblockLifecycle = createChatgptUnblockLifecycle<T>();
  const linkListener: LinkListenerLifecycle<T> = createLinkListenerLifecycle<T>(linkDeps);
  let activeConfig: OcxConfig | undefined;
  const supervisor = createLinkSupervisor({
    apiKeys: () => activeConfig?.apiKeys ?? [],
    revokeApiKey: id => {
      if (!activeConfig) return false;
      const before = activeConfig.apiKeys ?? [];
      if (!before.some(key => key.id === id)) return false;
      activeConfig.apiKeys = before.filter(key => key.id !== id);
      try {
        saveConfigPreservingClaudeCode(activeConfig);
        reconcileLiveStateStores();
      } catch (error) {
        activeConfig.apiKeys = before;
        throw error;
      }
      return true;
    },
  });
  let unregisterSupervisorAdmission: (() => void) | undefined;
  let supervisorStop: (() => Promise<void>) | undefined;

  return {
    ingressOf(server) {
      if (linkListener.ownsListener(server)) return "hub-link";
      if (claudeIntercept.ownsListener(server)) return "claude-intercept";
      return undefined;
    },
    linkRouteAllowed,
    linkAdmissionKeyIds: () => linkListener.linkAdmissionKeyIds(),
    onAuthenticatedCatalog: listener => linkListener.onAuthenticatedCatalog(listener),
    notifyAuthenticatedCatalog: apiKeyId => linkListener.notifyAuthenticatedCatalog(apiKeyId),
    status: () => linkListener.status(),
    linkStatus: () => linkListener.status(),
    linkSupervisor: () => supervisor,
    start(ctx) {
      activeConfig = ctx.config;
      linkListener.start({ dispatch: ctx.dispatch, maxRequestBodySize: ctx.maxRequestBodySize });
      unregisterSupervisorAdmission ??= linkListener.onAuthenticatedCatalog(apiKeyId => supervisor.notifyAuthenticatedRequest?.(apiKeyId));
      supervisor.start();
      supervisorStop = () => supervisor.stop();
      claudeIntercept.start({
        config: ctx.config,
        publicPort: ctx.publicPort,
        requestedPort: ctx.requestedPort,
        maxRequestBodySize: ctx.maxRequestBodySize,
        dispatch: ctx.dispatch,
      });
      chatgptUnblock.start({ config: ctx.config, publicPort: ctx.publicPort });
    },
    ensureStarted: () => linkListener.ensureStarted(),
    close: () => linkListener.close(),
    registerSupervisorStop(stop) {
      supervisorStop = stop;
      return () => {
        if (supervisorStop === stop) supervisorStop = undefined;
      };
    },
    async stop() {
      let failure: unknown;
      if (supervisorStop) {
        try { await supervisorStop(); } catch (error) { failure = error; }
      }
      try { await linkListener.stop(); } catch (error) { failure ??= error; }
      try { await claudeIntercept.stop(); } catch (error) { failure ??= error; }
      try { await chatgptUnblock.stop(); } catch (error) { failure ??= error; }
      unregisterSupervisorAdmission?.();
      unregisterSupervisorAdmission = undefined;
      if (failure) throw failure;
    },
  };
}
