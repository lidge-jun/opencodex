import * as z from "zod/v4";
import { redactSecretString } from "../../lib/redact";

/**
 * Experimental macOS ChatGPT desktop integration: the app-server shim, the send-unblock intercept,
 * and its PAC-fallback launch mode.
 */
export const chatgptDesktopSchema = z.object({
  appServerShim: z.boolean().optional(),
  unblockSend: z.boolean().optional(),
  pacFallback: z.boolean().optional(),
  port: z.number().int().min(1).max(65535).optional(),
}).strict();

/**
 * Why a present `chatgptDesktop` block fails the schema, or null when it is valid or absent. The
 * read path degrades a failing block to absent, so the integration reads as off while the file
 * still says `appServerShim: true`; this names the field so that is never silent. A leftover key
 * from an older or ported config (for example a misspelled `unblockPort`) is the usual cause.
 */
export function chatgptDesktopConfigIssue(rawParsed: unknown): string | null {
  if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) return null;
  const block = (rawParsed as Record<string, unknown>).chatgptDesktop;
  if (block === undefined) return null;
  const result = chatgptDesktopSchema.safeParse(block);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  return redactSecretString(`chatgptDesktop${field ? `.${field}` : ""}: ${issue?.message ?? "invalid configuration"}`);
}
