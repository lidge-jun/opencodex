import { expect, test } from "bun:test";
import { providerManagementConfigError } from "../../src/server/auth-cors";

// Lives apart from management-provider-validation.test.ts because that file sits at its
// file-size ratchet cap; the helpers it needs are small enough to repeat here.
const canonicalDirect = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  codexAccountMode: "direct",
} as const;

test("provider management validates retryOnReset bounds and unknown keys", () => {
  const base = { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" };
  expect(providerManagementConfigError("custom", { ...base, retryOnReset: {} })).toBeNull();
  expect(providerManagementConfigError("custom", { ...base, retryOnReset: { enabled: true, replacements: 2 } })).toBeNull();
  expect(providerManagementConfigError("custom", { ...base, retryOnReset: { replacements: 0 } }))
    .toContain("retryOnReset.replacements is invalid");
  expect(providerManagementConfigError("custom", { ...base, retryOnReset: { replacements: 3 } }))
    .toContain("retryOnReset.replacements is invalid");
  // The old field name from the pre-rework branch is rejected rather than silently ignored:
  // `attempts` was a per-leg send count and this is a per-request replacement count.
  expect(providerManagementConfigError("custom", { ...base, retryOnReset: { attempts: 2 } }))
    .toContain("retryOnReset has unrecognized field");
  expect(providerManagementConfigError("custom", { ...base, retryOnReset: true }))
    .toContain("retryOnReset is invalid");
  // The canonical openai row is the main target of this policy, and a full-object write
  // compares it against the seed with an exact key match: the field must be admitted
  // there like requestPacing is, while its value is still validated.
  expect(providerManagementConfigError("openai", { ...canonicalDirect, retryOnReset: { replacements: 2 } })).toBeNull();
  expect(providerManagementConfigError("openai", { ...canonicalDirect, retryOnReset: { replacements: 3 } }))
    .toContain("retryOnReset.replacements is invalid");
  // A secret-shaped unknown field name and a secret-shaped provider name are both redacted.
  const secretError = providerManagementConfigError("custom", { ...base, retryOnReset: { "sk-super-secret-9876": true } })!;
  expect(secretError).toContain("retryOnReset has unrecognized field");
  expect(secretError).not.toContain("sk-super-secret-9876");
  const secretNameError = providerManagementConfigError("sk-super-secret-9876", { ...base, retryOnReset: { replacements: 0 } })!;
  expect(secretNameError).toContain("retryOnReset.replacements is invalid");
  expect(secretNameError).not.toContain("sk-super-secret-9876");
  expect(secretNameError).toContain("[REDACTED]");
});

test("retryOn429 keeps its own field name after the formatter was shared", () => {
  // The two validators now run through one body. A shared formatter that reported the wrong
  // field name would send an operator to the wrong key in their config.
  const base = { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" };
  expect(providerManagementConfigError("custom", { ...base, retryOn429: { attempts: 0 } }))
    .toContain("retryOn429.attempts is invalid");
  expect(providerManagementConfigError("custom", { ...base, retryOn429: { nope: 1 } }))
    .toContain("retryOn429 has unrecognized field");
});
