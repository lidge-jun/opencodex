export type ApiPlane = "machine" | "shared";
export type SharedTransport = "same-origin" | "direct" | "relay";

/**
 * The runtime role the server stated in the served document, or null when it said nothing.
 *
 * Read without removing the tag: unlike the session meta, which is consumed once so a
 * credential does not linger in the DOM, the role is non-secret and may be read again.
 */
function runtimeRoleFromDocument(): string | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector('meta[name="opencodex-runtime-role"]');
  return meta?.getAttribute("content")?.trim() || null;
}

/**
 * Did the server say this proxy is running as a connected client?
 *
 * Anything else — standalone, hub, an older server that sends no tag, a separately hosted
 * GUI, the Vite dev server — is treated as "not connected", which is the state that needs
 * no remote-hub work and makes no remote-hub requests.
 */
export function isConnectedRuntime(): boolean {
  return runtimeRoleFromDocument() === "client";
}

/**
 * May this dashboard ask the user to type an admin token?
 *
 * This asks the BIND, not the topology. The server decides whether a typed credential is
 * required with `isApiAuthRequired` — "is the bind hostname non-loopback" — and now states
 * that answer in the served document alongside the role.
 *
 * The role is the wrong predicate, and it was tried first: `standalone` + `hostname:
 * "0.0.0.0"` is an operator who deliberately exposed the dashboard and MUST type the admin
 * token (tests/server/server-management-auth.test.ts, "a non-loopback binding never issues a GUI
 * session from a forged loopback Host"), while a `hub` on loopback still mints its own
 * session. Gating on `role === "hub"` would have hidden the prompt from exactly the
 * operator who needs it.
 *
 * A loopback install mints its own session, so a refusal there is a Host/Origin
 * misconfiguration rather than a missing credential: prompting asks the user a question they
 * did not cause and cannot fix by answering (#3353). The published contract already promises
 * loopback "never asks for a token"
 * (docs-site/src/content/docs/guides/web-dashboard.md, "Sign-in").
 *
 * A missing tag means an older server, a separately hosted GUI, or the Vite dev server; those
 * fall back to the role so a hub dashboard still works against a server that predates the
 * tag, and everything else reads as loopback — the safe default this file already uses.
 */
export function adminTokenPromptAllowed(): boolean {
  if (typeof document !== "undefined") {
    const declared = document
      .querySelector('meta[name="opencodex-management-auth-required"]')
      ?.getAttribute("content")
      ?.trim();
    if (declared === "1") return true;
    if (declared === "0") return false;
  }
  return runtimeRoleFromDocument() === "hub";
}

export interface ApiTarget {
  id: ApiPlane;
  baseUrl: string;
  serverOrigin: string;
  bootstrapPath: string;
  transport: SharedTransport;
}

export interface ApiTargets {
  connected: boolean;
  machine: ApiTarget;
  shared: ApiTarget;
  apiKeyId?: string;
}

export interface MachineStatusV1 {
  mode: "client";
  connected: true;
  machineBase: string;
  sharedBase: string;
  sharedServerOrigin: string;
  managementTransport: "direct" | "relay";
  apiKeyId: string;
  protocolVersion: 1;
  connectedAt: string;
  catalogSyncedAt?: string;
  hubReachability: "unknown" | "online" | "offline" | "unauthorized";
}

function trimBase(value: string): string {
  return value.replace(/\/+$/, "");
}

function absoluteBase(value: string): URL {
  return new URL(value || "/", window.location.href);
}

function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function target(id: ApiPlane, baseUrl: string, serverOrigin: string, transport: SharedTransport): ApiTarget {
  const base = trimBase(baseUrl);
  return { id, baseUrl: base, serverOrigin, bootstrapPath: `${base}/opencodex-session`, transport };
}

export function standaloneApiTargets(initialBase: string): ApiTargets {
  const resolved = absoluteBase(initialBase);
  const baseUrl = trimBase(initialBase);
  return {
    connected: false,
    machine: target("machine", baseUrl, resolved.origin, "same-origin"),
    shared: target("shared", baseUrl, resolved.origin, "same-origin"),
  };
}

function validStatus(value: unknown): value is MachineStatusV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.mode === "client" && row.connected === true && row.protocolVersion === 1
    && (row.managementTransport === "direct" || row.managementTransport === "relay")
    && typeof row.machineBase === "string" && typeof row.sharedBase === "string"
    && typeof row.sharedServerOrigin === "string" && typeof row.apiKeyId === "string"
    && row.apiKeyId.trim().length > 0 && typeof row.connectedAt === "string";
}

export function relayUrlForPath(shared: ApiTarget, path: string): string {
  if (shared.transport !== "relay" || (!path.startsWith("/api/") && path !== "/opencodex-session")) {
    throw new TypeError("path is not eligible for the fixed hub relay");
  }
  if (path.startsWith("//") || path.includes("\\") || /%(?:2f|5c|2e)/i.test(path) || path.includes("#")) {
    throw new TypeError("encoded or authority relay path refused");
  }
  return `${trimBase(shared.baseUrl)}${path}`;
}

export function targetsFromMachineStatus(initialBase: string, status: MachineStatusV1): ApiTargets {
  if (!validStatus(status)) throw new TypeError("machine status response is invalid");
  const initial = standaloneApiTargets(initialBase);
  const machineOrigin = canonicalOrigin(status.machineBase);
  const sharedOrigin = canonicalOrigin(status.sharedServerOrigin);
  if (!machineOrigin || machineOrigin !== initial.machine.serverOrigin || !sharedOrigin) {
    throw new TypeError("machine status target origins are invalid");
  }
  let advertisedShared: URL;
  try { advertisedShared = new URL(status.sharedBase); } catch { throw new TypeError("machine status shared target is invalid"); }
  if (advertisedShared.username || advertisedShared.password || advertisedShared.search || advertisedShared.hash) {
    throw new TypeError("machine status shared target is invalid");
  }
  if (status.managementTransport === "direct") {
    if (advertisedShared.origin !== sharedOrigin || advertisedShared.pathname !== "/") {
      throw new TypeError("machine status direct target is inconsistent");
    }
  } else if (advertisedShared.origin !== machineOrigin || advertisedShared.pathname !== "/api/machine/hub-relay") {
    throw new TypeError("machine status relay target is inconsistent");
  }
  const machine = target("machine", trimBase(initialBase), machineOrigin, "same-origin");
  const shared = status.managementTransport === "relay"
    ? target("shared", `${trimBase(initialBase)}/api/machine/hub-relay`, sharedOrigin, "relay")
    : target("shared", sharedOrigin, sharedOrigin, "direct");
  return { connected: true, machine, shared, apiKeyId: status.apiKeyId };
}

export function apiBaseForPlane(plane: ApiPlane, targets: ApiTargets): string {
  return targets[plane].baseUrl;
}

export async function discoverApiTargets(initialBase: string, signal?: AbortSignal): Promise<ApiTargets> {
  const standalone = standaloneApiTargets(initialBase);
  // Standalone asks nothing.
  //
  // The server states the role in the served document, so a user who never enabled remote
  // hub makes no request to a remote-hub endpoint — not even one that 404s. Discovery used
  // to run unconditionally and infer standalone FROM that 404, which meant every dashboard
  // load probed a feature the operator had not turned on.
  //
  // A missing tag means standalone too: an older server, a separately hosted GUI, or the
  // Vite dev server all read as "no remote topology", which is the safe default.
  if (runtimeRoleFromDocument() !== "client") return standalone;
  let response: Response;
  try {
    response = await fetch(`${standalone.machine.baseUrl}/api/machine/status`, { signal, cache: "no-store" });
  } catch (error) {
    throw new Error("local machine plane unavailable", { cause: error });
  }
  if (response.status === 404) return standalone;
  if (!response.ok) throw new Error(`local machine plane refused discovery (${response.status})`);
  const body = await response.json().catch(() => null);
  if (!validStatus(body)) throw new Error("local machine plane returned invalid status");
  return targetsFromMachineStatus(initialBase, body);
}
