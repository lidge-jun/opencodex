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
  const body = await response.json().catch(() => null) as Partial<FirstPartyPreview> & { code?: unknown } | null;
  if (!response.ok) {
    if (body && typeof body.code === "string" && response.status === 409) throw new FirstPartyPreviewRefusal(body.code);
    throw new Error("preview_failed");
  }
  if (!body || typeof body.path !== "string" || !Array.isArray(body.changes)) throw new Error("preview_failed");
  return {
    enabled: body.enabled === true,
    path: body.path,
    changes: body.changes,
    applyChecks: Array.isArray(body.applyChecks) ? body.applyChecks : [],
  };
}
