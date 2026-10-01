/**
 * Canonical Advisor context-sharing disclosure.
 *
 * The CLI prints this text when an operator grants or is asked to grant consent.
 * The dashboard carries the same facts in locale catalogs. Runtime enforcement
 * does not parse this prose: `contextSharingConsent === "v1"` is the only grant.
 *
 * Version v1 covers exactly the payload `buildAdvisorUserPrompt` assembles.
 * A wider payload needs a new version; old consent must not be reused.
 */

export const ADVISOR_CONTEXT_SHARING_CONSENT_VERSION = "v1";

export const ADVISOR_CONTEXT_SHARING_DISCLOSURE = [
  "Advisor consultations may send this task's conversation to the configured Advisor provider, which may differ from the worker provider.",
  "The consultation prompt can include: the latest user task; user, assistant, and developer text visible in the parsed conversation; tool calls and tool arguments; tool results; the worker tool catalog and descriptions; the worker identity; the configured Advisor model; and an optional focus question on a manual call.",
  "OpenCodex does not insert provider API keys, authorization headers, OAuth tokens, backend-only config secrets, process environment, or hidden chain-of-thought into that prompt. It also does not decrypt or forward encrypted provider-private reasoning.",
  "Task content is not secret-redacted. A key pasted into the task, a secret in a file the tools read, or a token printed by a tool or log can be sent if it is in the parsed conversation. OpenCodex does not run general DLP.",
  "Consent version v1 is an operator action. Enabling Advisor, task text, and either model's output do not grant it.",
].join("\n");
