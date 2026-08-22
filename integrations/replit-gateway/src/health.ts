import { GATEWAY_CONTRACT_VERSION } from "./constants";

export function createHealthzResponse(): Response {
  return Response.json({
    status: "ok",
    contractVersion: GATEWAY_CONTRACT_VERSION,
  });
}
