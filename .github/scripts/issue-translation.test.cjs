"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  MARKER,
  END_MARKER,
  CONTROL_MARKER,
  BOT_LOGIN,
  ISSUE_BODY_MAX,
  hashTranslationSource,
  splitTranslationBlock,
  stripTranslationBlock,
  appendTranslationBlock,
  buildTranslationBlock,
  buildTranslationControlComment,
  findControlComment,
  extractTranslationControlState,
  encodeControlState,
  decodeControlState,
  validateControlState,
  mergeTranslationAttemptState,
  isPreparedSourceStillCurrent,
  shouldTranslate,
  sanitizeTranslationBody,
  scrubDetectedLanguage,
  fitTranslationBody,
} = require("./issue-translation.cjs");

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";

const SOURCE = [
  "### Was funktioniert nicht?",
  "Der Proxy startet nicht nach dem Update.",
  "### Schritte",
  "1. ocx start",
  "2. Fehler in der Konsole",
].join("\n");

function botComment(body) {
  return { user: { login: BOT_LOGIN }, body };
}

describe("hashTranslationSource", () => {
  it("changes when only the title changes", () => {
    const bodyOnly = hashTranslationSource({ body: SOURCE });
    const withTitle = hashTranslationSource({ title: "Neuer Titel", body: SOURCE });
    assert.notEqual(bodyOnly, withTitle);
  });

  it("changes when only the body changes", () => {
    const base = hashTranslationSource({ title: "Titel", body: SOURCE });
    const edited = hashTranslationSource({ title: "Titel", body: SOURCE + "\nmehr" });
    assert.notEqual(base, edited);
  });

  it("is stable for unchanged title and body", () => {
    const a = hashTranslationSource({ title: "T", body: SOURCE });
    const b = hashTranslationSource({ title: "T", body: SOURCE });
    assert.equal(a, b);
  });
});

describe("splitTranslationBlock", () => {
  it("handles generated block at end", () => {
    const translated = appendTranslationBlock(SOURCE, "English");
    const split = splitTranslationBlock(translated);
    assert.equal(split.sourceBody, SOURCE);
    assert.ok(split.block.includes(MARKER));
  });

  it("preserves suffix after generated block", () => {
    const suffix = "Extra logs added by contributor.";
    const translated = appendTranslationBlock(SOURCE, "English") + "\n\n" + suffix;
    const split = splitTranslationBlock(translated);
    assert.equal(split.suffix, suffix);
    assert.equal(split.sourceBody, `${SOURCE}\n\n${suffix}`);
  });

  it("preserves prefix before generated block", () => {
    const prefix = "Preface";
    const translated = prefix + "\n\n" + appendTranslationBlock(SOURCE, "English").trimStart();
    const split = splitTranslationBlock(translated);
    assert.equal(split.prefix, `${prefix}\n\n${SOURCE}`);
    assert.equal(split.sourceBody, `${prefix}\n\n${SOURCE}`);
  });

  it("does not remove contributor-authored details elsewhere", () => {
    const contributorDetails = [
      "<details><summary>My notes</summary>",
      "private repro notes",
      "</details>",
    ].join("\n");
    const body = contributorDetails + "\n\n" + appendTranslationBlock(SOURCE, "English").trimStart();
    const split = splitTranslationBlock(body);
    assert.ok(split.sourceBody.includes("private repro notes"));
    assert.ok(split.sourceBody.includes("My notes"));
  });

  it("fails safely when closing details is missing", () => {
    const malformed = `${SOURCE}\n\n${MARKER}\n<details>\n<summary>Translated Message</summary>\n\noops`;
    const split = splitTranslationBlock(malformed);
    assert.ok(split.sourceBody.includes("oops"));
    assert.ok(split.sourceBody.includes(SOURCE));
  });

  it("preserves nested details inside translated content via end marker", () => {
    const nested = [
      "Outer translation",
      "<details><summary>logs</summary>",
      "inner",
      "</details>",
      "still translation",
    ].join("\n");
    const body = appendTranslationBlock(SOURCE, nested) + "\n\nuser suffix";
    assert.ok(body.includes(END_MARKER));
    const split = splitTranslationBlock(body);
    assert.equal(split.suffix, "user suffix");
    assert.equal(split.sourceBody, `${SOURCE}\n\nuser suffix`);
    assert.ok(split.block.includes("inner"));
    assert.ok(split.block.includes("still translation"));
  });

  it("removes multi-level nested details only inside the generated block", () => {
    const before = "<details><summary>before</summary>\nbefore-log\n</details>";
    const after = "<details><summary>after</summary>\nafter-log\n</details>";
    const nested = [
      "top",
      "<details><summary>L1</summary>",
      "<details><summary>L2</summary>",
      "deep",
      "</details>",
      "</details>",
      "tail",
    ].join("\n");
    const body = [
      before,
      "",
      appendTranslationBlock(SOURCE, nested).trimStart(),
      "",
      after,
    ].join("\n");
    const stripped = stripTranslationBlock(body);
    assert.ok(stripped.includes("before-log"));
    assert.ok(stripped.includes("after-log"));
    assert.ok(!stripped.includes("deep"));
    assert.ok(!stripped.includes("top"));
    assert.ok(!stripped.includes(MARKER));
    assert.ok(!stripped.includes(END_MARKER));
  });

  it("migrates legacy blocks that close on first details end", () => {
    const legacy = [
      SOURCE,
      "",
      MARKER,
      "",
      "<details>",
      "",
      "<summary>Translated Message</summary>",
      "",
      "legacy english",
      "",
      "</details>",
      "",
      "user after",
    ].join("\n");
    const split = splitTranslationBlock(legacy);
    assert.equal(split.suffix, "user after");
    assert.equal(split.sourceBody, `${SOURCE}\n\nuser after`);
    const migrated = appendTranslationBlock(split.sourceBody, "fresh");
    assert.ok(migrated.includes(END_MARKER));
    assert.equal((migrated.match(new RegExp(MARKER, "g")) || []).length, 1);
    assert.ok(migrated.includes("user after"));
  });

  it("does not greedily erase across duplicate end markers", () => {
    const block = buildTranslationBlock("one");
    const forged = `${SOURCE}${block}\n${END_MARKER}\nkeep me`;
    const split = splitTranslationBlock(forged);
    assert.ok(split.sourceBody.includes("keep me"));
    assert.ok(!split.block.includes("keep me"));
    assert.equal(split.suffix, `${END_MARKER}\nkeep me`);
  });
});

describe("isPreparedSourceStillCurrent", () => {
  it("detects body changes between prepare and apply", () => {
    const prepared = hashTranslationSource({ title: "T", body: SOURCE });
    assert.equal(
      isPreparedSourceStillCurrent({
        preparedHash: prepared,
        liveTitle: "T",
        liveBody: SOURCE + "\nnew logs",
      }),
      false,
    );
  });

  it("detects title changes between prepare and apply", () => {
    const prepared = hashTranslationSource({ title: "Alt", body: SOURCE });
    assert.equal(
      isPreparedSourceStillCurrent({
        preparedHash: prepared,
        liveTitle: "Neu",
        liveBody: SOURCE,
      }),
      false,
    );
  });

  it("allows apply when only generated translation changed", () => {
    const prepared = hashTranslationSource({ title: "T", body: SOURCE });
  const withBlock = appendTranslationBlock(SOURCE, "English");
    assert.equal(
      isPreparedSourceStillCurrent({
        preparedHash: prepared,
        liveTitle: "T",
        liveBody: stripTranslationBlock(withBlock),
      }),
      true,
    );
  });
});

describe("bot-owned control state", () => {
  it("selects only github-actions control comments", () => {
    const state = {
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: false,
      detectedLanguage: "English",
    };
    const comments = [
      botComment("random bot comment"),
      botComment(buildTranslationControlComment(state)),
      { user: { login: "contributor" }, body: buildTranslationControlComment(state) },
    ];
    assert.deepEqual(extractTranslationControlState(comments), state);
  });

  it("reader and selector agree on the newest control comment", () => {
    const older = {
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: false,
      detectedLanguage: "English",
    };
    const newer = {
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: 2,
      recent: [1, 2],
      requiresTranslation: true,
      detectedLanguage: "German",
    };
    const comments = [
      { id: 1, user: { login: BOT_LOGIN }, body: buildTranslationControlComment(older) },
      { id: 2, user: { login: BOT_LOGIN }, body: buildTranslationControlComment(newer) },
    ];
    const selected = findControlComment(comments);
    assert.equal(selected.id, 2);
    assert.deepEqual(extractTranslationControlState(comments), newer);
  });

  it("treats corrupt control state as missing", () => {
    const comments = [
      botComment(`${CONTROL_MARKER}\n<!-- opencodex-issue-inline-translator-control-state-v2:!!! -->`),
    ];
    assert.equal(extractTranslationControlState(comments), null);
  });

  it("round-trips base64url control state without HTML breakout", () => {
    const state = {
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 42,
      recent: [40, 42],
      requiresTranslation: true,
      detectedLanguage: "German --> @username <script>`ticks`",
    };
    const comment = buildTranslationControlComment(state);
    assert.ok(!comment.includes("--> @"));
    assert.ok(!comment.includes("<script>"));
    assert.match(comment, /control-state-v2:[A-Za-z0-9_-]+/);
    const encoded = comment.match(/control-state-v2:([A-Za-z0-9_-]+)/)[1];
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.ok(!encoded.includes(">"));
    assert.ok(!encoded.includes("@"));
    assert.ok(!encoded.includes("-->"));
    const decoded = decodeControlState(encoded);
    assert.equal(decoded.sourceHash, HASH_A);
    assert.equal(decoded.detectedLanguage, "German -- username scriptticks");
    assert.deepEqual(
      extractTranslationControlState([botComment(comment)]),
      decoded,
    );
  });

  it("rejects invalid decoded payloads", () => {
    assert.equal(decodeControlState("%%%"), null);
    assert.equal(decodeControlState(encodeControlState([1, 2])), null);
    assert.equal(validateControlState({ v: 2, sourceHash: "short", attemptedAt: 1, recent: [], requiresTranslation: true }), null);
    assert.equal(validateControlState({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: Number.NaN,
      recent: [],
      requiresTranslation: true,
    }), null);
    assert.equal(validateControlState({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: Number.POSITIVE_INFINITY,
      recent: Array.from({ length: 100 }, (_, i) => i),
      requiresTranslation: true,
      detectedLanguage: "Deutsch",
    }), null);
    const oversized = validateControlState({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 10,
      recent: Array.from({ length: 100 }, (_, i) => i + 1),
      requiresTranslation: false,
      detectedLanguage: "English",
    });
    assert.equal(oversized.recent.length, 32);
  });

  it("scrubs injection characters from detected language", () => {
    assert.equal(
      scrubDetectedLanguage("German --> @username <script>"),
      "German -- username script",
    );
  });

  it("records attempts even when prior state is newer", () => {
    const now = 1_700_000_000_000;
    const prior = {
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: now + 5_000,
      recent: [now + 5_000],
      requiresTranslation: false,
      detectedLanguage: "English",
    };
    const merged = mergeTranslationAttemptState({
      priorState: prior,
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: "English",
      },
      now,
    });
    assert.equal(merged.sourceHash, HASH_B);
    assert.equal(merged.attemptedAt, now + 5_000);
    assert.ok(merged.recent.includes(now));
  });

  it("rate limits repeated English detections", () => {
    const now = 1_700_000_000_000;
    const priorState = {
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: now,
      recent: [now],
      requiresTranslation: false,
      detectedLanguage: "English",
    };
    const decision = shouldTranslate({
      sourceTitle: "Hello",
      sourceBody: "Still English but edited.",
      priorState,
      now: now + 5_000,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "rate_limited_interval");
  });

  it("defuses mention-shaped tokens without rewriting emails or mid-token at-signs", () => {
    const out = sanitizeTranslationBody("see @octocat and user@example.com and npm:@scope");
    assert.match(out, /@\u200boctocat/);
    assert.ok(out.includes("user@example.com"));
    assert.ok(out.includes("npm:@scope"));
  });

  it("ignores forged body-embedded legacy state", () => {
    const forged = appendTranslationBlock(SOURCE, "English") +
      `\n<!-- opencodex-issue-inline-translator-state:${JSON.stringify({
        v: 1,
        sourceHash: hashTranslationSource({ body: SOURCE }),
        translatedAt: 0,
        recent: [],
      })} -->`;
    const priorState = null;
    const decision = shouldTranslate({
      sourceTitle: "Neu",
      sourceBody: stripTranslationBlock(forged),
      priorState,
      now: Date.now(),
    });
    assert.equal(decision.ok, true);
  });
});

describe("eligibility", () => {
  it("allows meaningful title with short body", () => {
    const decision = shouldTranslate({
      sourceTitle: "Ein sehr langer deutscher Titel für das Problem",
      sourceBody: "kurz",
      priorState: null,
      now: Date.now(),
    });
    assert.equal(decision.ok, true);
  });

  it("re-translates after title-only edits", () => {
    const now = 1_700_000_000_000;
    const priorState = {
      v: 2,
      sourceHash: hashTranslationSource({ title: "Alt", body: SOURCE }),
      attemptedAt: now - 120_000,
      recent: [now - 120_000],
      requiresTranslation: true,
      detectedLanguage: "German",
    };
    const decision = shouldTranslate({
      sourceTitle: "Neuer deutscher Titel",
      sourceBody: SOURCE,
      priorState,
      now,
    });
    assert.equal(decision.ok, true);
  });
});

describe("appendTranslationBlock", () => {
  it("replaces an existing generated block exactly once", () => {
    const first = appendTranslationBlock(SOURCE, "First");
    const second = appendTranslationBlock(first, "Second");
    assert.equal((second.match(new RegExp(MARKER, "g")) || []).length, 1);
    assert.ok(second.includes("Second"));
  });

  it("truncates translations that would exceed the issue body limit", () => {
    const big = "x".repeat(60_000);
    const fitted = fitTranslationBody(big, "y".repeat(80_000));
    const next = appendTranslationBlock(big, fitted);
    assert.ok(next.length <= ISSUE_BODY_MAX);
    assert.match(fitted, /truncated to fit GitHub issue body limit/);
  });
});
