import type { ManagementContext } from "./context";
import {
  handleGetTelemetryRoute,
  handlePutTelemetryRoute,
} from "../../telemetry/routes";

export async function handleTelemetryRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname === "/api/telemetry" && req.method === "GET") {
    return handleGetTelemetryRoute(ctx);
  }
  if (url.pathname === "/api/telemetry" && req.method === "PUT") {
    return handlePutTelemetryRoute(ctx);
  }
  return null;
}
