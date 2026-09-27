import { expect, test } from "bun:test";
import {
  FIRST_PARTY_PROXY_STATUSES,
  normalizeSharedProxy,
  selectFirstPartyNotice,
  type FirstPartyNotice,
} from "../src/pages/claude-code-first-party";
import type { ClaudeCodeState } from "../src/pages/claude-code-types";

type Notices = readonly [FirstPartyNotice, FirstPartyNotice, FirstPartyNotice, FirstPartyNotice];

const expectedEligible: Record<ClaudeCodeState["sharedProxy"], Notices> = {
  none: [null, null, "notApplied", "notApplied"],
  live: ["residual", "shared", "shared", null],
  stopped: ["residual", "stopped", "stopped", "stopped"],
  disabled: ["residual", "disabled", "disabled", "disabled"],
  broken: ["residual", "broken", "broken", "broken"],
  foreign: ["foreign", "foreign", "foreign", "foreign"],
  local: ["local", "local", "local", "local"],
  unknown: ["unknown", "unknown", "unknown", "unknown"],
};

const expectedIneligible: Record<ClaudeCodeState["sharedProxy"], Notices> = {
  ...expectedEligible,
  stopped: ["residual", "routingOff", "routingOff", "routingOff"],
  broken: ["residual", "routingOff", "routingOff", "routingOff"],
};

for (const [interceptEligible, expected] of [[true, expectedEligible], [false, expectedIneligible]] as const) {
  for (const sharedProxy of FIRST_PARTY_PROXY_STATUSES) {
    const [neither, desktopOnly, cliOnly, both] = expected[sharedProxy];
    for (const [desktopFirstParty, cliFirstParty, notice] of [
      [false, false, neither],
      [true, false, desktopOnly],
      [false, true, cliOnly],
      [true, true, both],
    ] as const) {
      test(`${sharedProxy}: eligible ${interceptEligible}, Desktop ${desktopFirstParty}, CLI ${cliFirstParty}`, () => {
        expect(selectFirstPartyNotice({ sharedProxy, desktopFirstParty, cliFirstParty, interceptEligible })).toBe(notice);
      });
    }
  }
}

test("only missing status normalizes to none; invalid and future values warn", () => {
  for (const status of FIRST_PARTY_PROXY_STATUSES) expect(normalizeSharedProxy(status)).toBe(status);
  expect(normalizeSharedProxy("future")).toBe("unknown");
  expect(normalizeSharedProxy(42)).toBe("unknown");
  expect(normalizeSharedProxy(undefined)).toBe("none");
  expect(normalizeSharedProxy(null)).toBe("unknown");
});
