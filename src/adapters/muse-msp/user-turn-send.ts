import { MuseMspError } from "./connection";
import { museModelInputDigest } from "./history";

/** Experimental exact-prefix marker; caller must only capture an authenticated model POST. */
export class MuseModelInputCheckpoint {
  private readonly length: number;
  private readonly digest: string;
  constructor(body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { input?: unknown }).input)) throw new MuseMspError("invalid_model_input");
    const input = (body as { input: unknown[] }).input;
    if (!input.length) throw new MuseMspError("invalid_model_input");
    this.length = input.length;
    this.digest = museModelInputDigest(input);
  }

  /** The observed simple transcript appends exactly one assistant message and one user message. */
  matches(body: unknown, previousAnswer: string, userText: string): boolean {
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof previousAnswer !== "string" || !previousAnswer ||
        typeof userText !== "string" || !userText) return false;
    const input = (body as { input?: unknown }).input;
    if (!Array.isArray(input) || input.length !== this.length + 2) return false;
    const assistant = input[this.length], user = input[this.length + 1];
    if (!assistant || typeof assistant !== "object" || Array.isArray(assistant) || assistant.type !== "message" || assistant.role !== "assistant" ||
        assistant.content !== previousAnswer || (assistant.phase !== undefined && assistant.phase !== "final_answer") ||
        !user || typeof user !== "object" || Array.isArray(user) || user.type !== "message" || user.role !== "user" || user.content !== userText) return false;
    try { return museModelInputDigest(input.slice(0, this.length)) === this.digest; } catch { return false; }
  }
}
