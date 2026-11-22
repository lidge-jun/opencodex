import * as z from "zod/v4";
import { redactSecretString } from "../../lib/redact";

/** Experimental macOS ChatGPT app-server shim; strict optional booleans are accepted.
 *  `spendCredits` opts into letting the desktop draw on credits when the subscription quota is
 *  exhausted: the credit-variant limit gates are lifted like plain-quota ones. Default off —
 *  credits are real money, so the default keeps a credit-limited composer locked. */
export const chatgptDesktopSchema = z.object({ appServerShim: z.boolean().optional(), spendCredits: z.boolean().optional() }).strict();

/**
 * Why a present `chatgptDesktop` block fails the schema, or null when it is valid or absent. The
 * read path degrades a failing block to absent, so the integration reads as off while the file
 * still says `appServerShim: true`; this names the field so that is never silent. A leftover key
 * from an older config (for example `unblockSend`) is the usual cause.
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
