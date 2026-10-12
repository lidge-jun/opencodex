import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyPaginatedOpenaiCompat } from "../../src/codex/inject/paginated-openai-compat";
import {
  HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE,
  HISTORY_RELABEL_STANDS_DOWN,
} from "../../src/codex/history-provider";
import { OCX_ROUTING_MARKER_LINE } from "../../src/codex/injected-marker";
import type { CodexRoutingTarget } from "../../src/codex/inject/routing-target";
import { repoPath } from "../helpers/repo-root";

const BASE_URL = "http://127.0.0.1:10100/v1";
const loopback: CodexRoutingTarget = {
  baseUrl: BASE_URL,
  requiresAdmissionToken: false,
  tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
  desktopAuthless: true,
};
const admissionToken: CodexRoutingTarget = {
  baseUrl: "https://proxy.example/v1",
  requiresAdmissionToken: true,
  tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
};

// The provider-table candidate as the injector hands it over: root model_provider plus the
// table, and no root openai_base_url, because a table transition takes that key out.
const TABLE_CANDIDATE = [
  'model_provider = "opencodex"',
  'model = "vendor/routed-model"',
  "",
  "[model_providers.opencodex]",
  `base_url = "${BASE_URL}"`,
  "",
].join("\n");

describe("paginated openai compatibility (#5321)", () => {
  test("a loopback table transition retains the root override and stands the relabel down", () => {
    const decision = applyPaginatedOpenaiCompat(
      HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE, loopback, TABLE_CANDIDATE, "\n",
    );
    // Standing down rather than clearing the reason is what keeps the caller from starting the
    // relabel unit at all: the paginated row must not be rewritten, only kept resolvable.
    expect(decision.refusal).toBe(HISTORY_RELABEL_STANDS_DOWN);
    expect(decision.retainedRootOverride).toBe(true);
    expect(decision.content).toContain(`${OCX_ROUTING_MARKER_LINE}\nopenai_base_url = "${BASE_URL}"`);
    // The table has to survive alongside it, or new authless threads lose their provider.
    expect(decision.content).toContain("[model_providers.opencodex]");
    expect(decision.content).toContain('model_provider = "opencodex"');
  });

  test("the retained override is written before the first table, where Codex reads root keys", () => {
    const decision = applyPaginatedOpenaiCompat(
      HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE, loopback, TABLE_CANDIDATE, "\n",
    );
    const lines = decision.content.split("\n");
    expect(lines.findIndex(line => line.startsWith("openai_base_url")))
      .toBeLessThan(lines.findIndex(line => line.startsWith("[")));
  });

  test("CRLF config keeps its line endings through the retention", () => {
    const decision = applyPaginatedOpenaiCompat(
      HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE, loopback, TABLE_CANDIDATE.replace(/\n/g, "\r\n"), "\r\n",
    );
    expect(decision.content).toContain("\r\n");
    expect(decision.content.replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("a root line the user owns is left alone and never journaled as ours", () => {
    const userOwned = `openai_base_url = "https://my-gateway.example/v1"\n${TABLE_CANDIDATE}`;
    const decision = applyPaginatedOpenaiCompat(
      HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE, loopback, userOwned, "\n",
    );
    // The transition still completes — the conversation follows the destination the user chose,
    // which is the same guarantee the injector makes everywhere else about a line it does not own.
    expect(decision.refusal).toBe(HISTORY_RELABEL_STANDS_DOWN);
    expect(decision.retainedRootOverride).toBe(false);
    expect(decision.content).toBe(userOwned);
  });

  test("an admission-token form keeps the refusal and names both ways out", () => {
    const decision = applyPaginatedOpenaiCompat(
      HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE, admissionToken, TABLE_CANDIDATE, "\n",
    );
    expect(decision.refusal).toBe(HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE);
    expect(decision.retainedRootOverride).toBe(false);
    expect(decision.content).toBe(TABLE_CANDIDATE);
    // The regression was not the refusal, it was "do not retry" with nowhere to go. Both named
    // remedies must be real configuration keys, so they are asserted against the config type.
    const configSource = readFileSync(repoPath("src", "types", "config.ts"), "utf8");
    for (const key of ["syncResumeHistory", "unauthenticatedLoopbackListener"]) {
      expect(decision.message).toContain(key);
      expect(configSource).toContain(`${key}?:`);
    }
    expect(decision.message).not.toContain("do not run legacy recovery");
  });

  test("every other reason passes through with the refusal text it always had", () => {
    const decision = applyPaginatedOpenaiCompat("history_rollout_identity_changed", loopback, TABLE_CANDIDATE, "\n");
    expect(decision.refusal).toBe("history_rollout_identity_changed");
    expect(decision.retainedRootOverride).toBe(false);
    expect(decision.content).toBe(TABLE_CANDIDATE);
    expect(decision.message).toContain("do not run legacy recovery or retry this transition blindly");
    // A plain stand-down is not this resolver's business and must reach the caller untouched.
    expect(applyPaginatedOpenaiCompat(HISTORY_RELABEL_STANDS_DOWN, loopback, TABLE_CANDIDATE, "\n"))
      .toMatchObject({ refusal: HISTORY_RELABEL_STANDS_DOWN, retainedRootOverride: false, content: TABLE_CANDIDATE });
    expect(applyPaginatedOpenaiCompat(null, loopback, TABLE_CANDIDATE, "\n"))
      .toMatchObject({ refusal: null, retainedRootOverride: false, content: TABLE_CANDIDATE });
  });

  test("the refusal code is defined once and read from that definition", () => {
    // The pair drifted once already between apply and restore. A literal in a second file is
    // how it drifts again, so the only occurrences allowed are the constant and its consumers.
    const provider = readFileSync(repoPath("src", "codex", "history-provider.ts"), "utf8");
    const occurrences = provider.split(HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE).length - 1;
    expect(occurrences).toBe(1);
    expect(readFileSync(repoPath("src", "codex", "inject", "paginated-openai-compat.ts"), "utf8"))
      .not.toContain(`"${HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE}"`);
  });
});
