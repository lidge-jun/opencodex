import { describe, expect, test } from "bun:test";
import { isKiroRestatement } from "../src/adapters/kiro-restatement";

// Commentary/retry pairs modeled on the observed duplicate-answer sessions: the retry reworks
// spans of the commentary while adding nothing. The three pairs get progressively heavier
// rewording, so together they exercise the whole band the thresholds have to cover.
const COMMENTARY = "I'm the opencodex proxy talking to Kiro on your behalf. Think of me as the "
  + "translation layer that turns Codex Responses requests into Kiro conversation state, decodes "
  + "the event stream back, and keeps the turn honest rather than guessing when the model is done.\n\n"
  + "Right now I'm pointed at the runtime endpoint for your credential's region, so the region, "
  + "profile ARN, and refreshed access token all come from the Kiro credential store on this "
  + "machine and never from the request. Tool names are normalized on the way out and restored on "
  + "the way back, and the private completion tool never reaches your client.\n\nWhat should we look at?";

const RETRY = "I'm the opencodex proxy talking to Kiro on your behalf. Think of me as the "
  + "translation layer that turns Codex Responses requests into Kiro conversation state, decodes "
  + "the event stream back, and keeps the turn honest rather than assuming when the model has "
  + "finished.\n\nRight now I'm pointed at the runtime endpoint for your credential's region, so "
  + "the region, profile ARN, and refreshed access token are all read from the Kiro credential "
  + "store on this machine and never from the request. Tool names get normalized on the way out "
  + "and restored on the way back, and the private completion tool never reaches your client.\n\n"
  + "What should we look at?";

const HEAVIER_COMMENTARY = "I'm the opencodex proxy — the local process that lets Codex and Claude "
  + "Code speak to providers they were never built for.\n\nPractically speaking: I parse the "
  + "incoming request, pick an adapter, rewrite the payload for that provider's wire format, and "
  + "stream the response back as Responses events. I can fan a turn out to a web-search sidecar "
  + "when the request asks for it, and I carry per-provider retry policy so a reset connection or "
  + "an expired token does not surface as a failed turn.\n\nThere's a wrinkle with Kiro "
  + "specifically: its assistant text carries no dependable end-of-turn marker, so ordinary text "
  + "is treated as commentary and a private completion tool arbitrates the end of the turn. That "
  + "tool is consumed here and never shown to your client.\n\nWhat would you like to work on?";

const HEAVIER_RETRY = "I'm the opencodex proxy, the local process that lets Codex and Claude Code "
  + "talk to providers they were never built for.\n\nPractically speaking: I parse the incoming "
  + "request, choose an adapter, rewrite the payload for that provider's wire format, and stream "
  + "the response back as Responses events. I can fan a turn out to a web-search sidecar when the "
  + "request asks for one, and I carry per-provider retry policy so a reset connection or an "
  + "expired token never surfaces as a failed turn.\n\nThere's a wrinkle with Kiro in particular: "
  + "its assistant text has no dependable end-of-turn marker, so ordinary text counts as "
  + "commentary and a private completion tool decides the end of the turn. That tool is consumed "
  + "here and never reaches your client.\n\nWhat would you like to work on?";

const RESTRUCTURED_COMMENTARY = "I'm the opencodex proxy running in front of Kiro. I'm a "
  + "translation layer: I can rewrite Codex requests for the Kiro wire, decode its event stream, "
  + "map tools in both directions, and carry a turn through to a real answer rather than stopping "
  + "at the first plausible stream end.\n\nRight now I'm pointed at the Kiro runtime endpoint for "
  + "your credential's region, so I'm operating under its constraints: no parallel tool calls, no "
  + "structured output, no service tiers, and a context window that has to be tracked locally "
  + "because usage is not always reported.\n\nWhat would you like to work on?";

const RESTRUCTURED_RETRY = "I'm the opencodex proxy, a translation layer sitting in front of Kiro. "
  + "Instead of stopping at the first plausible stream end, I can rewrite Codex requests onto the "
  + "Kiro wire, decode the event stream it returns, map tools in both directions, and drive a turn "
  + "through to a genuine answer.\n\nAt the moment I'm aimed at the Kiro runtime endpoint for the "
  + "region on your credential, so its documented limits apply: no parallel tool calls, no "
  + "structured output, no service tiers, and a context window I have to track locally because "
  + "token usage is not always reported.\n\nWhat would you like to work on?";

describe("kiro restatement detection", () => {
  test("detects a reworded restatement of the preceding commentary", () => {
    expect(isKiroRestatement(COMMENTARY, RETRY)).toBe(true);
  });

  test("detects a heavily reworded restatement", () => {
    expect(isKiroRestatement(HEAVIER_COMMENTARY, HEAVIER_RETRY)).toBe(true);
  });

  test("detects a restatement that also restructures its opening", () => {
    expect(isKiroRestatement(RESTRUCTURED_COMMENTARY, RESTRUCTURED_RETRY)).toBe(true);
  });

  test("detects an exact repeat ignoring whitespace", () => {
    expect(isKiroRestatement("Task complete. Files updated.", "  Task complete.\nFiles updated.  ")).toBe(true);
  });

  test("detects a repunctuated and recapitalized repeat", () => {
    const previous = "Refactored the parser into a dedicated module, moved its tests alongside the "
      + "implementation, reran the affected suite, and confirmed the formatter and targeted lint "
      + "both stay clean after the change.";
    const candidate = "Refactored the parser into a dedicated module; moved its tests alongside the "
      + "implementation; reran the affected suite; and confirmed the formatter and targeted lint "
      + "both stay clean after the change!";
    expect(isKiroRestatement(previous, candidate)).toBe(true);
  });

  test("keeps short texts that differ by a single word", () => {
    expect(isKiroRestatement("Found the bug in kiro.ts", "Fixed the bug in kiro.ts")).toBe(false);
  });

  test("keeps a distinct answer after a progress update", () => {
    expect(isKiroRestatement(
      "I'll check the tests now.",
      "All 42 tests pass. The regression came from a stale snapshot.",
    )).toBe(false);
  });

  test("keeps a long retry that appends material content", () => {
    const candidate = `${COMMENTARY}\n\nOne thing worth flagging before you start: the bundled `
      + "context window for this model is smaller than the catalog advertises, the completion tool "
      + "is injected only when ordinary tools are present, and the bounded retry runs at most once "
      + "per turn so a model that never completes will surface as a retryable incomplete result.";
    expect(isKiroRestatement(COMMENTARY, candidate)).toBe(false);
  });

  test("keeps a long retry that repeats the opening then adds a new section", () => {
    const candidate = `${COMMENTARY}\n\nBefore you start, three things are worth knowing about the `
      + "current state of this proxy and the provider it is routing to.";
    expect(isKiroRestatement(COMMENTARY, candidate)).toBe(false);
  });

  test("keeps long answers that share only boilerplate phrasing", () => {
    const previous = "I'm going to start by reading the request translation in the Kiro adapter, "
      + "then the event stream decoder, and then the provider catalog, so that I can see how the "
      + "completion mode is chosen and where the bounded retry is issued before I change any "
      + "behavior at all in this adapter.";
    const candidate = "The root cause is that the duplicate check compares the retry against the "
      + "previous assistant text with exact equality, so a reworded restatement is treated as a "
      + "distinct answer and both copies reach the transcript, which is exactly what the two "
      + "assistant items in this session show.";
    expect(isKiroRestatement(previous, candidate)).toBe(false);
  });

  test("comparison is bounded for very long texts", () => {
    const long = "alpha beta gamma delta epsilon ".repeat(400);
    expect(isKiroRestatement(long, long)).toBe(true);
    expect(isKiroRestatement(long, `${long}zeta `.repeat(2))).toBe(false);
  });
});
