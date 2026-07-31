# Anthropic adapter: reasoning "none" wrongly enables extended thinking

Date: 2026-07-01
Surface: src/adapters/anthropic.ts (request build).
Class: C2 (single adapter, wire-affecting, behavior + token-cost bug).
Status: SCAFFOLD - root-caused from code, fix designed, NOT yet applied.
Source: gajae/architect repo review (gpt-5.5), risk item 3a.

## Symptom (as reported)

reasoning "none" is truthy, so Claude extended thinking can be switched on
when the caller actually asked for NO reasoning. Two consequences:
1. Wasted tokens - a thinking budget is allocated for a turn meant to be plain.
2. temperature / top_p are silently dropped (extended thinking forbids
   them), so caller sampling controls vanish on a "no-reasoning" turn.

## Root cause (confirmed in code)

The gate is a bare truthiness check at ~line 243:

    if (parsed.options.reasoning) {
      ...
      body.thinking = { type: "enabled", budget_tokens: budget };
      delete body.temperature;
      delete body.top_p;
    }

parsed.options.reasoning is a string effort. Any non-empty string is truthy,
including "none". There is no "none" arm, so:
- the block runs and enables thinking,
- reasoningBudget("none") falls through the switch to default 8192
  (anthropic.ts ~line 46), allocating an 8k thinking budget,
- temperature / top_p get deleted.

So "none" produces the maximum-side-effect path rather than a no-op.

## What "none" should mean

Codex reasoning efforts seen elsewhere in the tree: minimal | low | medium |
high | xhigh | max, plus the disable sentinel none. For Anthropic, none
must mean: do NOT send thinking, and preserve temperature / top_p.

Open question (verify, do not assume): confirm the exact sentinel Codex emits
to disable reasoning on the Responses side - the literal string "none", or
undefined/absent? The fix must cover whatever the live wire actually sends.
Capture one real minimal/none Responses request before finalizing
(see 20_verification.md).

## Fix design (minimal, one-arm gate)

Guard the block on "reasoning present AND not a disable sentinel":

    const wantsThinking =
      typeof parsed.options.reasoning === "string" &&
      parsed.options.reasoning !== "none";

    if (wantsThinking) {
      // ...existing budget sizing + thinking enable + temp/top_p drop...
    }

Notes:
- Keep the existing budget math untouched; only the gate changes.
- Do NOT special-case "none" inside reasoningBudget; it should never be
  called for "none" once the gate is fixed. Optionally add an explicit
  case "none" that asserts, to catch future regressions - decide in B.
- Leaving temperature/top_p intact on a "none" turn is the point; verify a
  caller-supplied temperature survives.

## Blast radius

- Only the reasoning branch of the anthropic request builder.
- No change to streaming/parse, tools, or other adapters.
- Behavior change is strictly: "none" stops enabling thinking. Other efforts
  unchanged.
