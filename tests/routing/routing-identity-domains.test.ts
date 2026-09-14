import { describe, expect, test } from "bun:test";

import {
  assessQuotaRotation,
  canPortConversationState,
  classifyCredential,
  countQuotaCapacity,
  relateCacheDomain,
  relateQuotaDomain,
  type CredentialIdentity,
  type DeclaredCredentialGroup,
} from "../../src/routing/identity-domains";

function identity(
  credentialId: string,
  ref: Partial<Parameters<typeof classifyCredential>[0]> = {},
  groups: readonly DeclaredCredentialGroup[] = [],
): CredentialIdentity {
  return classifyCredential({ credentialId, ...ref }, groups);
}

const OPENAI_ORG_PROJECT = { provider: "openai", organizationId: "org-1", projectId: "proj-1" };

describe("credential identity domains", () => {
  test("authIdentity is always the credential itself, never grouped", () => {
    const a = identity("key-a", OPENAI_ORG_PROJECT);
    const b = identity("key-b", OPENAI_ORG_PROJECT);
    expect(a.authIdentity).toBe("key-a");
    expect(b.authIdentity).toBe("key-b");
    expect(a.authIdentity).not.toBe(b.authIdentity);
  });

  test("operator-declared groups win over the provider table for quota", () => {
    const groups: DeclaredCredentialGroup[] = [
      { id: "team", credentials: ["key-a", "key-b"], note: "same billed org" },
    ];
    const a = identity("key-a", { provider: "openai", organizationId: "org-1", projectId: "p-1" }, groups);
    const b = identity("key-b", { provider: "openai", organizationId: "org-9", projectId: "p-9" }, groups);
    expect(a.quotaDomain.provenance).toBe("operator-declared");
    expect(relateQuotaDomain(a, b)).toBe("shared");
  });

  test("a declared quota group says nothing about cache compatibility", () => {
    const groups: DeclaredCredentialGroup[] = [
      { id: "team", credentials: ["key-a", "key-b"] },
    ];
    const a = identity("key-a", {}, groups);
    const b = identity("key-b", {}, groups);
    expect(relateQuotaDomain(a, b)).toBe("shared");
    expect(relateCacheDomain(a, b)).toBe("unknown");
  });

  test("OpenAI quota domain is per organization and project", () => {
    const a = identity("key-a", OPENAI_ORG_PROJECT);
    const b = identity("key-b", OPENAI_ORG_PROJECT);
    const otherProject = identity("key-c", { ...OPENAI_ORG_PROJECT, projectId: "proj-2" });
    expect(a.quotaDomain.provenance).toBe("provider-documented");
    expect(relateQuotaDomain(a, b)).toBe("shared");
    expect(relateQuotaDomain(a, otherProject)).toBe("distinct");
  });

  test("a documented rule missing its evidence yields unknown, not a guess", () => {
    const orgOnly = identity("key-a", { provider: "openai", organizationId: "org-1" });
    const same = identity("key-b", { provider: "openai", organizationId: "org-1" });
    expect(orgOnly.quotaDomain.provenance).toBe("unknown");
    expect(relateQuotaDomain(orgOnly, same)).toBe("unknown");
  });

  test("unknown is never read as shared and never as distinct", () => {
    const a = identity("key-a", { provider: "obscure" });
    const b = identity("key-b", { provider: "obscure" });
    expect(relateQuotaDomain(a, b)).toBe("unknown");
    expect(relateCacheDomain(a, b)).toBe("unknown");
    expect(a.quotaDomain.key).not.toBe(b.quotaDomain.key);
  });

  test("Anthropic isolates prompt cache per workspace", () => {
    const a = identity("k1", { provider: "anthropic", workspaceId: "ws-1" });
    const b = identity("k2", { provider: "anthropic", workspaceId: "ws-1" });
    const other = identity("k3", { provider: "anthropic", workspaceId: "ws-2" });
    expect(relateCacheDomain(a, b)).toBe("shared");
    expect(relateCacheDomain(a, other)).toBe("distinct");
    // Anthropic quota sharing is not one of the documented cases.
    expect(relateQuotaDomain(a, b)).toBe("unknown");
  });

  test("Azure domains are per deployment", () => {
    const a = identity("d1", { provider: "azure", deploymentId: "dep-1" });
    const b = identity("d2", { provider: "azure", deploymentId: "dep-1" });
    const other = identity("d3", { provider: "azure", deploymentId: "dep-2" });
    expect(relateQuotaDomain(a, b)).toBe("shared");
    expect(relateCacheDomain(a, b)).toBe("shared");
    expect(relateQuotaDomain(a, other)).toBe("distinct");
  });
});

describe("quota refusal rotation", () => {
  test("a refusal inside a known shared domain must not rotate within it", () => {
    const a = identity("key-a", OPENAI_ORG_PROJECT);
    const b = identity("key-b", OPENAI_ORG_PROJECT);
    expect(assessQuotaRotation(a, b)).toBe("same-domain");
  });

  test("a refusal may rotate to a credential in a distinct domain", () => {
    const a = identity("key-a", OPENAI_ORG_PROJECT);
    const b = identity("key-b", { provider: "azure", deploymentId: "dep-1" });
    expect(assessQuotaRotation(a, b)).toBe("distinct-domain");
  });

  test("unknown domains hand the decision back to the caller", () => {
    const a = identity("key-a", { provider: "obscure" });
    const b = identity("key-b", OPENAI_ORG_PROJECT);
    expect(assessQuotaRotation(a, b)).toBe("unknown");
    expect(assessQuotaRotation(b, a)).toBe("unknown");
  });
});

describe("quota capacity accounting", () => {
  test("two credentials in one quota domain count once", () => {
    const a = identity("key-a", OPENAI_ORG_PROJECT);
    const b = identity("key-b", OPENAI_ORG_PROJECT);
    const c = identity("key-c", { provider: "azure", deploymentId: "dep-1" });
    expect(countQuotaCapacity([a, b, c])).toEqual({ known: 2, unknown: 0 });
  });

  test("unknown-domain credentials are reported separately, not merged", () => {
    const a = identity("key-a", OPENAI_ORG_PROJECT);
    const u1 = identity("u1", { provider: "obscure" });
    const u2 = identity("u2", { provider: "obscure" });
    expect(countQuotaCapacity([a, u1, u2])).toEqual({ known: 1, unknown: 2 });
  });
});

describe("conversational-state portability", () => {
  test("a state-free request is portable", () => {
    expect(canPortConversationState({})).toEqual({ portable: true });
    expect(canPortConversationState({
      previousResponseId: null,
      fileIds: [],
      encryptedReasoning: undefined,
    })).toEqual({ portable: true });
  });

  test("previous_response_id refuses with a typed reason", () => {
    expect(canPortConversationState({ previousResponseId: "resp_1" })).toEqual({
      portable: false,
      reason: "previous-response-id",
    });
  });

  test("provider-side conversation id refuses", () => {
    expect(canPortConversationState({ providerConversationId: "conv_1" })).toEqual({
      portable: false,
      reason: "provider-conversation-id",
    });
  });

  test("uploaded file ids refuse", () => {
    expect(canPortConversationState({ fileIds: ["file-1"] })).toEqual({
      portable: false,
      reason: "uploaded-file-ids",
    });
  });

  test("encrypted reasoning payloads refuse", () => {
    expect(canPortConversationState({ encryptedReasoning: ["blob"] })).toEqual({
      portable: false,
      reason: "encrypted-reasoning",
    });
    expect(canPortConversationState({ encryptedReasoning: "blob" })).toEqual({
      portable: false,
      reason: "encrypted-reasoning",
    });
  });

  test("a shared cache domain is not portability, and portability is not a cache promise", () => {
    const a = identity("k1", { provider: "anthropic", workspaceId: "ws-1" });
    const b = identity("k2", { provider: "anthropic", workspaceId: "ws-1" });
    expect(relateCacheDomain(a, b)).toBe("shared");
    // Same cache domain, still not portable once the request carries bound state.
    expect(canPortConversationState({ previousResponseId: "resp_1" }).portable).toBe(false);
    // Portable state, still no cache promise on an undocumented provider.
    const u1 = identity("u1", { provider: "obscure" });
    const u2 = identity("u2", { provider: "obscure" });
    expect(canPortConversationState({}).portable).toBe(true);
    expect(relateCacheDomain(u1, u2)).toBe("unknown");
  });
});
