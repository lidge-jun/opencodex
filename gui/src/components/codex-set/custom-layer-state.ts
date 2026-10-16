import type { CustomLayerDto } from "../../pages/codex-set-prompt";

/**
 * Client-side validation for a custom layer, mirroring the route rules so the
 * user sees the problem while typing rather than on Save.
 *
 * The server enforces every one of these independently. Client validation is
 * courtesy; /api/codex-prompt is the boundary.
 */
export const MAX_LAYERS = 32;
export const MAX_TITLE_CHARS = 80;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_COMPOSED_BYTES = 128 * 1024;

export function utf8Length(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Tabs and CRLF are normalized rather than rejected - four spaces and LF. The
 * character set is restricted because a measured Bun.TOML.parse defect makes
 * local verification untrustworthy, so the encoder is kept to three unambiguous
 * escapes (devlog 010).
 */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
}

export interface CharacterFinding { position: number }

/**
 * Control characters other than newline cannot be encoded safely, and neither can
 * an unpaired surrogate: it is not a Unicode scalar value, so it has no UTF-8
 * encoding at all. The server refuses both, and mirroring it here is what keeps
 * Save from staying enabled on text that could only fail after submission.
 */
export function findInvalidCharacter(body: string): CharacterFinding | null {
  let position = 0;
  for (const ch of body) {
    const cp = ch.codePointAt(0)!;
    if (ch !== "\n" && (cp < 0x20 || cp === 0x7f)) return { position };
    // `for...of` yields a lone surrogate as its own unit; a valid pair arrives
    // already combined, above 0xffff.
    if (cp >= 0xd800 && cp <= 0xdfff) return { position };
    position += 1;
  }
  return null;
}

export type DraftProblem =
  | { kind: "title-empty" }
  | { kind: "title-too-long"; length: number }
  | { kind: "title-multiline" }
  | { kind: "body-too-large"; bytes: number }
  | { kind: "composed-too-large"; bytes: number }
  | { kind: "invalid-character"; position: number };

export interface Draft {
  id: string | null;
  title: string;
  body: string;
  enabled: boolean;
}

/**
 * Returns the first blocking problem, or null. Lint findings are NOT problems:
 * they are advisory and must never disable Save.
 */
export function validateDraft(draft: Draft, others: readonly CustomLayerDto[]): DraftProblem | null {
  const title = draft.title;
  if (title.trim().length === 0) return { kind: "title-empty" };
  if (title.length > MAX_TITLE_CHARS) return { kind: "title-too-long", length: title.length };
  if (/[\r\n]/.test(title)) return { kind: "title-multiline" };

  const body = normalizeBody(draft.body);
  const bodyBytes = utf8Length(body);
  if (bodyBytes > MAX_BODY_BYTES) return { kind: "body-too-large", bytes: bodyBytes };

  const invalid = findInvalidCharacter(body);
  if (invalid) return { kind: "invalid-character", position: invalid.position };

  // Composed size is what the projection will actually be: this draft plus every
  // OTHER enabled layer, which is why an edit can overflow while a new layer of
  // the same size would not.
  const composed = [
    ...others.filter(l => l.enabled && l.id !== draft.id).map(l => l.body),
    ...(draft.enabled ? [body] : []),
  ].join("\n\n");
  const composedBytes = utf8Length(composed);
  if (composedBytes > MAX_COMPOSED_BYTES) return { kind: "composed-too-large", bytes: composedBytes };

  return null;
}

/** Six lowercase alphanumerics, matching the route and the store. */
export function newLayerId(taken: readonly CustomLayerDto[]): string {
  const used = new Set(taken.map(l => l.id));
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    let id = "";
    for (let i = 0; i < 6; i += 1) id += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!used.has(id)) return id;
  }
}

/**
 * Client mirror of the server's composeProjection: enabled bodies joined by a
 * blank line. Stored bodies are already normalized on write, so the join is
 * byte-for-byte what developer_instructions will hold.
 */
export function composeBodies(layers: readonly CustomLayerDto[]): string {
  return layers.filter(l => l.enabled).map(l => l.body).join("\n\n");
}

/**
 * The delete-undo window. Long enough to notice the notice, short enough that
 * restoring a row cannot surprise someone mid-edit.
 */
export const UNDO_WINDOW_MS = 10_000;
let undoWindowMsForTests: number | null = null;

/** A regression should not have to burn ten real seconds. */
export function setUndoWindowMsForTests(ms: number | null): void {
  undoWindowMsForTests = ms;
}

export function undoWindowMs(): number {
  return undoWindowMsForTests ?? UNDO_WINDOW_MS;
}

/** Order is composition order, so a move is a reorder of the whole list. */
export function moveLayer(layers: readonly CustomLayerDto[], id: string, delta: -1 | 1): CustomLayerDto[] {
  const next = [...layers];
  const from = next.findIndex(l => l.id === id);
  if (from === -1) return next;
  const to = from + delta;
  if (to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
