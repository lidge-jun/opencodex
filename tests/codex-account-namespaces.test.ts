import { describe, expect, spyOn, test } from "bun:test";
import * as accountLabels from "../src/codex/account-label";
import {
  CODEX_ACCOUNT_LOG_LABEL_RE,
  fallbackCodexAccountLogLabel,
} from "../src/codex/account-label";
import {
  codexAccountIdNamespaceCollisionError,
  codexAccountNamespaceProviderCollisionError,
  codexAccountNamespaceForModel,
  hasCodexAccountNamespace,
} from "../src/codex/account-namespace-match";
import {
  appendDefaultCodexAccountNamespace,
  codexAccountPickerEnabled,
  codexAccountNamespaceEntries,
  defaultCodexAccountNamespaces,
  initializeDefaultCodexAccountNamespaces,
  isMainCodexAccountTarget,
  isValidCodexAccountNamespaceTarget,
} from "../src/codex/account-namespaces";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import type { OcxConfig } from "../src/types";

type InitializableAccountNamespaceConfig = Pick<
  OcxConfig,
  | "codexAccountPickerEnabled"
  | "codexAccountNamespaces"
  | "codexAccounts"
  | "combos"
  | "providers"
  | "routingProfiles"
>;

describe("Codex account namespace foundations", () => {
  test("uses persisted random labels without deriving selectors from aliases or emails", () => {
    const privateAlias = "jun@example.test";
    const privateEmail = "account@example.test";
    const privateId = "stored-account-id";
    const namespaces = defaultCodexAccountNamespaces({
      providers: {},
      codexAccounts: [{
        id: privateId,
        email: privateEmail,
        alias: privateAlias,
        logLabel: "p111111",
        isMain: false,
      }],
    });

    expect(namespaces).toEqual({ main: "@main", p111111: privateId });
    const publicSelectors = Object.keys(namespaces).join(",");
    expect(publicSelectors).not.toContain(privateAlias);
    expect(publicSelectors).not.toContain(privateEmail);
    expect(publicSelectors).not.toContain(privateId);
  });

  test("gives legacy accounts an independent random selector", () => {
    const privateId = "legacy-stored-account-id";
    const namespaces = defaultCodexAccountNamespaces({
      providers: {},
      codexAccounts: [{
        id: privateId,
        email: "legacy@example.test",
        alias: "Legacy Display Name",
        isMain: false,
      }],
    });
    const selector = Object.entries(namespaces)
      .find(([, accountId]) => accountId === privateId)?.[0];

    expect(selector).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
    expect(selector).not.toBe(fallbackCodexAccountLogLabel(privateId));
    expect(selector).not.toContain(privateId);
  });

  test("fails after bounded attempts when no private-safe selector can be allocated", () => {
    const labelSpy = spyOn(accountLabels, "createCodexAccountLogLabel").mockReturnValue("p111111");
    try {
      expect(() => defaultCodexAccountNamespaces({
        providers: {},
        codexAccounts: [{ id: "p111111", logLabel: "legacy", isMain: false }],
      })).toThrow("Unable to allocate a unique Codex account selector");
      expect(labelSpy).toHaveBeenCalledTimes(16);
    } finally {
      labelSpy.mockRestore();
    }
  });

  test("never reuses a private account id or its deterministic fallback as a selector", () => {
    const pShapedId = "p222222";
    const fallbackId = "legacy-private-account-id";
    const deterministicFallback = fallbackCodexAccountLogLabel(fallbackId);
    const namespaces = defaultCodexAccountNamespaces({
      providers: {},
      codexAccounts: [
        { id: pShapedId, logLabel: pShapedId, isMain: false },
        { id: fallbackId, logLabel: deterministicFallback, isMain: false },
      ],
    });

    const selectorFor = (accountId: string) => Object.entries(namespaces)
      .find(([, target]) => target === accountId)?.[0];
    expect(selectorFor(pShapedId)).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
    expect(selectorFor(pShapedId)).not.toBe(pShapedId);
    expect(selectorFor(fallbackId)).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
    expect(selectorFor(fallbackId)).not.toBe(deterministicFallback);
  });

  test("does not expose another account id or deterministic fallback as a selector", () => {
    const pShapedPrivateId = "p444444";
    const fallbackOwnerId = "other-private-account-id";
    const otherFallback = fallbackCodexAccountLogLabel(fallbackOwnerId);
    const namespaces = defaultCodexAccountNamespaces({
      providers: {},
      codexAccounts: [
        { id: "first-account", logLabel: pShapedPrivateId, isMain: false },
        { id: pShapedPrivateId, logLabel: "p555555", isMain: false },
        { id: "third-account", logLabel: otherFallback, isMain: false },
        { id: fallbackOwnerId, logLabel: "p666666", isMain: false },
      ],
    });

    const publicSelectors = Object.keys(namespaces);
    expect(publicSelectors).not.toContain(pShapedPrivateId);
    expect(publicSelectors).not.toContain(otherFallback);
  });

  test("suffix allocation cannot land on another private account id", () => {
    const privateSuffix = "p888888-2";
    const namespaces = defaultCodexAccountNamespaces({
      providers: {
        p888888: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      codexAccounts: [
        { id: "first-account", logLabel: "p888888", isMain: false },
        { id: privateSuffix, logLabel: "p999999", isMain: false },
      ],
    });

    expect(Object.keys(namespaces)).not.toContain(privateSuffix);
    expect(Object.entries(namespaces).find(([, target]) => target === "first-account")?.[0])
      .toBe("p888888-3");
  });

  test("avoids provider and combo prefixes when allocating defaults", () => {
    const namespaces = defaultCodexAccountNamespaces({
      providers: { p111111: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
      combos: {
        primary: {
          alias: "main/gpt-5.5",
          targets: [{ provider: "p111111", model: "gpt-5.5" }],
        },
      },
      codexAccounts: [{
        id: "stored-account-id",
        email: "account@example.test",
        logLabel: "p111111",
        isMain: false,
      }],
    });

    expect(namespaces).toEqual({ "main-2": "@main", "p111111-2": "stored-account-id" });
  });

  test("avoids routing-profile alias prefixes when allocating defaults", () => {
    const namespaces = defaultCodexAccountNamespaces({
      providers: {},
      routingProfiles: {
        main: {
          alias: " main/gpt-5.5 ",
          candidates: [{ provider: "openai", model: "gpt-5.5" }],
        },
        side: {
          alias: "p111111/gpt-5.5",
          candidates: [{ provider: "openai", model: "gpt-5.5" }],
        },
      },
      codexAccounts: [{
        id: "stored-account-id",
        logLabel: "p111111",
        isMain: false,
      }],
    });

    expect(namespaces).toEqual({ "main-2": "@main", "p111111-2": "stored-account-id" });
  });

  test("keeps routing-profile alias-prefix matching exact-case", () => {
    expect(defaultCodexAccountNamespaces({
      providers: {},
      routingProfiles: {
        mixedCase: {
          alias: "Main/gpt-5.5",
          candidates: [{ provider: "openai", model: "gpt-5.5" }],
        },
      },
    })).toEqual({ main: "@main" });
  });

  test("avoids provider names case-insensitively when allocating defaults", () => {
    expect(defaultCodexAccountNamespaces({
      providers: {
        Main: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
    })).toEqual({ "main-2": "@main" });
  });

  test("appends a safe selector without rewriting an explicit map", () => {
    const codexAccountNamespaces = { chosen: "existing-account-id", mainAccount: "@main" };
    const config = { providers: {}, codexAccountNamespaces };
    const account = {
      id: "new-account-id",
      email: "private@example.test",
      alias: "Private Display Alias",
      logLabel: "p222222",
      isMain: false,
    };

    expect(appendDefaultCodexAccountNamespace(config, account)).toBe(true);
    expect(config.codexAccountNamespaces).toEqual({
      chosen: "existing-account-id",
      mainAccount: "@main",
      p222222: "new-account-id",
    });
    expect(appendDefaultCodexAccountNamespace(config, account)).toBe(false);
  });

  test("append avoids routing-profile alias prefixes without rewriting existing selectors", () => {
    const codexAccountNamespaces = { main: "@main" };
    const config = {
      providers: {},
      routingProfiles: {
        side: {
          alias: "p222222/gpt-5.5",
          candidates: [{ provider: "openai", model: "gpt-5.5" }],
        },
      },
      codexAccountNamespaces,
    };

    expect(appendDefaultCodexAccountNamespace(config, {
      id: "new-account-id",
      logLabel: "p222222",
      isMain: false,
    })).toBe(true);
    expect(config.codexAccountNamespaces).toBe(codexAccountNamespaces);
    expect(config.codexAccountNamespaces).toEqual({
      main: "@main",
      "p222222-2": "new-account-id",
    });
  });

  test("refuses to append an account id already owned by a selector key", () => {
    const codexAccountNamespaces = { work: "existing-account-id", mainAccount: "@main" };
    const config = { providers: {}, codexAccountNamespaces };

    expect(appendDefaultCodexAccountNamespace(config, {
      id: "work",
      logLabel: "p232323",
      isMain: false,
    })).toBe(false);
    expect(config.codexAccountNamespaces).toEqual({
      work: "existing-account-id",
      mainAccount: "@main",
    });
  });

  test("refuses to append the Desktop main account", () => {
    const codexAccountNamespaces = { mainAccount: "@main" };
    const config = { providers: {}, codexAccountNamespaces };

    expect(appendDefaultCodexAccountNamespace(config, {
      id: "desktop-id",
      logLabel: "p242424",
      isMain: true,
    })).toBe(false);
    expect(config.codexAccountNamespaces).toEqual({ mainAccount: "@main" });
  });

  test("never generates targets for legacy account ids rejected by the namespace schema", () => {
    expect(defaultCodexAccountNamespaces({
      providers: {},
      codexAccounts: [
        { id: "constructor", logLabel: "p242425", isMain: false },
        { id: "valid-account", logLabel: "p242426", isMain: false },
      ],
    })).toEqual({ main: "@main", p242426: "valid-account" });

    const config = {
      providers: {},
      codexAccountNamespaces: { mainAccount: "@main" },
    };
    expect(appendDefaultCodexAccountNamespace(config, {
      id: "Constructor",
      logLabel: "p242427",
      isMain: false,
    })).toBe(false);
    expect(config.codexAccountNamespaces).toEqual({ mainAccount: "@main" });
  });

  test("append avoids every existing private target and deterministic fallback", () => {
    const existingTarget = "p777777";
    const fallbackOwnerId = "existing-private-account-id";
    const fallback = fallbackCodexAccountLogLabel(fallbackOwnerId);

    for (const logLabel of [existingTarget, fallback]) {
      const config = {
        providers: {},
        codexAccountNamespaces: {
          existing: existingTarget,
          fallbackOwner: fallbackOwnerId,
          mainAccount: "@main",
        },
      };
      const newAccountId = `new-account-${logLabel}`;
      expect(appendDefaultCodexAccountNamespace(config, {
        id: newAccountId,
        logLabel,
        isMain: false,
      })).toBe(true);
      const selector = Object.entries(config.codexAccountNamespaces)
        .find(([, target]) => target === newAccountId)?.[0];
      expect(selector).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
      expect(selector).not.toBe(logLabel);
    }
  });

  test("append protects pool accounts omitted from an intentionally incomplete map", () => {
    const unmappedPrivateId = "p121212";
    const config = {
      providers: {
        p343434: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      codexAccounts: [
        { id: unmappedPrivateId, logLabel: "p565656", isMain: false },
        { id: "p343434-2", logLabel: "p787878", isMain: false },
      ],
      codexAccountNamespaces: { mainAccount: "@main" },
    };

    expect(appendDefaultCodexAccountNamespace(config, {
      id: "new-account-id",
      logLabel: unmappedPrivateId,
      isMain: false,
    })).toBe(true);
    const selector = Object.entries(config.codexAccountNamespaces)
      .find(([, target]) => target === "new-account-id")?.[0];
    expect(selector).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
    expect(selector).not.toBe(unmappedPrivateId);

    expect(appendDefaultCodexAccountNamespace(config, {
      id: "second-new-account-id",
      logLabel: "p343434",
      isMain: false,
    })).toBe(true);
    const suffixedSelector = Object.entries(config.codexAccountNamespaces)
      .find(([, target]) => target === "second-new-account-id")?.[0];
    expect(suffixedSelector).toBe("p343434-3");
  });

  test("keeps empty maps inert and distinguishes a pool id named main from the Desktop account", () => {
    const empty = { providers: {}, codexAccountNamespaces: {} as Record<string, string> };
    expect(appendDefaultCodexAccountNamespace(empty, {
      id: "side-account-id",
      email: "side@example.test",
      logLabel: "p333333",
      isMain: false,
    })).toBe(false);
    expect(empty.codexAccountNamespaces).toEqual({});

    expect(defaultCodexAccountNamespaces({
      providers: {},
      codexAccounts: [
        { id: "main", email: "first@example.test", logLabel: "p454545", isMain: false },
        { id: MAIN_CODEX_ACCOUNT_ID, email: "second@example.test", isMain: false },
        { id: "desktop-row", email: "third@example.test", logLabel: "p464646", isMain: true },
      ],
    })).toEqual({ "main-2": "@main", p454545: "main" });
  });

  test("initializes selectors only for an explicit opt-in with no existing bindings", () => {
    const absent: InitializableAccountNamespaceConfig = {
      providers: {},
      codexAccountPickerEnabled: true,
    };
    expect(initializeDefaultCodexAccountNamespaces(absent)).toBe(true);
    expect(absent.codexAccountNamespaces).toEqual({ main: "@main" });

    const originalEmpty = {} as Record<string, string>;
    const empty = {
      providers: {},
      codexAccountPickerEnabled: true,
      codexAccountNamespaces: originalEmpty,
    };
    expect(initializeDefaultCodexAccountNamespaces(empty)).toBe(true);
    expect(empty.codexAccountNamespaces).not.toBe(originalEmpty);
    expect(empty.codexAccountNamespaces).toEqual({ main: "@main" });

    for (const codexAccountPickerEnabled of [undefined, false]) {
      const inert = { providers: {}, codexAccountPickerEnabled };
      expect(initializeDefaultCodexAccountNamespaces(inert)).toBe(false);
      expect(inert).not.toHaveProperty("codexAccountNamespaces");
    }
  });

  test("initializer preserves a non-empty selector map by identity and order", () => {
    const codexAccountNamespaces = { side: "stored-account", desktop: "@main" };
    const config = {
      providers: {},
      codexAccountPickerEnabled: true,
      codexAccountNamespaces,
    };

    const labelSpy = spyOn(accountLabels, "createCodexAccountLogLabel");
    try {
      expect(initializeDefaultCodexAccountNamespaces(config)).toBe(false);
      expect(config.codexAccountNamespaces).toBe(codexAccountNamespaces);
      expect(Object.keys(config.codexAccountNamespaces)).toEqual(["side", "desktop"]);
      expect(labelSpy).not.toHaveBeenCalled();
    } finally {
      labelSpy.mockRestore();
    }
  });

  test("initializer assigns nothing when safe selector allocation fails", () => {
    const labelSpy = spyOn(accountLabels, "createCodexAccountLogLabel").mockReturnValue("p111111");
    try {
      for (const startsWithEmptyMap of [false, true]) {
        const originalEmpty = {} as Record<string, string>;
        const config: InitializableAccountNamespaceConfig = {
          providers: {},
          codexAccountPickerEnabled: true,
          codexAccounts: [{ id: "p111111", logLabel: "legacy", isMain: false }],
          ...(startsWithEmptyMap ? { codexAccountNamespaces: originalEmpty } : {}),
        };

        expect(() => initializeDefaultCodexAccountNamespaces(config))
          .toThrow("Unable to allocate a unique Codex account selector");
        if (startsWithEmptyMap) {
          expect(config.codexAccountNamespaces).toBe(originalEmpty);
          expect(config.codexAccountNamespaces).toEqual({});
        } else {
          expect(config).not.toHaveProperty("codexAccountNamespaces");
        }
      }
    } finally {
      labelSpy.mockRestore();
    }
  });

  test("keeps existing selector maps enabled unless the visibility override is false", () => {
    expect(codexAccountPickerEnabled({ codexAccountNamespaces: { desktop: "@main" } })).toBe(true);
    expect(codexAccountPickerEnabled({
      codexAccountNamespaces: { desktop: "@main" },
      codexAccountPickerEnabled: true,
    })).toBe(true);
    expect(codexAccountPickerEnabled({
      codexAccountNamespaces: { desktop: "@main" },
      codexAccountPickerEnabled: false,
    })).toBe(false);
    expect(codexAccountPickerEnabled({
      codexAccountNamespaces: {},
      codexAccountPickerEnabled: true,
    })).toBe(false);
    expect(codexAccountPickerEnabled({})).toBe(false);
    for (const malformed of [null, "false", 0, {}, []]) {
      expect(codexAccountPickerEnabled({
        codexAccountNamespaces: { desktop: "@main" },
        codexAccountPickerEnabled: malformed as never,
      })).toBe(false);
    }
  });

  test("matches route and account namespaces exactly but provider namespaces case-insensitively", () => {
    const inherited = Object.create({ inherited: "account-id" }) as Record<string, string>;
    inherited.side = "side-account-id";

    expect(hasCodexAccountNamespace(inherited, "side")).toBe(true);
    expect(hasCodexAccountNamespace(inherited, "inherited")).toBe(false);
    expect(codexAccountNamespaceForModel(inherited, "side/gpt-5.5")).toBe("side");
    expect(codexAccountNamespaceForModel(inherited, "Side/gpt-5.5")).toBeUndefined();
    expect(codexAccountNamespaceForModel(inherited, "gpt-5.5")).toBeUndefined();
    expect(codexAccountNamespaceProviderCollisionError(inherited, "side"))
      .toBe("provider name must not collide with a configured Codex account namespace");
    expect(codexAccountNamespaceProviderCollisionError(inherited, "SIDE"))
      .toBe("provider name must not collide with a configured Codex account namespace");
    expect(codexAccountNamespaceProviderCollisionError(inherited, "inherited")).toBeUndefined();
    expect(codexAccountIdNamespaceCollisionError(inherited, "side"))
      .toBe("account id must not collide with a configured Codex account namespace");
    expect(codexAccountIdNamespaceCollisionError(inherited, "Side")).toBeUndefined();
    expect(codexAccountIdNamespaceCollisionError(inherited, "inherited")).toBeUndefined();
  });

  test("normalizes only the explicit main sentinel and keeps a pool id named main literal", () => {
    expect(isMainCodexAccountTarget("@main")).toBe(true);
    expect(isMainCodexAccountTarget("main")).toBe(false);
    expect(isMainCodexAccountTarget(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
    expect(isValidCodexAccountNamespaceTarget("@main")).toBe(true);
    expect(isValidCodexAccountNamespaceTarget(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
    expect(isValidCodexAccountNamespaceTarget("side-account_2.test")).toBe(true);
    expect(isValidCodexAccountNamespaceTarget(" account ")).toBe(false);
    expect(isValidCodexAccountNamespaceTarget("account/id")).toBe(false);
    for (const reserved of ["__proto__", "prototype", "constructor", "Constructor"]) {
      expect(isValidCodexAccountNamespaceTarget(reserved)).toBe(false);
    }
    expect(codexAccountNamespaceEntries({
      codexAccountNamespaces: { primary: "@main", poolNamedMain: "main", side: "side-id" },
    })).toEqual([
      ["primary", MAIN_CODEX_ACCOUNT_ID],
      ["poolNamedMain", "main"],
      ["side", "side-id"],
    ]);
  });
});
