import type { ProviderAdapter } from "../../../src/adapters/base";
import type { AdapterWire } from "../../../src/adapters/contracts";
import { createCursorRequest } from "../../../src/adapters/cursor/request-builder";
import type { OcxParsedRequest } from "../../../src/types";
import { withTestTranslatorBudget } from "../translator-budget";

export interface ToolWireDriver {
  observeOutbound(adapter: ProviderAdapter, parsed: OcxParsedRequest): Promise<string>;
}

async function observeHttpOutbound(adapter: ProviderAdapter, parsed: OcxParsedRequest): Promise<string> {
  const testAdapter = withTestTranslatorBudget(adapter);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ jwt: "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDB9." }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  try {
    const request = await testAdapter.buildRequest(parsed);
    return request.body;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const httpDriver: ToolWireDriver = { observeOutbound: observeHttpOutbound };

export const TOOL_WIRE_DRIVERS = {
  "openai-chat": httpDriver,
  anthropic: httpDriver,
  google: httpDriver,
  "command-code": httpDriver,
  kiro: httpDriver,
  "openai-responses": httpDriver,
  cursor: {
    async observeOutbound(_adapter, parsed) {
      return JSON.stringify(createCursorRequest(parsed));
    },
  },
} satisfies Record<AdapterWire, ToolWireDriver>;
