"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  hardenRelatedMatches,
  parseTriageMatches,
  parseAiJson,
  sanitizeReason,
  hasConcreteRelatedSignature,
  hasConcreteFailureToken,
} = require("./issue-triage.cjs");

describe("hasConcreteRelatedSignature", () => {
  it("rejects standalone ECONNRESET referring only to the new issue", () => {
    assert.equal(
      hasConcreteRelatedSignature(
        "The new issue alone reports ECONNRESET; issue 410 is a separate 401 problem.",
      ),
      false,
    );
  });

  it("rejects shared route with different failures", () => {
    assert.equal(
      hasConcreteRelatedSignature(
        "Both issues call POST /v1/responses, but one returns 401 and the other crashes locally.",
      ),
      false,
    );
  });

  it("rejects same provider with different root causes", () => {
    assert.equal(
      hasConcreteRelatedSignature(
        "The same provider is involved, but the failures and root causes differ.",
      ),
      false,
    );
  });

  it("does not treat ordinary e-words as error constants", () => {
    assert.equal(hasConcreteFailureToken("each exact existing endpoint"), false);
    assert.equal(
      hasConcreteRelatedSignature(
        "Both issues involve each exact existing endpoint without a real fault code.",
      ),
      false,
    );
  });

  it("does not treat capitalized common words as errno tokens", () => {
    assert.equal(hasConcreteFailureToken("ERROR"), false);
    assert.equal(hasConcreteFailureToken("EXCEPTION"), false);
    assert.equal(
      hasConcreteRelatedSignature(
        "Both issues show the same ERROR when calling the API.",
      ),
      false,
    );
  });

  it("ignores bare three-digit numbers without status context", () => {
    assert.equal(hasConcreteFailureToken("See issue 410 and PR 503"), false);
    assert.equal(
      hasConcreteRelatedSignature(
        "Both issues mention 410 and 503 without a status code.",
      ),
      false,
    );
    // Shared verb ("report") must not bind "both issues" to another issue's
    // number as if it were a concrete failure/status signature.
    assert.equal(
      hasConcreteRelatedSignature(
        "Both issues report the same problem as issue 410.",
      ),
      false,
    );
    assert.equal(
      hasConcreteRelatedSignature(
        "Both issues report the same problem as issue 503.",
      ),
      false,
    );
  });

  it("rejects different HTTP statuses despite component overlap", () => {
    const rejected = [
      "Both issues use OpenRouter. The first returns 401; the second returns 500.",
      "One returns HTTP 401 while the other returns HTTP 500.",
      "The new issue reports 503, whereas issue 410 reports 400.",
      "Both call POST /v1/responses and return 401 and 500 respectively.",
      "Both involve the same adapter, but one times out and the other returns 401.",
    ];
    for (const reason of rejected) {
      assert.equal(hasConcreteRelatedSignature(reason), false, reason);
    }
  });

  it("rejects distinct statuses even when the shared-comparison gate is open", () => {
    assert.equal(
      hasConcreteRelatedSignature(
        "Both issues return errors, but one returns 401 and the other returns 500.",
      ),
      false,
    );
  });

  it("rejects shared wording that borrows a concrete token from only one issue", () => {
    const rejected = [
      "Both issues fail on the same adapter, though only the new issue reports ECONNRESET.",
      "Both issues fail, but only one includes the Field required message.",
      "Both issues use OpenRouter; issue 410 alone returns HTTP 503.",
      "Both issues reproduce after startup, but just the first issue reports ETIMEDOUT.",
      "Both issues return errors, with ECONNRESET appearing only in the new report.",
      "Both issues have the same adapter, but the existing issue does not report ECONNRESET.",
    ];
    for (const reason of rejected) {
      assert.equal(hasConcreteRelatedSignature(reason), false, reason);
    }
  });

  it("rejects mixed HTTP and errno failures attributed to different issues", () => {
    const rejected = [
      "Both issues fail in the adapter: issue 410 returns HTTP 500, and the new issue reports ECONNRESET.",
      "Both issues have different symptoms, but the new issue reports ECONNRESET.",
      "Both issues fail: the first returns HTTP 503 and the other reports ETIMEDOUT.",
    ];
    for (const reason of rejected) {
      assert.equal(hasConcreteRelatedSignature(reason), false, reason);
    }
  });

  it("rejects this/current/present issue attributions after generic both-wording", () => {
    const rejected = [
      "Both issues fail in OpenRouter, but this issue returns HTTP 500.",
      "Both issues have adapter errors, while the current issue reports ECONNRESET.",
      "Both issues reproduce, but the present issue shows Field required.",
    ];
    for (const reason of rejected) {
      assert.equal(hasConcreteRelatedSignature(reason), false, reason);
    }
  });

  it("keeps shared concrete failure signatures", () => {
    const accepted = [
      "Both issues return HTTP 503 from POST /v1/responses in the OpenRouter adapter.",
      "Both issues report ECONNRESET from the same endpoint.",
      "Both issues have the same Field required error at messages.0.content.0.text.",
      "Both issues return ECONNRESET from POST /v1/responses in the OpenRouter adapter.",
      "Both issues report ECONNRESET from POST /v1/responses.",
      "Both issues return HTTP 503 in the OpenRouter adapter.",
      "Both issues return HTTP 500 from the same endpoint.",
      "Both issues report ECONNRESET in the OpenRouter adapter.",
      "The issues share the ETIMEDOUT failure when connecting through the Anthropic adapter.",
    ];
    for (const reason of accepted) {
      assert.equal(hasConcreteRelatedSignature(reason), true, reason);
    }
  });

  it("keeps shared errno plus shared comparison", () => {
    assert.equal(
      hasConcreteRelatedSignature(
        "Both issues return ECONNRESET from POST /v1/responses in the OpenRouter adapter.",
      ),
      true,
    );
  });
});

describe("hardenRelatedMatches", () => {
  it("drops #452-style weak related links to unrelated HTTP errors", () => {
    const result = hardenRelatedMatches({
      duplicates: [],
      related: [{
        number: "420",
        reason:
          "The new issue involves a 503 error from the Codex proxy which is somewhat related to the 400 error reported in issue 420, as both issues pertain to errors in content serialization with the Codex app.",
      }],
    });
    assert.deepEqual(result.related, []);
    assert.deepEqual(result.duplicates, []);
  });

  it("drops generic same-client / same-app overlap without a concrete signature", () => {
    assert.deepEqual(
      hardenRelatedMatches({
        duplicates: [],
        related: [{ number: "1", reason: "Same client and both are general proxy errors." }],
      }).related,
      [],
    );
  });

  it("keeps related when shared comparison has a concrete signature", () => {
    assert.deepEqual(
      hardenRelatedMatches({
        duplicates: [],
        related: [{
          number: "410",
          reason:
            "Both issues return exact ECONNRESET on /v1/responses in the OpenRouter adapter.",
        }],
      }).related,
      [{
        number: "410",
        reason:
          "Both issues return exact ECONNRESET on /v1/responses in the OpenRouter adapter.",
      }],
    );
  });

  it("one valid related entry does not validate other weak entries", () => {
    const result = hardenRelatedMatches({
      duplicates: [],
      related: [
        {
          number: "410",
          reason:
            "Both issues return ECONNRESET from POST /v1/responses in the OpenRouter adapter.",
        },
        {
          number: "420",
          reason: "Somewhat related Codex HTTP errors in the same app.",
        },
        {
          number: "421",
          reason: "Both issues call POST /v1/responses, but one returns 401 and the other crashes locally.",
        },
      ],
    });
    assert.deepEqual(result.related.map((e) => e.number), ["410"]);
  });

  it("each related entry requires its own concrete reason", () => {
    const result = hardenRelatedMatches({
      duplicates: [],
      related: [
        { number: "410", reason: "short" },
        {
          number: "411",
          reason:
            "Both issues return HTTP 503 from POST /v1/responses with the Xiaomi openai-chat adapter.",
        },
      ],
    });
    assert.deepEqual(result.related.map((e) => e.number), ["411"]);
  });

  it("caps related at 3 and never overlaps duplicates", () => {
    const result = hardenRelatedMatches({
      duplicates: ["100"],
      related: [
        { number: "100", reason: "Both issues return the same listen-port reclaim failure after Windows taskkill leaves ghost LISTEN on 10100." },
        { number: "101", reason: "Both issues return the same listen-port reclaim failure after Windows taskkill leaves ghost LISTEN on 10100." },
        { number: "102", reason: "Both issues return the same listen-port reclaim failure after Windows taskkill leaves ghost LISTEN on 10100." },
        { number: "103", reason: "Both issues return the same listen-port reclaim failure after Windows taskkill leaves ghost LISTEN on 10100." },
        { number: "104", reason: "Both issues return the same listen-port reclaim failure after Windows taskkill leaves ghost LISTEN on 10100." },
      ],
    });
    assert.deepEqual(result.duplicates, ["100"]);
    assert.deepEqual(result.related.map((e) => e.number), ["101", "102", "103"]);
  });
});

describe("parseTriageMatches", () => {
  it("returns null when hardening clears a weak related-only match", () => {
    const matches = parseTriageMatches(
      JSON.stringify({
        duplicates: [],
        related: [{
          number: "420",
          reason:
            "somewhat related Codex App HTTP errors; both pertain to errors in the proxy",
        }],
        reason: "weak overlap",
      }),
      { currentNumber: 452, knownNumbers: ["420", "451"] },
    );
    assert.equal(matches, null);
  });

  it("keeps strong duplicates even if related is weak", () => {
    const matches = parseTriageMatches(
      JSON.stringify({
        duplicates: ["420"],
        related: [{
          number: "451",
          reason: "somewhat related to other Codex errors in general",
        }],
        reason: "Exact same Anthropic messages.0.content.N.text.text Field required failure.",
      }),
      { currentNumber: 452, knownNumbers: new Set(["420", "451"]) },
    );
    assert.deepEqual(matches.duplicates, ["420"]);
    assert.deepEqual(matches.related, []);
  });

  it("ignores unknown and self issue numbers", () => {
    const matches = parseTriageMatches(
      JSON.stringify({
        duplicates: ["#420", "452", "999"],
        related: [],
        reason: "Exact same Anthropic messages.0.content.N.text.text Field required failure.",
      }),
      { currentNumber: 452, knownNumbers: ["420"] },
    );
    assert.deepEqual(matches.duplicates, ["420"]);
  });

  it("ignores malformed related objects and legacy string related arrays", () => {
    const matches = parseTriageMatches(
      JSON.stringify({
        duplicates: [],
        related: [
          "410",
          { number: "411" },
          { reason: "Both issues return ECONNRESET from POST /v1/responses." },
          {
            number: "412",
            reason:
              "Both issues return ECONNRESET from POST /v1/responses in the OpenRouter adapter.",
          },
          null,
          413,
        ],
        reason: "overall",
      }),
      { currentNumber: 1, knownNumbers: ["410", "411", "412", "413"] },
    );
    assert.deepEqual(matches.related.map((e) => e.number), ["412"]);
  });

  it("prevents duplicate and related lists from overlapping", () => {
    const matches = parseTriageMatches(
      JSON.stringify({
        duplicates: ["410"],
        related: [{
          number: "410",
          reason:
            "Both issues return ECONNRESET from POST /v1/responses in the OpenRouter adapter.",
        }, {
          number: "411",
          reason:
            "Both issues return ECONNRESET from POST /v1/responses in the OpenRouter adapter.",
        }],
        reason: "dupes",
      }),
      { currentNumber: 1, knownNumbers: ["410", "411"] },
    );
    assert.deepEqual(matches.duplicates, ["410"]);
    assert.deepEqual(matches.related.map((e) => e.number), ["411"]);
  });

  it("caps related output at 3", () => {
    const related = ["410", "411", "412", "413"].map((number) => ({
      number,
      reason:
        "Both issues return ECONNRESET from POST /v1/responses in the OpenRouter adapter.",
    }));
    const matches = parseTriageMatches(
      JSON.stringify({ duplicates: [], related, reason: "many" }),
      { currentNumber: 1, knownNumbers: ["410", "411", "412", "413"] },
    );
    assert.equal(matches.related.length, 3);
  });
});

describe("parseAiJson", () => {
  it("strips a json fence before parsing", () => {
    assert.deepEqual(
      parseAiJson("```json\n{\"duplicates\":[]}\n```"),
      { duplicates: [] },
    );
  });

  it("returns null for unparseable input", () => {
    assert.equal(parseAiJson("not json at all"), null);
  });
});

describe("sanitizeReason", () => {
  it("strips markdown and mention markers", () => {
    assert.equal(
      sanitizeReason("see @user and #420 with `code`"),
      "see (at)user and 420 with code",
    );
  });
});
