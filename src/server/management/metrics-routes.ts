import type { ManagementContext } from "./context";

export function handleMetricsRoutes(ctx: ManagementContext): Response | null {
  if (ctx.url.pathname === "/api/metrics" && ctx.req.method === "GET") {
    if (!ctx.deps.requestMetrics) {
      return Response.json({ error: { code: "not_found", message: "metrics export is disabled" } }, {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return new Response(ctx.deps.requestMetrics.snapshot(), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain;version=0.0.4",
      },
    });
  }
  return null;
}
