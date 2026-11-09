import type { ManagementContext } from "./context";
import {
  handleGetTelemetryRoute,
  handlePutTelemetryRoute,
} from "../../telemetry/routes";

export async function handleTelemetryRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname.startsWith("/api/telemetry/profile")) {
    return handleTelemetryProfileRoutes(ctx);
  }
  if (url.pathname === "/api/telemetry" && req.method === "GET") {
    return handleGetTelemetryRoute(ctx);
  }
  if (url.pathname === "/api/telemetry" && req.method === "PUT") {
    return handlePutTelemetryRoute(ctx);
  }
  return null;
}

/** The opt-in public profile; its handlers load only when one of these paths is requested. */
async function handleTelemetryProfileRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname === "/api/telemetry/profile" && req.method === "GET") {
    return (await import("../../telemetry/profile/routes")).handleGetProfileRoute(ctx);
  }
  if (url.pathname === "/api/telemetry/profile" && req.method === "POST") {
    return (await import("../../telemetry/profile/routes")).handlePostProfileRoute(ctx);
  }
  if (url.pathname === "/api/telemetry/profile" && req.method === "DELETE") {
    return (await import("../../telemetry/profile/routes")).handleDeleteProfileRoute(ctx);
  }
  if (url.pathname === "/api/telemetry/profile/rank" && req.method === "GET") {
    return (await import("../../telemetry/profile/routes")).handleGetProfileRankRoute(ctx);
  }
  return null;
}
