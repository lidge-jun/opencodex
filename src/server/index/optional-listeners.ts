import type { Server } from "bun";
import type { OcxConfig } from "../../types";
import {
  createClaudeInterceptLifecycle,
  type ClaudeInterceptLifecycle,
} from "./claude-intercept-lifecycle";
import {
  createLinkListenerLifecycle,
  linkRouteAllowed,
  type LinkListenerDeps,
  type LinkListenerLifecycle,
  type LinkListenerStatus,
} from "./link-listener";
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
  linkStatus(): LinkListenerStatus;
  start(ctx: OptionalListenerStartContext<T>): void;
  ensureStarted(): Promise<void>;
  close(): Promise<void>;
  registerSupervisorStop(stop: () => Promise<void>): () => void;
  stop(): Promise<void>;
}

export function createOptionalListenerSet<T>(linkDeps: LinkListenerDeps = {}): OptionalListenerSet<T> {
  const claudeIntercept: ClaudeInterceptLifecycle<T> = createClaudeInterceptLifecycle<T>();
  const linkListener: LinkListenerLifecycle<T> = createLinkListenerLifecycle<T>(linkDeps);
  let supervisorStop: (() => Promise<void>) | undefined;

  return {
    ingressOf(server) {
      if (linkListener.ownsListener(server)) return "hub-link";
      if (claudeIntercept.ownsListener(server)) return "claude-intercept";
      return undefined;
    },
    linkRouteAllowed,
    linkAdmissionKeyIds: () => linkListener.linkAdmissionKeyIds(),
    linkStatus: () => linkListener.status(),
    start(ctx) {
      linkListener.start({ dispatch: ctx.dispatch, maxRequestBodySize: ctx.maxRequestBodySize });
      claudeIntercept.start({
        config: ctx.config,
        publicPort: ctx.publicPort,
        requestedPort: ctx.requestedPort,
        maxRequestBodySize: ctx.maxRequestBodySize,
        dispatch: ctx.dispatch,
      });
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
      if (failure) throw failure;
    },
  };
}
