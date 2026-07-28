"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  MARKER,
  END_MARKER,
  CONTROL_MARKER,
  BOT_LOGIN,
  ISSUE_BODY_MAX,
  DEFAULT_RATE_LIMIT,
  hashTranslationSource,
  splitTranslationBlock,
  stripTranslationBlock,
  appendTranslationBlock,
  buildTranslationBlock,
  buildTranslationControlComment,
  findControlComment,
  findStickyControlComment,
  extractTranslationControlState,
  resolveControlState,
  encodeControlState,
  decodeControlState,
  validateControlState,
  mergeTranslationAttemptState,
  persistTranslationControlState,
  upsertTranslationControlComment,
  isPreparedSourceStillCurrent,
  shouldTranslate,
  commentSourceTitle,
  shouldSkipCommentTranslation,
  shouldTranslateComment,
  buildTranslatedCommentBody,
  missingRequiredTranslationFields,
  sanitizeTranslationBody,
  scrubDetectedLanguage,
  isEnglishDetectedLanguage,
  detectedLanguageForControlPersist,
  bookkeepingLanguageLabel,
  stripOrphanBodyControlState,
  fitTranslationBody,
  shouldOmitVisibleBookkeeping,
  deleteVerifiedControlComments,
  MAX_CLOCK_SKEW_MS,
  collectMergedRecentFromComments,
  isValidControlTimestamp,
  pruneRecent,
  completedHashFor,
} = require("./issue-translation.cjs");

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";
const ORPHAN_MARKER = `<!-- opencodex-issue-inline-translator-control-state-v2:${"a".repeat(16)} -->`;

const SOURCE = [
  "### Was funktioniert nicht?",
  "Der Proxy startet nicht nach dem Update.",
  "### Schritte",
  "1. ocx start",
  "2. Fehler in der Konsole",
].join("\n");

function botComment(body, id = 1) {
  return { id, user: { login: BOT_LOGIN }, body };
}

function mockGithub(handlers = {}) {
  const calls = [];
  const github = {
    paginate: async (_fn, args) => {
      calls.push(["paginate", args]);
      return handlers.listComments || [];
    },
    rest: {
      issues: {
        listComments: async (args) => {
          calls.push(["list", args]);
          return { data: handlers.listComments || [] };
        },
        createComment: async (args) => {
          calls.push(["create", args]);
          if (handlers.create) return handlers.create(args);
          return { data: { id: handlers.nextId || 99, body: args.body, user: { login: BOT_LOGIN } } };
        },
        updateComment: async (args) => {
          calls.push(["update", args]);
          if (handlers.update) return handlers.update(args);
          return { data: { id: args.comment_id, body: args.body, user: { login: BOT_LOGIN } } };
        },
        deleteComment: async (args) => {
          calls.push(["delete", args]);
          if (handlers.delete) return handlers.delete(args);
          return {};
        },
        update: async (args) => {
          calls.push(["issueUpdate", args]);
          if (handlers.issueUpdate) return handlers.issueUpdate(args);
          return { data: args };
        },
      },
    },
  };
  return { github, calls };
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
  it("always includes visible bookkeeping, including English", () => {
    const german = buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    });
    assert.match(german, /Automated translation bookkeeping — detected language: German/);
    assert.equal(shouldOmitVisibleBookkeeping({
      requiresTranslation: true,
      detectedLanguage: "German",
    }), false);

    const english = buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: false,
      detectedLanguage: "English",
    });
    assert.match(english, /Automated translation bookkeeping — detected language: English/);
    assert.equal(shouldOmitVisibleBookkeeping({
      requiresTranslation: false,
      detectedLanguage: "English",
    }), false);
  });

  it("incomplete AI/parse failures bookkeep as unknown, never false-English", async () => {
    assert.equal(
      detectedLanguageForControlPersist({ detectedLanguage: "", sourceComplete: false }),
      "unknown",
    );
    assert.equal(
      detectedLanguageForControlPersist({ detectedLanguage: undefined, sourceComplete: false }),
      "unknown",
    );
    assert.equal(
      detectedLanguageForControlPersist({ detectedLanguage: "unknown", sourceComplete: false }),
      "unknown",
    );
    assert.equal(
      detectedLanguageForControlPersist({ detectedLanguage: "English", sourceComplete: false }),
      "unknown",
    );
    assert.equal(
      detectedLanguageForControlPersist({ detectedLanguage: "", sourceComplete: true }),
      "English",
    );
    assert.equal(
      detectedLanguageForControlPersist({ detectedLanguage: "English", sourceComplete: true }),
      "English",
    );
    assert.equal(bookkeepingLanguageLabel({ requiresTranslation: false, detectedLanguage: null }), "unknown");
    assert.equal(bookkeepingLanguageLabel({ requiresTranslation: false, detectedLanguage: "English" }), "English");

    const { github, calls } = mockGithub({ nextId: 77 });
    const result = await persistTranslationControlState({
      github,
      owner: "o",
      repo: "r",
      issue_number: 9,
      comments: [],
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: detectedLanguageForControlPersist({
          detectedLanguage: "",
          sourceComplete: false,
        }),
        sourceComplete: false,
      },
      now: 100,
    });
    assert.equal(result.state.sourceHash, "0000000000000000");
    assert.equal(result.state.detectedLanguage, "unknown");
    assert.match(calls[0][1].body, /detected language: unknown/);
    assert.doesNotMatch(calls[0][1].body, /detected language: English/);
    // Attempt counted (recent) but source stays retryable.
    assert.deepEqual(result.state.recent, [100]);
    assert.equal(completedHashFor(result.state, "issue"), null);
  });

  it("English creates a bot comment with visible English bookkeeping", async () => {
    const { github, calls } = mockGithub({ nextId: 42 });
    const result = await persistTranslationControlState({
      github,
      owner: "o",
      repo: "r",
      issue_number: 7,
      comments: [],
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: "English",
        sourceComplete: true,
      },
      now: 100,
    });
    assert.equal(result.storage, "comment");
    assert.equal(result.markerOnly, false);
    assert.equal(result.comment.id, 42);
    assert.deepEqual(calls.map((c) => c[0]), ["create"]);
    assert.match(calls[0][1].body, new RegExp(CONTROL_MARKER));
    assert.match(calls[0][1].body, /Automated translation bookkeeping — detected language: English/);
    assert.equal(extractTranslationControlState([botComment(calls[0][1].body, 42)]).sourceHash, HASH_A);
  });

  it("English updates the canonical bot comment instead of creating duplicates", async () => {
    const priorBody = buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: false,
      detectedLanguage: "English",
    });
    const prior = botComment(priorBody, 11);
    const { github, calls } = mockGithub();
    const result = await persistTranslationControlState({
      github,
      owner: "o",
      repo: "r",
      issue_number: 7,
      comments: [prior],
      priorState: extractTranslationControlState([prior]),
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: "English",
        sourceComplete: true,
      },
      now: 200,
    });
    assert.equal(result.comment.id, 11);
    assert.deepEqual(calls.map((c) => c[0]), ["update"]);
    assert.equal(calls[0][1].comment_id, 11);
    assert.match(calls[0][1].body, /Automated translation bookkeeping — detected language: English/);
  });

  it("updates the oldest sticky control comment even when its state is corrupt", async () => {
    const corrupt = botComment(
      `${CONTROL_MARKER}\n<!-- opencodex-issue-inline-translator-control-state-v2:!!! -->`,
      3,
    );
    const validNewer = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: 50,
      recent: [50],
      requiresTranslation: false,
      detectedLanguage: "English",
    }), 9);
    const { github, calls } = mockGithub();
    const result = await persistTranslationControlState({
      github,
      owner: "o",
      repo: "r",
      issue_number: 7,
      comments: [corrupt, validNewer],
      priorState: extractTranslationControlState([corrupt, validNewer]),
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: "English",
        sourceComplete: true,
      },
      now: 100,
    });
    assert.equal(findStickyControlComment([corrupt, validNewer]).id, 3);
    assert.equal(result.comment.id, 3);
    assert.deepEqual(calls.map((c) => c[0]), ["update", "delete"]);
    assert.equal(calls[0][1].comment_id, 3);
    assert.match(calls[0][1].body, /detected language: English/);
    assert.equal(calls[1][1].comment_id, 9);
  });

  it("non-English persist writes or updates a visible bot-owned comment", async () => {
    const { github, calls } = mockGithub({ nextId: 50 });
    const created = await persistTranslationControlState({
      github,
      owner: "o",
      repo: "r",
      issue_number: 11,
      comments: [],
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: true,
        detectedLanguage: "German",
        sourceComplete: true,
      },
      now: 100,
    });
    assert.equal(created.storage, "comment");
    assert.equal(created.markerOnly, false);
    assert.equal(created.comment.id, 50);
    assert.match(calls[0][1].body, /detected language: German/);

    const prior = botComment(calls[0][1].body, 50);
    calls.length = 0;
    const updated = await persistTranslationControlState({
      github,
      owner: "o",
      repo: "r",
      issue_number: 11,
      comments: [prior],
      priorState: extractTranslationControlState([prior]),
      attempt: {
        sourceHash: HASH_B,
        requiresTranslation: true,
        detectedLanguage: "French",
        sourceComplete: true,
      },
      now: 200,
    });
    assert.equal(updated.storage, "comment");
    assert.deepEqual(calls.map((c) => c[0]), ["update"]);
    assert.equal(calls[0][1].comment_id, 50);
    assert.match(calls[0][1].body, /detected language: French/);
  });

  it("ignores author comments containing the control marker", () => {
    const forged = {
      id: 9,
      user: { login: "attacker" },
      body: buildTranslationControlComment({
        v: 2,
        sourceHash: HASH_B,
        attemptedAt: 99,
        recent: [99],
        requiresTranslation: false,
        detectedLanguage: "English",
      }),
    };
    const bot = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    }), 10);
    assert.equal(resolveControlState([forged, bot]).sourceHash, HASH_A);
    assert.equal(findControlComment([forged, bot]).id, 10);
  });

  it("treats corrupt control state as missing", () => {
    const comments = [
      botComment(`${CONTROL_MARKER}\n<!-- opencodex-issue-inline-translator-control-state-v2:!!! -->`),
    ];
    assert.equal(extractTranslationControlState(comments), null);
    assert.equal(resolveControlState(comments), null);
  });

  it("never treats the issue body as authoritative control state", () => {
    const orphan = `${SOURCE}\n\n<!-- opencodex-issue-inline-translator-control-state-v2:${encodeControlState({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: false,
      detectedLanguage: "English",
    })} -->\n`;
    assert.equal(resolveControlState([], 1), null);
    assert.equal(extractTranslationControlState([]), null);
    assert.equal(stripOrphanBodyControlState(orphan).includes("control-state-v2:"), false);
  });

  it("failed sticky update preserves existing control comments and does not delete", async () => {
    // Corrupt sticky comment is still the upsert target; update failure must
    // not cascade into deleting it (or any sibling) as "redundant."
    const stale = botComment(
      `${CONTROL_MARKER}\n<!-- opencodex-issue-inline-translator-control-state-v2:!!! -->`,
      5,
    );
    const { github, calls } = mockGithub({
      update: async () => {
        throw new Error("API update failed");
      },
    });
    await assert.rejects(
      () => persistTranslationControlState({
        github,
        owner: "o",
        repo: "r",
        issue_number: 1,
        comments: [stale],
        attempt: {
          sourceHash: HASH_A,
          requiresTranslation: false,
          detectedLanguage: "English",
          sourceComplete: true,
        },
      }),
      /persistence failed/,
    );
    assert.deepEqual(calls.map((c) => c[0]), ["update"]);
    assert.equal(calls[0][1].comment_id, 5);
    assert.ok(!calls.some((c) => c[0] === "delete"));
    assert.equal(findControlComment([stale]), null);
    assert.equal(findStickyControlComment([stale]).id, 5);
  });

  it("re-fetches comments when none are supplied and still verifies authorship", async () => {
    const forged = {
      id: 9,
      user: { login: "attacker" },
      body: `please ignore ${CONTROL_MARKER} forged`,
    };
    const bot = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    }), 10);
    const { github, calls } = mockGithub({ listComments: [forged, bot] });
    const result = await deleteVerifiedControlComments({
      github,
      owner: "o",
      repo: "r",
      issue_number: 1,
      commentIds: [9, 10],
    });
    assert.deepEqual(result.deleted, [10]);
    assert.deepEqual(result.skipped, [9]);
    assert.ok(calls.some((c) => c[0] === "paginate"));
  });

  it("failed comment update preserves the previous comment", async () => {
    const priorBody = buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: false,
      detectedLanguage: "English",
    });
    const prior = botComment(priorBody, 8);
    const { github, calls } = mockGithub({
      update: async () => {
        throw new Error("API update failed");
      },
    });
    await assert.rejects(
      () => persistTranslationControlState({
        github,
        owner: "o",
        repo: "r",
        issue_number: 1,
        comments: [prior],
        priorState: extractTranslationControlState([prior]),
        attempt: {
          sourceHash: HASH_A,
          requiresTranslation: false,
          detectedLanguage: "English",
        sourceComplete: true,
      },
        now: 200,
      }),
      /persistence failed/,
    );
    assert.deepEqual(calls.map((c) => c[0]), ["update"]);
    assert.ok(!calls.some((c) => c[0] === "delete"));
    assert.equal(extractTranslationControlState([prior]).sourceHash, HASH_B);
  });

  it("deletes redundant bot comments only after sticky replacement succeeds", async () => {
    const older = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    }), 1);
    const newer = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 2,
      recent: [1, 2],
      requiresTranslation: false,
      detectedLanguage: "English",
    }), 2);
    const { github, calls } = mockGithub();
    const result = await persistTranslationControlState({
      github,
      owner: "o",
      repo: "r",
      issue_number: 1,
      comments: [older, newer],
      priorState: extractTranslationControlState([older, newer]),
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: "English",
        sourceComplete: true,
      },
      now: 300,
    });
    // Sticky = oldest id; update it in place and delete the newer duplicate.
    assert.equal(result.comment.id, 1);
    assert.deepEqual(calls.map((c) => c[0]), ["update", "delete"]);
    assert.equal(calls[0][1].comment_id, 1);
    assert.equal(calls[1][1].comment_id, 2);
    assert.deepEqual(result.cleanup.deleted, [2]);
  });

  it("cleanup failure leaves valid fallback comments intact", async () => {
    const older = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    }), 1);
    const newer = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 2,
      recent: [1, 2],
      requiresTranslation: false,
      detectedLanguage: "English",
    }), 2);
    const { github, calls } = mockGithub({
      delete: async () => {
        throw new Error("delete denied");
      },
    });
    const result = await persistTranslationControlState({
      github,
      owner: "o",
      repo: "r",
      issue_number: 1,
      comments: [older, newer],
      priorState: extractTranslationControlState([older, newer]),
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: "English",
        sourceComplete: true,
      },
      now: 300,
    });
    assert.equal(result.comment.id, 1);
    assert.equal(result.cleanup.failed.length, 1);
    assert.equal(result.cleanup.failed[0].id, 2);
    assert.ok(calls.some((c) => c[0] === "update"));
    // Newer duplicate remains when delete fails — durable fallback remains.
    assert.equal(extractTranslationControlState([older, newer]).sourceHash, HASH_A);
    assert.equal(extractTranslationControlState([older]).sourceHash, HASH_B);
  });

  it("cooldown and hourly limits survive repeated issue events via bot comments", () => {
    const now = 1_700_000_000_000;
    const body = buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: now,
      recent: [now],
      requiresTranslation: false,
      detectedLanguage: "English",
    });
    const priorState = resolveControlState([botComment(body)]);
    const decision = shouldTranslate({
      sourceTitle: "Hello",
      sourceBody: "Still English but edited enough to change the hash.",
      priorState,
      now: now + 5_000,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "rate_limited_interval");

    const hourly = resolveControlState([botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: now,
      recent: Array.from({ length: 10 }, (_, i) => now - i * 60_000),
      requiresTranslation: false,
      detectedLanguage: "English",
    }))]);
    const hourlyDecision = shouldTranslate({
      sourceTitle: "Hello again",
      sourceBody: "Another English edit that would otherwise probe the model.",
      priorState: hourly,
      now: now + 120_000,
    });
    assert.equal(hourlyDecision.ok, false);
    assert.equal(hourlyDecision.reason, "rate_limited_hourly");
  });

  it("rapid sequential edits cannot invoke the model repeatedly", async () => {
    const { github, calls } = mockGithub({ nextId: 3 });
    const first = await persistTranslationControlState({
      github,
      owner: "o",
      repo: "r",
      issue_number: 9,
      comments: [],
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: "English",
        sourceComplete: true,
      },
      now: 1_000,
    });
    const comments = [botComment(first.comment.body, first.comment.id)];
    const priorState = resolveControlState(comments);
    const second = shouldTranslate({
      sourceTitle: "Edit two",
      sourceBody: "Changed body content that must still be rate limited.",
      priorState,
      now: 1_000 + 10_000,
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "rate_limited_interval");
    assert.equal(calls.filter((c) => c[0] === "create").length, 1);
  });

  it("persistence never mutates the issue title or body", async () => {
    const { github, calls } = mockGithub();
    await persistTranslationControlState({
      github,
      owner: "o",
      repo: "r",
      issue_number: 9,
      comments: [],
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: "English",
        sourceComplete: true,
      },
    });
    assert.ok(!calls.some((c) => c[0] === "issueUpdate"));
  });

  it("selects only github-actions control comments", () => {
    const state = {
      v: 2,
      sourceHash: HASH_A,
      sourceHashes: { issue: HASH_A },
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
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
      sourceHashes: { issue: HASH_A },
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    };
    const newer = {
      v: 2,
      sourceHash: HASH_B,
      sourceHashes: { issue: HASH_B },
      attemptedAt: 2,
      recent: [1, 2],
      requiresTranslation: true,
      detectedLanguage: "Japanese",
    };
    const comments = [
      { id: 1, user: { login: BOT_LOGIN }, body: buildTranslationControlComment(older) },
      { id: 2, user: { login: BOT_LOGIN }, body: buildTranslationControlComment(newer) },
    ];
    const selected = findControlComment(comments);
    assert.equal(selected.id, 2);
    assert.deepEqual(extractTranslationControlState(comments), newer);
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

  it("heals slightly-future prior within skew and uses wall-clock attemptedAt", () => {
    const now = 1_700_000_000_000;
    const prior = {
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: now + 5_000,
      recent: [now + 5_000],
      requiresTranslation: false,
      detectedLanguage: "English",
    };
    assert.equal(isValidControlTimestamp(prior.attemptedAt, now), true);
    const merged = mergeTranslationAttemptState({
      priorState: prior,
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: "English",
        sourceComplete: true,
      },
      now,
    });
    assert.equal(merged.sourceHash, HASH_A);
    assert.equal(merged.attemptedAt, now);
    assert.ok(merged.recent.includes(now));
    assert.ok(merged.recent.includes(now + 5_000));
  });

  it("rejects far-future attemptedAt and strips far-future recent entries", () => {
    const now = 1_700_000_000_000;
    const far = now + MAX_CLOCK_SKEW_MS + 60_000;
    assert.equal(validateControlState({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: far,
      recent: [now, far],
      requiresTranslation: false,
      detectedLanguage: "English",
    }, now), null);

    const withinSkew = validateControlState({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: now + 1_000,
      recent: [now - 1_000, far, now + 1_000],
      requiresTranslation: false,
      detectedLanguage: "English",
    }, now);
    assert.equal(withinSkew.attemptedAt, now + 1_000);
    assert.deepEqual(withinSkew.recent, [now - 1_000, now + 1_000]);
  });

  it("corrupt far-future comment does not outrank a valid current comment", () => {
    const now = 1_700_000_000_000;
    const valid = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: now,
      recent: [now],
      requiresTranslation: false,
      detectedLanguage: "English",
    }), 1);
    const poisonedBody = [
      CONTROL_MARKER,
      `<!-- opencodex-issue-inline-translator-control-state-v2:${encodeControlState({
        v: 2,
        sourceHash: HASH_B,
        attemptedAt: now + MAX_CLOCK_SKEW_MS + 86_400_000,
        recent: [now + MAX_CLOCK_SKEW_MS + 86_400_000],
        requiresTranslation: false,
        detectedLanguage: "English",
      })} -->`,
    ].join("\n");
    const poisoned = botComment(poisonedBody, 2);
    assert.equal(findControlComment([valid, poisoned], now).id, 1);
    assert.equal(resolveControlState([valid, poisoned], 1, now).sourceHash, HASH_A);
  });

  it("mergeTranslationAttemptState ignores poisoned far-future prior", () => {
    const now = 1_700_000_000_000;
    const merged = mergeTranslationAttemptState({
      priorState: {
        v: 2,
        sourceHash: HASH_B,
        attemptedAt: now + MAX_CLOCK_SKEW_MS + 1,
        recent: [now + MAX_CLOCK_SKEW_MS + 1],
        requiresTranslation: false,
        detectedLanguage: "English",
      },
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: "English",
        sourceComplete: true,
      },
      now,
    });
    assert.equal(merged.sourceHash, HASH_A);
    assert.equal(merged.attemptedAt, now);
    assert.deepEqual(merged.recent, [now]);
  });

  it("canonicalisation preserves valid bounded recent history across comments", () => {
    const now = 1_700_000_000_000;
    const older = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: now - 120_000,
      recent: [now - 120_000, now - 60_000],
      requiresTranslation: false,
      detectedLanguage: "English",
    }), 1);
    const newer = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: now - 10_000,
      recent: [now - 10_000],
      requiresTranslation: false,
      detectedLanguage: "English",
    }), 2);
    const merged = collectMergedRecentFromComments(
      [older, newer],
      extractTranslationControlState([older, newer], now),
      now,
    );
    assert.deepEqual(merged, [now - 120_000, now - 60_000, now - 10_000]);
  });

  it("strips trailing obsolete markers without treating them as control state", () => {
    const encoded = encodeControlState({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: false,
      detectedLanguage: "English",
    });
    const orphan = `${SOURCE}\n\n<!-- opencodex-issue-inline-translator-control-state-v2:${encoded} -->\n`;
    assert.equal(extractTranslationControlState([]), null);
    assert.equal(stripOrphanBodyControlState(orphan).includes("control-state-v2:"), false);
    assert.ok(stripOrphanBodyControlState(orphan).includes("Proxy startet nicht"));
  });

  it("preserves author whitespace when stripping a trailing obsolete marker", () => {
    const fixtures = [
      [`${SOURCE}\n\n${ORPHAN_MARKER}`, `${SOURCE}\n\n`],
      [`${SOURCE}\n\n${ORPHAN_MARKER}\n`, `${SOURCE}\n\n`],
      [`${SOURCE}   \n${ORPHAN_MARKER}\t`, `${SOURCE}   \n`],
      [`keep   \n${ORPHAN_MARKER}\n`, "keep   \n"],
    ];
    for (const [input, expected] of fixtures) {
      assert.equal(stripOrphanBodyControlState(input), expected);
    }
  });

  it("leaves marker-like author content inside fences, quotes, and prose untouched", () => {
    const fenced = [
      "Repro:",
      "```html",
      ORPHAN_MARKER,
      "```",
      "",
    ].join("\n");
    assert.equal(stripOrphanBodyControlState(fenced), fenced);

    const quoted = `> saw this token ${ORPHAN_MARKER} in the log\n`;
    assert.equal(stripOrphanBodyControlState(quoted), quoted);

    const prose = `Please ignore ${ORPHAN_MARKER} if present.\nMore text.`;
    assert.equal(stripOrphanBodyControlState(prose), prose);

    const mid = `pre\n${ORPHAN_MARKER}\npost`;
    assert.equal(stripOrphanBodyControlState(mid), mid);
  });

  it("translation application preserves marker-like author content", () => {
    const body = [
      SOURCE,
      "",
      "```",
      ORPHAN_MARKER,
      "```",
    ].join("\n");
    const next = appendTranslationBlock(body, "English translation of the report.");
    assert.ok(next.includes(ORPHAN_MARKER));
    assert.ok(next.includes(MARKER));
  });

  it("stale-source checking detects actual author edits after safe normalisation", () => {
    const prepared = hashTranslationSource({
      title: "T",
      body: stripOrphanBodyControlState(`${SOURCE}\n\n${ORPHAN_MARKER}`),
    });
    assert.equal(
      isPreparedSourceStillCurrent({
        preparedHash: prepared,
        liveTitle: "T",
        liveBody: stripOrphanBodyControlState(`${SOURCE}\n\n${ORPHAN_MARKER}`),
      }),
      true,
    );
    assert.equal(
      isPreparedSourceStillCurrent({
        preparedHash: prepared,
        liveTitle: "T",
        liveBody: stripOrphanBodyControlState(`${SOURCE}\nextra\n\n${ORPHAN_MARKER}`),
      }),
      false,
    );
  });

  it("rate limits repeated non-ASCII detections", () => {
    const now = 1_700_000_000_000;
    const priorState = {
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: now,
      recent: [now],
      requiresTranslation: false,
      detectedLanguage: "German",
    };
    const decision = shouldTranslate({
      sourceTitle: "Immer noch kaputt",
      sourceBody: "Der Proxy antwortet weiterhin mit Fehlern nach dem Update.",
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

  it("deleteVerifiedControlComments skips author-forged marker comments", async () => {
    const forged = {
      id: 9,
      user: { login: "attacker" },
      body: `please ignore ${CONTROL_MARKER} forged`,
    };
    const bot = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    }), 10);
    const { github, calls } = mockGithub();
    const result = await deleteVerifiedControlComments({
      github,
      owner: "o",
      repo: "r",
      issue_number: 1,
      commentIds: [9, 10, -1],
      comments: [forged, bot],
    });
    assert.deepEqual(result.deleted, [10]);
    assert.deepEqual(result.skipped, [9]);
    assert.deepEqual(calls.filter((c) => c[0] === "delete").map((c) => c[1].comment_id), [10]);
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

describe("issue comment translation", () => {
  const koreanComment = "관련: #508 (같은 Kiro adapter의 컨텍스트 토큰 보고 문제).";

  it("skips bots, control comments, and pull-request threads", () => {
    assert.equal(
      shouldSkipCommentTranslation({ user: { login: "github-actions[bot]", type: "Bot" }, body: koreanComment }),
      "bot_author",
    );
    assert.equal(
      shouldSkipCommentTranslation({ user: { login: "human", type: "User" }, body: CONTROL_MARKER + "\nx" }),
      "control_comment",
    );
    assert.equal(
      shouldSkipCommentTranslation(
        { id: 1, user: { login: "human", type: "User" }, body: koreanComment },
        { pull_request: { url: "https://example/pr/1" } },
      ),
      "pull_request",
    );
    assert.equal(
      shouldSkipCommentTranslation({ id: 1, user: { login: "human", type: "User" }, body: koreanComment }),
      null,
    );
  });

  it("hashes comments under comment:<id> so they do not collide with issue hashes", () => {
    const issueHash = hashTranslationSource({ title: "t", body: koreanComment });
    const commentHash = hashTranslationSource({
      title: commentSourceTitle(99),
      body: koreanComment,
    });
    assert.notEqual(issueHash, commentHash);
    assert.equal(commentSourceTitle(99), "comment:99");
  });

  it("allows a meaningful non-English comment and builds an in-place translation block", () => {
    const decision = shouldTranslateComment({
      comment: { id: 5084167162, user: { login: "jhste102lab", type: "User" }, body: koreanComment },
      issue: { number: 507 },
      priorState: null,
      now: Date.now(),
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.sourceBody, koreanComment);
    assert.equal(decision.sourceTitle, "comment:5084167162");

    const next = buildTranslatedCommentBody(
      decision.sourceBody,
      "Related: #508 (same Kiro adapter context-token reporting issue).",
      "Korean",
    );
    assert.ok(next.startsWith(koreanComment));
    assert.ok(next.includes(MARKER));
    assert.ok(next.includes("Translated Message"));
    assert.ok(next.includes("Original language: Korean"));
    assert.equal(stripTranslationBlock(next), koreanComment);
  });

  it("rejects comments without a usable numeric id", () => {
    for (const id of [undefined, null, "5084167162", 0, -1, 1.5]) {
      const decision = shouldTranslateComment({
        comment: { id, user: { login: "human", type: "User" }, body: koreanComment },
        priorState: null,
        now: 1_700_000_000_000,
      });
      assert.equal(decision.ok, false, String(id));
      assert.equal(decision.reason, "invalid_comment_id", String(id));
    }
  });

  it("skips unchanged comment bodies via source hash", () => {
    const comment = { id: 7, user: { login: "human", type: "User" }, body: koreanComment };
    const first = shouldTranslateComment({ comment, priorState: null, now: 1_700_000_000_000 });
    assert.equal(first.ok, true);
    const completed = mergeTranslationAttemptState({
      priorState: null,
      attempt: {
        sourceHash: first.sourceHash,
        sourceKey: first.sourceKey,
        requiresTranslation: true,
        detectedLanguage: "Korean",
        sourceComplete: true,
      },
      now: 1_700_000_000_000 - 120_000,
    });
    const second = shouldTranslateComment({
      comment,
      priorState: completed,
      now: 1_700_000_000_000,
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "unchanged_source");
  });

  it("keeps issue and comment completed hashes independent", () => {
    const now = 1_700_000_000_000;
    const issueTitle = "Meaningful German title for translation";
    const issueBody = "Ein ausreichend langer deutscher Issue-Text für den Test.";
    const issueHash = hashTranslationSource({ title: issueTitle, body: issueBody });
    const commentKey = commentSourceTitle(42);
    const commentHash = hashTranslationSource({ title: commentKey, body: koreanComment });

    const afterIssue = mergeTranslationAttemptState({
      priorState: null,
      attempt: {
        sourceHash: issueHash,
        sourceKey: "issue",
        requiresTranslation: true,
        detectedLanguage: "German",
        sourceComplete: true,
      },
      now,
    });
    assert.equal(afterIssue.sourceHashes.issue, issueHash);

    const afterComment = mergeTranslationAttemptState({
      priorState: afterIssue,
      attempt: {
        sourceHash: commentHash,
        sourceKey: commentKey,
        requiresTranslation: true,
        detectedLanguage: "Korean",
        sourceComplete: true,
      },
      now: now + 120_000,
    });
    assert.equal(afterComment.sourceHashes.issue, issueHash);
    assert.equal(afterComment.sourceHashes[commentKey], commentHash);

    assert.equal(
      shouldTranslate({
        sourceTitle: issueTitle,
        sourceBody: issueBody,
        sourceKey: "issue",
        priorState: afterComment,
        now: now + 240_000,
      }).reason,
      "unchanged_source",
    );
    assert.equal(
      shouldTranslateComment({
        comment: { id: 42, user: { login: "human", type: "User" }, body: koreanComment },
        priorState: afterComment,
        now: now + 240_000,
      }).reason,
      "unchanged_source",
    );
  });

  it("enforces minSourceChars on stripped comment body only", () => {
    const shortBody = "관련: #508"; // shorter than default minSourceChars (20)
    assert.ok(shortBody.length < DEFAULT_RATE_LIMIT.minSourceChars);
    assert.ok(commentSourceTitle(999999999).length >= 8);

    const decision = shouldTranslateComment({
      comment: { id: 999999999, user: { login: "human", type: "User" }, body: shortBody },
      issue: { number: 507 },
      priorState: null,
      now: Date.now(),
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "source_too_short");
  });

  it("short comments do not become eligible via comment:<id> namespace padding", () => {
    // Namespace alone is long enough to satisfy a naive title+body length check.
    const id = 123456789012345;
    const title = commentSourceTitle(id);
    assert.ok((title + "\nx").length >= DEFAULT_RATE_LIMIT.minSourceChars);

    const decision = shouldTranslateComment({
      comment: { id, user: { login: "human", type: "User" }, body: "ok" },
      priorState: null,
      now: Date.now(),
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "source_too_short");
  });

  it("stale-guards comment edits with isPreparedSourceStillCurrent", () => {
    const title = commentSourceTitle(42);
    const prepared = hashTranslationSource({ title, body: koreanComment });
    assert.equal(
      isPreparedSourceStillCurrent({
        preparedHash: prepared,
        liveTitle: title,
        liveBody: koreanComment,
      }),
      true,
    );
    assert.equal(
      isPreparedSourceStillCurrent({
        preparedHash: prepared,
        liveTitle: title,
        liveBody: koreanComment + " edited",
      }),
      false,
    );
  });
});

describe("missingRequiredTranslationFields", () => {
  it("requires translated title/body only when the matching source field is nonempty", () => {
    assert.deepEqual(
      missingRequiredTranslationFields({
        sourceTitle: "Deutscher Titel",
        sourceBody: "langer Text",
        translatedTitle: "",
        translatedBody: "English",
      }),
      ["title"],
    );
    assert.deepEqual(
      missingRequiredTranslationFields({
        sourceTitle: "Deutscher Titel",
        sourceBody: "langer Text",
        translatedTitle: "English title",
        translatedBody: "",
      }),
      ["body"],
    );
    assert.deepEqual(
      missingRequiredTranslationFields({
        sourceTitle: "Deutscher Titel",
        sourceBody: "langer Text",
        translatedTitle: "",
        translatedBody: "",
      }),
      ["title", "body"],
    );
    assert.deepEqual(
      missingRequiredTranslationFields({
        sourceTitle: "Deutscher Titel",
        sourceBody: "",
        translatedTitle: "English title",
        translatedBody: "",
      }),
      [],
    );
    assert.deepEqual(
      missingRequiredTranslationFields({
        sourceTitle: "",
        sourceBody: "관련: #508 (같은 Kiro adapter의 컨텍스트 토큰 보고 문제).",
        translatedTitle: "",
        translatedBody: "Related: #508",
      }),
      [],
    );
    assert.deepEqual(
      missingRequiredTranslationFields({
        sourceTitle: "",
        sourceBody: "관련: #508 (같은 Kiro adapter의 컨텍스트 토큰 보고 문제).",
        translatedTitle: "",
        translatedBody: "",
      }),
      ["body"],
    );
  });
});

describe("sourceComplete vs rate-limit attempts", () => {
  const TITLE = "Meaningful German title for translation";
  const BODY = "Ein ausreichend langer deutscher Issue-Text für den Test.";

  function attemptOutcome({ sourceComplete, sourceHash = HASH_A, now = 1_000 }) {
    return mergeTranslationAttemptState({
      priorState: null,
      attempt: {
        sourceHash,
        requiresTranslation: true,
        detectedLanguage: "Korean",
        sourceComplete,
      },
      now,
    });
  }

  it("incomplete attempts count toward rate limits but stay retryable after cooldown", () => {
    const now = 1_700_000_000_000;
    const hash = hashTranslationSource({ title: TITLE, body: BODY });

    for (const label of ["invalid_json", "empty_translation_body", "update_failure"]) {
      const incomplete = mergeTranslationAttemptState({
        priorState: null,
        attempt: {
          sourceHash: hash,
          requiresTranslation: label === "invalid_json" ? false : true,
          detectedLanguage: label === "invalid_json" ? "unknown" : "Korean",
          sourceComplete: false,
        },
        now,
      });
      assert.equal(incomplete.sourceHash, "0000000000000000", label);
      assert.equal(incomplete.attemptedAt, now, label);
      assert.ok(incomplete.recent.includes(now), label);

      const duringCooldown = shouldTranslate({
        sourceTitle: TITLE,
        sourceBody: BODY,
        priorState: incomplete,
        now: now + 10_000,
      });
      assert.equal(duringCooldown.ok, false, label);
      assert.equal(duringCooldown.reason, "rate_limited_interval", label);

      const afterCooldown = shouldTranslate({
        sourceTitle: TITLE,
        sourceBody: BODY,
        priorState: incomplete,
        now: now + 120_000,
      });
      assert.equal(afterCooldown.ok, true, label);
      assert.equal(afterCooldown.sourceHash, hash, label);
    }
  });

  it("completed no-translation and successful apply mark the source hash", () => {
    const now = 1_700_000_000_000;
    const hash = hashTranslationSource({ title: TITLE, body: BODY });

    const english = mergeTranslationAttemptState({
      priorState: null,
      attempt: {
        sourceHash: hash,
        sourceKey: "issue",
        requiresTranslation: false,
        detectedLanguage: "English",
        sourceComplete: true,
      },
      now,
    });
    assert.equal(english.sourceHash, hash);
    assert.equal(english.sourceHashes.issue, hash);
    assert.equal(
      shouldTranslate({
        sourceTitle: TITLE,
        sourceBody: BODY,
        priorState: english,
        now: now + 120_000,
      }).reason,
      "unchanged_source",
    );

    const applied = attemptOutcome({ sourceComplete: true, sourceHash: hash, now: now + 200_000 });
    assert.equal(applied.sourceHash, hash);
    assert.equal(
      shouldTranslate({
        sourceTitle: TITLE,
        sourceBody: BODY,
        priorState: applied,
        now: now + 320_000,
      }).reason,
      "unchanged_source",
    );
  });

  it("incomplete issue and comment attempts preserve a prior completed hash", async () => {
    const now = 1_700_000_000_000;
    const issueHash = hashTranslationSource({ title: TITLE, body: BODY });
    const commentBody = "관련: #508 (같은 Kiro adapter의 컨텍스트 토큰 보고 문제).";
    const commentHash = hashTranslationSource({
      title: commentSourceTitle(42),
      body: commentBody,
    });

    const completedIssue = mergeTranslationAttemptState({
      priorState: null,
      attempt: {
        sourceHash: issueHash,
        requiresTranslation: true,
        detectedLanguage: "German",
        sourceComplete: true,
      },
      now,
    });

    const failedCommentApply = mergeTranslationAttemptState({
      priorState: completedIssue,
      attempt: {
        sourceHash: commentHash,
        requiresTranslation: true,
        detectedLanguage: "Korean",
        sourceComplete: false,
      },
      now: now + 120_000,
    });
    assert.equal(failedCommentApply.sourceHash, issueHash);
    assert.equal(failedCommentApply.attemptedAt, now + 120_000);

    const retryComment = shouldTranslateComment({
      comment: { id: 42, user: { login: "human", type: "User" }, body: commentBody },
      priorState: failedCommentApply,
      now: now + 240_000,
    });
    assert.equal(retryComment.ok, true);
    assert.equal(retryComment.sourceHash, commentHash);

    const { github } = mockGithub({ nextId: 9 });
    const persisted = await persistTranslationControlState({
      github,
      owner: "o",
      repo: "r",
      issue_number: 1,
      comments: [],
      priorState: failedCommentApply,
      attempt: {
        sourceHash: commentHash,
        requiresTranslation: true,
        detectedLanguage: "Korean",
        sourceComplete: false,
      },
      now: now + 240_000,
    });
    assert.equal(persisted.state.sourceHash, issueHash);
  });
});
