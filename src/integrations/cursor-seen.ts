/**
 * Remember the last time a Cursor client asked this proxy for its model list.
 *
 * The Integrations page cannot read Cursor's own settings (and must not write them), so
 * "is Cursor pointed at me?" is answered from our side: Cursor's local-agent runtime sends
 * `User-Agent: Cursor/<version>` on `GET /v1/models`. Only that header value and a
 * timestamp are kept, in memory, so a proxy restart forgets it and the card says so.
 */
// Attacker-controlled header: accept only the shape Cursor sends and keep it short.
const CURSOR_USER_AGENT = /^Cursor\/[\w.+-]{1,40}$/;

export interface CursorSeen {
  at: number;
  userAgent: string;
}

let last: CursorSeen | null = null;

export function recordCursorSeen(headers: Headers, now = Date.now()): void {
  const userAgent = headers.get("user-agent")?.trim() ?? "";
  if (!CURSOR_USER_AGENT.test(userAgent)) return;
  last = { at: now, userAgent };
}

export function cursorLastSeen(): CursorSeen | null {
  return last ? { ...last } : null;
}

export function resetCursorSeenForTests(): void {
  last = null;
}
