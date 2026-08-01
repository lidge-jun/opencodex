export type InstanceStatus = "pending" | "provisioning" | "awaiting_agent" | "connecting" | "online" | "degraded" | "offline" | "suspending" | "suspended" | "deleting" | "delete_failed" | "deleted";

export interface Instance {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  privateHostname: string;
  status: InstanceStatus;
  createdAt: string;
  updatedAt: string;
}

const demoInstances: Instance[] = [
  {
    id: "a1d31b31-197c-49a8-b3b0-17f0f8cab001",
    ownerId: "demo-user",
    name: "home-server",
    slug: "home-server",
    privateHostname: "a3f9d7c1e2b4.ocxr.internal",
    status: "online",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 12_000).toISOString(),
  },
  {
    id: "a1d31b31-197c-49a8-b3b0-17f0f8cab002",
    ownerId: "demo-user",
    name: "dev-vps",
    slug: "dev-vps",
    privateHostname: "7c12e6f4a5b8.ocxr.internal",
    status: "degraded",
    createdAt: new Date(Date.now() - 172_800_000).toISOString(),
    updatedAt: new Date(Date.now() - 180_000).toISOString(),
  },
];

const demo = import.meta.env.VITE_REMOTE_DEMO === "true";

export interface CurrentUser {
  id: string; name: string; email: string; role: "user" | "admin";
  githubNumericId: string;
  status: "active" | "pending_invite" | "suspended";
}

export interface RemoteAccessProfile {
  passwordSet: boolean;
  e2ee: import("./e2ee").RemoteE2eeEnvelope | null;
}

export interface WorkspaceDevice {
  id: string;
  name: string;
  platform: string;
  signingPublicKey: string;
  ecdhPublicKey: string | null;
  relayOnline: boolean;
  lastSeenAt: string | null;
}

export interface Workspace {
  instance: { id: string; name: string; slug: string; status: "online" | "offline" };
  devices: WorkspaceDevice[];
  limits: { maxSessionsPerDevice: number; maxFrameBytes: number };
}

export interface DeviceAuthorizationRequest {
  id: string;
  userCode: string;
  deviceName: string;
  platform: string;
  expiresAt: string;
  status: "pending" | "approved" | "expired" | "consumed";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

export async function listInstances(): Promise<Instance[]> {
  if (demo) return structuredClone(demoInstances);
  return (await request<{ instances: Instance[] }>("/api/v1/instances")).instances;
}

export async function getInstance(instanceId: string): Promise<Instance> {
  if (demo) {
    const instance = demoInstances.find(item => item.id === instanceId);
    if (!instance) throw new Error("not found");
    return structuredClone(instance);
  }
  return (await request<{ instance: Instance }>(`/api/v1/instances/${instanceId}`)).instance;
}

export async function getCurrentUser(): Promise<CurrentUser> {
  if (demo) return { id: "demo-user", name: "Octo Cat", email: "octocat@example.test", githubNumericId: "1", role: "admin", status: "active" };
  return (await request<{ user: CurrentUser }>("/api/v1/me")).user;
}

export async function getRemoteAccessProfile(): Promise<RemoteAccessProfile> {
  return (await request<{ profile: RemoteAccessProfile }>("/api/v1/remote/profile")).profile;
}

export async function getDeviceAuthorizationRequest(id: string): Promise<DeviceAuthorizationRequest> {
  return (await request<{ request: DeviceAuthorizationRequest }>(`/api/v1/device-links/${id}`)).request;
}

export async function approveDeviceAuthorizationRequest(id: string): Promise<DeviceAuthorizationRequest> {
  return (await request<{ request: DeviceAuthorizationRequest }>(`/api/v1/device-links/${id}/approve`, {
    method: "POST",
    body: "{}",
  })).request;
}

export async function redeemInvite(token: string): Promise<void> {
  if (demo) return;
  await request("/api/v1/invites/redeem", { method: "POST", body: JSON.stringify({ token }) });
}

export async function createInstance(name: string, slug: string): Promise<Instance> {
  if (demo) {
    return {
      id: crypto.randomUUID(), ownerId: "demo-user", name, slug,
      privateHostname: `${crypto.randomUUID().replaceAll("-", "")}.ocxr.internal`,
      status: "awaiting_agent", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
  }
  return (await request<{ instance: Instance }>("/api/v1/instances", { method: "POST", body: JSON.stringify({ name, slug }) })).instance;
}

export async function createPairingCode(instanceId: string): Promise<{ code: string; expiresAt: string }> {
  if (demo) return { code: "7K4M2P9Q6RXC", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  return request(`/api/v1/instances/${instanceId}/pairing-code`, { method: "POST", body: "{}" });
}

export async function openInstance(instanceId: string, password: string): Promise<string> {
  if (demo) return "#demo-instance";
  return (await request<{ url: string }>(`/api/v1/instances/${instanceId}/authorize`, {
    method: "POST",
    body: JSON.stringify({ password }),
  })).url;
}

export async function accessInstance(slug: string, authSecret: string): Promise<string> {
  return (await request<{ url: string }>(`/api/v1/remote/access/${encodeURIComponent(slug)}`, {
    method: "POST",
    body: JSON.stringify({ authSecret }),
  })).url;
}

export async function getWorkspace(): Promise<Workspace> {
  return request<Workspace>("/api/v1/workspace");
}

export async function createTerminalSession(
  deviceId: string,
  commandProfile: import("./e2ee").CommandProfile,
): Promise<{ session: { id: string }; websocketPath: string }> {
  return request("/api/v1/terminal-sessions", {
    method: "POST",
    body: JSON.stringify({ deviceId, commandProfile }),
  });
}

export async function issueToken(instanceId: string): Promise<{ token: string; expiresAt: string }> {
  if (demo) return { token: `ocxr_${"demo".repeat(11)}`, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() };
  return request(`/api/v1/instances/${instanceId}/tokens`, { method: "POST", body: JSON.stringify({ name: "Dashboard token" }) });
}

export async function suspendInstance(instanceId: string): Promise<void> {
  if (demo) return;
  await request(`/api/v1/instances/${instanceId}/suspend`, { method: "POST", body: "{}" });
}

export async function deleteInstance(instanceId: string): Promise<void> {
  if (demo) return;
  await request(`/api/v1/instances/${instanceId}`, { method: "DELETE" });
}
