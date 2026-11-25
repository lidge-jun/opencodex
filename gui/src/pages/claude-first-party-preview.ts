import { readJsonIfOk } from "../fetch-json";

/** Client for GET /api/claude-code/first-party/preview (catch-up 010, G-002). */
export interface FirstPartyPreview {
  enabled: boolean;
  path: string;
  changes: Array<{ file: "settings.json"; key: string; change: "add" | "update" | "remove" }>;
  applyChecks: string[];
}

/** A refusal the switch itself would answer with; `code` matches the PUT's refusal codes. */
export class FirstPartyPreviewRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "FirstPartyPreviewRefusal";
  }
}

/**
 * Fetch the dry run for turning CLI first-party on. Throws FirstPartyPreviewRefusal for a coded
 * refusal and a plain Error for anything else (network, 5xx, malformed body); the caller then
 * releases the switch and never sends the PUT.
 */
export async function fetchFirstPartyPreview(apiBase: string, enabled: boolean): Promise<FirstPartyPreview> {
  const response = await fetch(`${apiBase}/api/claude-code/first-party/preview?enabled=${enabled ? "true" : "false"}`);
  if (!response.ok) {
    // Only a 409 carries a refusal code the switch itself would answer with.
    const refusal = response.status === 409
      ? await response.json().catch(() => null) as { code?: unknown } | null
      : null;
    if (refusal && typeof refusal.code === "string") throw new FirstPartyPreviewRefusal(refusal.code);
    throw new Error("preview_failed");
  }
  const body = await readJsonIfOk<Partial<FirstPartyPreview>>(response);
  if (!body || typeof body.path !== "string" || !Array.isArray(body.changes)) throw new Error("preview_failed");
  return {
    enabled: body.enabled === true,
    path: body.path,
    changes: body.changes,
    applyChecks: Array.isArray(body.applyChecks) ? body.applyChecks : [],
  };
}
