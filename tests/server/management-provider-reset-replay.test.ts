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
  expect(providerManagementConfigError("custom", { ...base, retryOnReset: { enabled: true, attempts: 3 } })).toBeNull();
  expect(providerManagementConfigError("custom", { ...base, retryOnReset: { attempts: 0 } }))
    .toContain("retryOnReset.attempts is invalid");
  expect(providerManagementConfigError("custom", { ...base, retryOnReset: { attempts: 4 } }))
    .toContain("retryOnReset.attempts is invalid");
  expect(providerManagementConfigError("custom", { ...base, retryOnReset: { attempt: 2 } }))
    .toContain("retryOnReset has unrecognized field");
  expect(providerManagementConfigError("custom", { ...base, retryOnReset: true }))
    .toContain("retryOnReset is invalid");
  // The canonical openai row is the main target of this policy, and a full-object write
  // compares it against the seed with an exact key match: the field must be admitted
  // there like requestPacing is, while its value is still validated.
  expect(providerManagementConfigError("openai", { ...canonicalDirect, retryOnReset: { attempts: 3 } })).toBeNull();
  expect(providerManagementConfigError("openai", { ...canonicalDirect, retryOnReset: { attempts: 4 } }))
    .toContain("retryOnReset.attempts is invalid");
  // A secret-shaped unknown field name and a secret-shaped provider name are both redacted.
  const secretError = providerManagementConfigError("custom", { ...base, retryOnReset: { "sk-super-secret-9876": true } })!;
  expect(secretError).toContain("retryOnReset has unrecognized field");
  expect(secretError).not.toContain("sk-super-secret-9876");
  const secretNameError = providerManagementConfigError("sk-super-secret-9876", { ...base, retryOnReset: { attempts: 0 } })!;
  expect(secretNameError).toContain("retryOnReset.attempts is invalid");
  expect(secretNameError).not.toContain("sk-super-secret-9876");
  expect(secretNameError).toContain("[REDACTED]");
});
