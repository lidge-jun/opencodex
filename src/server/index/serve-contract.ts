import type { Server } from "bun";
import type { StartServerDeps } from "./startup-warnings";
import { isClaudeInterceptedPath } from "../../claude/intercept/listener";
import type { WsData } from "../ws-bridge";
import {
  isLoopbackHostname,
  type RequestPolicyView,
} from "../auth-cors";
import type { ActiveTurnLease } from "../lifecycle";
import type { OcxConfig } from "../../types";
import type { LiveCallBindings } from "../live-call-bindings";
import type { ManagementApiDeps } from "../management-api";
import type {
  ManagementAuthState,
  ManagementSessionControl,
} from "../management-auth";
import type { PackageTreeIntegrityGuard } from "../../lib/package-tree-integrity";
import type { ReadinessGate } from "../readiness";
import type { WorkflowRefusalLog } from "../workflow-refusal";
import type { AdmittedHttpTurnOptions } from "../admitted-http-turn";

export type ServerIngress = "public" | "unauthenticated-loopback" | "hub-management" | "claude-intercept" | "hub-link" | "local-control";

export function trustedLoopbackForIngress(ingress: ServerIngress, hostname: string): boolean {
  return ingress === "unauthenticated-loopback" || ingress === "local-control"
    || (ingress === "public" && isLoopbackHostname(hostname));
}

/**
 * Routes the Claude intercept TLS listener may reach. Everything else on that socket is relayed
 * to the real upstream by the listener itself, so a request that lands here with another path
 * is a bug, not a client — refuse it.
 */
export function claudeInterceptRouteAllowed(url: URL, req: Request): boolean {
  return isClaudeInterceptedPath(url.pathname, req.method);
}

export interface ServeOptionsContext {
  readonly server: Server<WsData>;
  readonly boundPort: number | null;
  readonly remoteWorkspaceStopping: boolean;

  drainingResponse: (req: Request, policy: RequestPolicyView) => Response;
  ingressForServer: (requestServer: Server<WsData>) => ServerIngress;
  loopbackRouteAllowed: (url: URL, req: Request) => boolean;
  managementIngressRouteAllowed: (url: URL, req: Request) => boolean;
  linkRouteAllowed: (url: URL, req: Request) => boolean;
  /** A key-admitted catalog request; routeProofId is a multi-route readiness proof it carried (src/link/route-proof.ts). */
  onAuthenticatedCatalog: (apiKeyId: string, routeProofId?: string) => void;
  linkPolicy: () => RequestPolicyView;
  packageTreeChangedResponse: (
    req: Request,
    policy: RequestPolicyView,
    message: string,
  ) => Response;
  serverBusyResponse: (
    req: Request,
    resource: string,
    policy: RequestPolicyView,
  ) => Response;
  runAdmittedHttpTurn: (
    req: Request,
    policy: RequestPolicyView,
    work: (lease: ActiveTurnLease) => Promise<Response>,
    refusalLog?: WorkflowRefusalLog,
    options?: AdmittedHttpTurnOptions,
  ) => Promise<Response>;

  config: OcxConfig;
  inboundBodyLimitBytes: number;
  listenPort: number;
  liveCallBindings: LiveCallBindings;
  loadRemoteWorkspaceRuntime: () => Promise<
    typeof import("../../remote-control/workspace-runtime")
  >;
  localAttestationSecret: string;
  loopbackPolicy: () => RequestPolicyView;
  managementApiDeps: ManagementApiDeps;
  managementAuth: ManagementAuthState;
  managementSessionControl: ManagementSessionControl;
  packageTreeIntegrity: PackageTreeIntegrityGuard;
  readinessGate: ReadinessGate;

  deps: StartServerDeps;
  port: number | undefined;
}
