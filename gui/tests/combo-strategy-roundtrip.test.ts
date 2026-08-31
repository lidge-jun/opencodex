/**
 * Dashboard load -> save must not rewrite a combo's strategy.
 *
 * The runtime and management API accept five strategies. The GUI parser used to
 * collapse random/least-used/reset-window to failover, so saving an untouched
 * combo silently rewrote its strategy (and stripped weights for random).
 */
import { expect, test } from "bun:test";
import { groupCombos, parseComboList, toPutBody } from "../src/combo-workspace-data";

const strategies = ["failover", "round-robin", "random", "least-used", "reset-window"] as const;

function payloadWith(strategy: unknown, weight?: number) {
  return {
    combos: [
      {
        id: "demo",
        model: "combo/demo",
        strategy,
        stickyLimit: 3,
        targets: [
          weight !== undefined
            ? { provider: "openai", model: "gpt-5", weight }
            : { provider: "openai", model: "gpt-5" },
        ],
      },
    ],
  };
}

test("parse preserves every runtime strategy", () => {
  for (const strategy of strategies) {
    const [item] = parseComboList(payloadWith(strategy));
    expect(item?.strategy).toBe(strategy);
  }
});

test("unknown or missing strategies still normalize to failover", () => {
  for (const raw of [undefined, "sticky", 42]) {
    const [item] = parseComboList(payloadWith(raw));
    expect(item?.strategy).toBe("failover");
  }
});

test("saving an untouched combo round-trips merged strategies and random weights", () => {
  const [randomCombo] = parseComboList(payloadWith("random", 7));
  expect(randomCombo).toBeDefined();
  const randomBody = toPutBody(randomCombo!);
  expect(randomBody.combo.strategy).toBe("random");
  expect(randomBody.combo.targets[0]).toEqual({ provider: "openai", model: "gpt-5", weight: 7 });
  expect(randomBody.combo.stickyLimit).toBeUndefined();

  const [leastUsed] = parseComboList(payloadWith("least-used"));
  expect(toPutBody(leastUsed!).combo.strategy).toBe("least-used");

  const [resetWindow] = parseComboList(payloadWith("reset-window"));
  expect(toPutBody(resetWindow!).combo.strategy).toBe("reset-window");
});

test("round-robin still sends weights and stickyLimit", () => {
  const [roundRobin] = parseComboList(payloadWith("round-robin", 2));
  const body = toPutBody(roundRobin!);
  expect(body.combo.strategy).toBe("round-robin");
  expect(body.combo.targets[0]).toEqual({ provider: "openai", model: "gpt-5", weight: 2 });
  expect(body.combo.stickyLimit).toBe(3);
});

test("groupCombos keeps the three newer strategies in their own bucket", () => {
  const combos = strategies.map((strategy) => parseComboList(payloadWith(strategy))[0]!);
  const sections = groupCombos(combos);
  expect(sections.failover.map((c) => c.strategy)).toEqual(["failover"]);
  expect(sections.roundRobin.map((c) => c.strategy)).toEqual(["round-robin"]);
  expect(sections.other.map((c) => c.strategy)).toEqual([
    "random",
    "least-used",
    "reset-window",
  ]);
});
