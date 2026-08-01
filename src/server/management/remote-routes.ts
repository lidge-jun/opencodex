import {
  activateRemoteInstance,
  cancelRemoteLink,
  changeRemotePassword,
  createRemotePairingCode,
  disconnectRemoteDevice,
  getRemoteStatus,
  setRemotePassword,
  startRemoteLink,
} from "../../remote/client";
import {
  remoteRelayAgentStatus,
  startRemoteRelayAgent,
  stopRemoteRelayAgent,
} from "../../remote/agent";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "remote request failed";
}

export async function handleRemoteRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname === "/api/remote/status" && req.method === "GET") {
    return jsonResponse({ ...await getRemoteStatus(), agent: remoteRelayAgentStatus() }, 200, req, config);
  }
  if (url.pathname === "/api/remote/link" && req.method === "POST") {
    try {
      return jsonResponse(await startRemoteLink(), 201, req, config);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400, req, config);
    }
  }
  if (url.pathname === "/api/remote/link/cancel" && req.method === "POST") {
    return jsonResponse(await cancelRemoteLink(), 200, req, config);
  }
  if (url.pathname === "/api/remote/password" && req.method === "PUT") {
    try {
      const body = await req.json() as { password?: unknown };
      if (typeof body.password !== "string") throw new Error("remote password is required");
      const status = await setRemotePassword(body.password);
      const agent = status.state === "connected" && status.instance
        ? await startRemoteRelayAgent()
        : remoteRelayAgentStatus();
      return jsonResponse({ ...status, agent }, 200, req, config);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400, req, config);
    }
  }
  if (url.pathname === "/api/remote/password" && req.method === "PATCH") {
    try {
      const body = await req.json() as { oldPassword?: unknown; newPassword?: unknown };
      if (typeof body.oldPassword !== "string" || typeof body.newPassword !== "string") {
        throw new Error("old and new remote passwords are required");
      }
      return jsonResponse(await changeRemotePassword(body.oldPassword, body.newPassword), 200, req, config);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400, req, config);
    }
  }
  if (url.pathname === "/api/remote/activate" && req.method === "POST") {
    try {
      const body = await req.json() as { name?: unknown; slug?: unknown };
      if (typeof body.name !== "string" || typeof body.slug !== "string") {
        throw new Error("remote name and domain are required");
      }
      const status = await activateRemoteInstance(body.name, body.slug);
      const agent = await startRemoteRelayAgent();
      return jsonResponse({ ...status, agent }, 202, req, config);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400, req, config);
    }
  }
  if (url.pathname === "/api/remote/agent/start" && req.method === "POST") {
    const agent = await startRemoteRelayAgent();
    return jsonResponse({ ...await getRemoteStatus(), agent }, agent.running ? 200 : 409, req, config);
  }
  if (url.pathname === "/api/remote/pairing-code" && req.method === "POST") {
    try {
      return jsonResponse(await createRemotePairingCode(), 201, req, config);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 409, req, config);
    }
  }
  if (url.pathname === "/api/remote/device" && req.method === "DELETE") {
    try {
      stopRemoteRelayAgent();
      return jsonResponse({ ...await disconnectRemoteDevice(), agent: remoteRelayAgentStatus() }, 200, req, config);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 502, req, config);
    }
  }
  return null;
}
