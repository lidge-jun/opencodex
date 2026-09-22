import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import {
  REQUEST_OUTCOME_CLASSES,
  REQUEST_CLOSE_REASONS,
  REQUEST_TERMINAL_STATUSES,
  classifyRequestOutcome,
  requestPhysicalSends,
  requestSettledSends,
  requestUnresolvedSends,
  type RequestOutcomeFacts,
} from "../../src/usage/request-outcome";
import {
  REQUEST_METRICS_RESULTS,
  REQUEST_METRICS_FAILURE_CAUSES,
  REQUEST_METRICS_PROTOCOLS,
  createRequestMetricsOwner,
} from "../../src/server/request-metrics";
import { ATTEMPT_RECOVERY_KIND_ROSTER } from "../../src/usage/telemetry-contract";

/**
 * The durable ledger, the Prometheus exporter and the dashboard have to answer "how did this
 * request end" and "how many times did it reach upstream" the same way. They did not: the
 * exporter kept a private classifier and the dashboard read the numeric status alone, so an
 * incomplete 200 was a metric incident and a green row at the same time.
 *
 * None of these cases can be satisfied by a request that returned 200 -- several of them are
 * specifically about a 200 that must NOT read as success.
 */

const LOCALES = ["en", "ko", "ja", "zh", "zh-TW", "de", "fr", "ru", "tr", "vi"] as const;

function sampleValue(snapshot: string, series: string): number {
  const line = snapshot.split("\n").find(row => row.startsWith(series + " "));
  return line === undefined ? Number.NaN : Number(line.slice(series.length + 1));
}

/**
 * Every combination a terminal can arrive in, read from the modules that declare them rather
 * than written out. A restated list is how a member added later leaves this cross product green
 * without ever being exercised.
 */
const TERMINAL_STATUSES = [undefined, ...REQUEST_TERMINAL_STATUSES] as const;
const CLOSE_REASONS = [undefined, ...REQUEST_CLOSE_REASONS] as const;
const STATUSES = [101, 200, 204, 399, 400, 429, 499, 500, 502] as const;

describe("terminal classification is stated once", () => {
  test("the exporter labels every fact exactly as the shared classifier does", () => {
    const disagreements: string[] = [];
    for (const status of STATUSES) {
      for (const terminalStatus of TERMINAL_STATUSES) {
        for (const closeReason of CLOSE_REASONS) {
          const facts: RequestOutcomeFacts = {
            status,
            ...(terminalStatus ? { terminalStatus } : {}),
            ...(closeReason ? { closeReason } : {}),
          };
          const metrics = createRequestMetricsOwner(1);
          metrics.recordFinalRequest({
            protocol: "responses",
            durationMs: 1,
            status,
            ...(terminalStatus ? { terminalStatus } : {}),
            ...(closeReason ? { closeReason } : {}),
          });
          const snapshot = metrics.snapshot();
          const expected = classifyRequestOutcome(facts);
          const observed = REQUEST_METRICS_RESULTS.filter(result => sampleValue(
            snapshot,
            `opencodex_logical_requests_total{protocol="responses",result="${result}"}`,
          ) === 1);
          if (observed.length !== 1 || observed[0] !== expected) {
            disagreements.push(`${status}/${terminalStatus ?? "-"}/${closeReason ?? "-"}: `
              + `exporter ${observed.join("+") || "none"} != ${expected}`);
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("the exporter's label set IS the shared vocabulary, not a copy of it", () => {
    expect(REQUEST_METRICS_RESULTS).toBe(REQUEST_OUTCOME_CLASSES);
  });

  /**
   * The three cases the disagreement actually showed up in. Written as literals because each one
   * is a specific incident shape, not a member of a roster that could grow.
   */
  test("a 200 that never delivered an answer does not read as success", () => {
    expect(classifyRequestOutcome({ status: 200, terminalStatus: "incomplete" })).toBe("incomplete");
    expect(classifyRequestOutcome({ status: 502, terminalStatus: "incomplete" })).toBe("incomplete");
    expect(classifyRequestOutcome({ status: 200, closeReason: "client_cancel" })).toBe("aborted");
    expect(classifyRequestOutcome({ status: 200 })).toBe("completed");
  });

  test("the dashboard calls the shared classifier instead of reading the status", () => {
    const page = readFileSync(repoPath("gui", "src", "pages", "Logs.tsx"), "utf8");
    expect(page).toContain("classifyRequestOutcome");
    expect(page).toContain("request-outcome");
  });
});

describe("send totals agree across surfaces", () => {
  /**
   * The budget charged four sends while the attempt rows account for three. Both numbers are
   * real and they answer different questions, so the surfaces have to agree about WHICH one the
   * send total is. An earlier draft returned max(sends, reserved) here, which is defensible on
   * its own and made the dashboard say four while the exporter said three -- two defensible
   * formulas are still two answers.
   */
  const spend = { sends: 3, settled: 3, unresolved: 1, reserved: 4 };

  test("the reported total is the recorded one, with the unexplained part beside it", () => {
    expect(requestPhysicalSends(spend)).toBe(3);
    expect(requestSettledSends(spend)).toBe(3);
    expect(requestUnresolvedSends(spend)).toBe(1);
  });

  test("the exporter's send total is the number the dashboard shows", () => {
    const metrics = createRequestMetricsOwner(1);
    metrics.recordFinalRequest({
      protocol: "responses",
      status: 200,
      durationMs: 1,
      terminalStatus: "completed",
      attempts: [
        { sendCount: 2, recoveryKinds: [] },
        { sendCount: 1, recoveryKinds: ["connection-reset"] },
      ],
      spendSends: spend.sends,
    });
    const exported = sampleValue(
      metrics.snapshot(),
      'opencodex_physical_sends_total{protocol="responses"}',
    );
    expect(exported).toBe(requestPhysicalSends(spend));
  });

  test("an absent or malformed spend record reports nothing rather than guessing", () => {
    expect(requestPhysicalSends(undefined)).toBe(0);
    expect(requestUnresolvedSends(undefined)).toBe(0);
    expect(requestPhysicalSends({ sends: -2, settled: -1, unresolved: 0 })).toBe(0);
  });

  test("the dashboard shows the send total and the unresolved remainder", () => {
    const page = readFileSync(repoPath("gui", "src", "pages", "Logs.tsx"), "utf8");
    expect(page).toContain("requestPhysicalSends");
    expect(page).toContain("requestUnresolvedSends");
  });
});

describe("the dashboard reaches only browser-safe contract modules", () => {
  /**
   * A type-only import still pulls the imported file's whole import graph into the dashboard's
   * TypeScript project, and that project sets `erasableSyntaxOnly`. Importing these names from
   * `src/usage/log.ts` dragged `node:fs`, `node:crypto` and the config barrel into the browser
   * build, where a parameter property fails to compile. The page must reach the leaf instead.
   */
  test("it imports the vocabulary from the contract leaf, not the ledger module", () => {
    const page = readFileSync(repoPath("gui", "src", "pages", "Logs.tsx"), "utf8");
    expect(page).toContain("src/usage/telemetry-contract");
    expect(page).not.toContain("src/usage/log");
  });

  test("the contract leaf has no imports at all", () => {
    const contract = readFileSync(repoPath("src", "usage", "telemetry-contract.ts"), "utf8");
    expect(contract.match(/^\s*import\s/gm)).toBeNull();
  });

  test("the outcome module reaches nothing but the contract", () => {
    const outcome = readFileSync(repoPath("src", "usage", "request-outcome.ts"), "utf8");
    const specifiers = [...outcome.matchAll(/from "([^"]+)"/g)].map(match => match[1]!);
    expect(specifiers).toEqual(["./telemetry-contract"]);
  });
});

describe("the dashboard recovery roster cannot drift from the durable one", () => {
  /**
   * The defect this replaces: the page declared its own nine-member union while the ledger wrote
   * thirteen, so four real causes rendered as "Unknown recovery reason". A source oracle rather
   * than a type check, because the page is compiled by a different project.
   */
  test("every durable recovery kind has a dashboard label", () => {
    const page = readFileSync(repoPath("gui", "src", "pages", "Logs.tsx"), "utf8");
    const block = page.slice(page.indexOf("const RECOVERY_KIND_KEYS"), page.indexOf("} as const satisfies Record<AttemptRecoveryKind"));
    const missing = ATTEMPT_RECOVERY_KIND_ROSTER.filter(kind => !block.includes(`"${kind}":`));
    expect(missing).toEqual([]);
  });

  test("the page derives the union rather than restating it", () => {
    const page = readFileSync(repoPath("gui", "src", "pages", "Logs.tsx"), "utf8");
    // Matched without depending on how the import is wrapped: the property is that the name
    // arrives from the contract leaf, not that it sits first on a single line.
    expect(/import type \{[^}]*\bAttemptRecoveryKind\b[^}]*\}\s*from\s*"[^"]*usage\/telemetry-contract"/s.test(page)).toBe(true);
    expect(page).not.toContain('type AttemptRecoveryKind =');
  });

  test("every label key the page names exists in all ten catalogs", () => {
    const page = readFileSync(repoPath("gui", "src", "pages", "Logs.tsx"), "utf8");
    const keys = [...new Set([...page.matchAll(/"(logs\.detail\.(?:attempt\.recovery|outcome|sends|cause|stage|resend)\.[a-zA-Z0-9]+)"/g)]
      .map(match => match[1]!))];
    expect(keys.length).toBeGreaterThan(ATTEMPT_RECOVERY_KIND_ROSTER.length);
    const gaps: string[] = [];
    for (const locale of LOCALES) {
      const catalog = readFileSync(repoPath("gui", "src", "i18n", `${locale}.ts`), "utf8");
      for (const key of keys) if (!catalog.includes(`"${key}"`)) gaps.push(`${locale}:${key}`);
    }
    expect(gaps).toEqual([]);
  });
});

describe("the exporter stays bounded", () => {
  test("no series carries a user, model, account or request identifier", () => {
    const metrics = createRequestMetricsOwner(1);
    for (let index = 0; index < 32; index += 1) {
      metrics.recordFinalRequest({
        protocol: "responses", status: 200, durationMs: 5, terminalStatus: "completed",
        attempts: [{ sendCount: 1, recoveryKinds: ["rate-limit-429"] }],
      });
    }
    const snapshot = metrics.snapshot();
    const labels = [...new Set([...snapshot.matchAll(/([a-z_]+)="/g)].map(match => match[1]!))];
    expect(labels.sort()).toEqual(["cause", "le", "protocol", "recovery", "result"]);
  });

  /**
   * The cause label is a counter label and never a histogram one. Fifteen causes across four
   * protocols is a fixed sixty series; the same label on a histogram would multiply that by the
   * bucket count to answer a question nobody asked.
   */
  test("the failure cause labels a counter and no histogram", () => {
    const snapshot = createRequestMetricsOwner(1).snapshot();
    const causeLines = snapshot.split("\n").filter(line => line.includes('cause="'));
    expect(causeLines.length).toBe(
      REQUEST_METRICS_PROTOCOLS.length * REQUEST_METRICS_FAILURE_CAUSES.length,
    );
    expect(causeLines.every(line => line.startsWith("opencodex_request_failures_total{"))).toBe(true);
    expect(causeLines.some(line => line.includes("_bucket") || line.includes("le="))).toBe(false);
  });
});

describe("the failure cause is derived once and reported everywhere", () => {
  /**
   * The recorder derives the cause; the exporter counts the value it was handed. Two derivations
   * of one answer is the disagreement this batch exists to remove, so this asserts the exporter
   * has no opinion of its own -- a fact carrying a cause the status alone would classify
   * differently is still counted under the cause it was given.
   */
  test("the exporter counts the recorder's cause rather than re-deriving one", () => {
    for (const cause of REQUEST_METRICS_FAILURE_CAUSES) {
      const metrics = createRequestMetricsOwner(1);
      metrics.recordFinalRequest({
        protocol: "responses", status: 200, durationMs: 1, terminalStatus: "failed", failureCause: cause,
      });
      const snapshot = metrics.snapshot();
      expect(sampleValue(snapshot, `opencodex_request_failures_total{protocol="responses",cause="${cause}"}`)).toBe(1);
    }
  });

  test("a request that delivered its answer contributes to no cause series", () => {
    const metrics = createRequestMetricsOwner(1);
    metrics.recordFinalRequest({ protocol: "responses", status: 200, durationMs: 1, terminalStatus: "completed" });
    const snapshot = metrics.snapshot();
    for (const cause of REQUEST_METRICS_FAILURE_CAUSES) {
      expect(sampleValue(snapshot, `opencodex_request_failures_total{protocol="responses",cause="${cause}"}`)).toBe(0);
    }
  });

  test("every cause the recorder can derive has a dashboard label", () => {
    const page = readFileSync(repoPath("gui", "src", "pages", "Logs.tsx"), "utf8");
    const block = page.slice(page.indexOf("const FAILURE_CAUSE_KEYS"), page.indexOf("} as const satisfies Record<RequestFailureCause"));
    const missing = REQUEST_METRICS_FAILURE_CAUSES.filter(cause => !block.includes(`"${cause}":`));
    expect(missing).toEqual([]);
  });

  /**
   * The verdict is computed at read time and must not appear in a durable shape. A row written
   * by an older build would otherwise assert a permission the current tables refuse, and there
   * would be no way to correct it.
   */
  test("the resend verdict is never persisted", () => {
    const ledger = readFileSync(repoPath("src", "usage", "log.ts"), "utf8");
    expect(ledger).toContain("failureStage");
    expect(ledger).toContain("failureCause");
    expect(ledger).not.toContain("resendPermission");
    const dto = readFileSync(repoPath("src", "server", "management", "shared.ts"), "utf8");
    expect(dto).toContain("resendPermission");
  });
});
