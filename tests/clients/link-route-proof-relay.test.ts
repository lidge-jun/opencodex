import { expect, test } from "bun:test";
import { forwardLinkRequestHeaders, HOME_INITIATED_LINK_TUNNEL, relayLinkDataRequest } from "../../src/client/link-relay";
import { LINK_ROUTE_PROOF_HEADER } from "../../src/link/route-proof";

const LINK_KEY = "ocx_data_" + "d".repeat(40);
const PROOF = "0123456789abcdef0123456789abcdef";

/**
 * A multi-route readiness proof travels as one ordinary request header on the Child's own
 * GET /v1/catalog; the Bun Child relay must carry it to the Home unchanged, next to the link key.
 */
test("the Child relay forwards the route proof header and still replaces caller credentials", () => {
  const forwarded = forwardLinkRequestHeaders(new Headers({ [LINK_ROUTE_PROOF_HEADER]: PROOF, Authorization: "Bearer caller" }), LINK_KEY, "/v1/catalog");
  expect(forwarded.get(LINK_ROUTE_PROOF_HEADER)).toBe(PROOF);
  expect(forwarded.get("authorization")).toBe("Bearer " + LINK_KEY);
});

test("a relayed catalog GET reaches the Home with the proof header through the Home-initiated gate", async () => {
  const sent: Headers[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => { sent.push(new Headers(init?.headers)); return Response.json({ models: [] }); }) as unknown as typeof fetch;
  const response = await relayLinkDataRequest(new Request("http://127.0.0.1:4100/v1/catalog", { headers: { [LINK_ROUTE_PROOF_HEADER]: PROOF } }),
    { tunnelPort: 12000, admissionKey: LINK_KEY }, { fetchImpl, tunnel: HOME_INITIATED_LINK_TUNNEL });
  expect(response.status).toBe(200);
  expect(sent[0]?.get(LINK_ROUTE_PROOF_HEADER)).toBe(PROOF);
});
