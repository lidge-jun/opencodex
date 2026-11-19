import { expect, test } from "bun:test";
import baseline from "../fixtures/anthropic-continuation-spend-dev.json";
import { completion, fixture } from "../helpers/anthropic-image-413-fixture";

for (const stream of [false, true]) {
  for (const outcome of ["success", "unmetered400", "metered400"] as const) {
    test(`ordinary continuation matches the dev spend journal (${outcome}, stream=${stream})`, async () => {
      const result = await fixture({ enabled: true, image: "none", maxOutputTokens: 256, spendCeiling: 100_000,
        terminalContinuation: true, stream,
        handle: (_wire, index) => {
          if (index === 1) return completion("I will modify the file now.", stream, 30, 3);
          if (outcome === "success") return completion("Metered continuation", stream, 40, 4);
          return Response.json({ type: "error", error: { type: "invalid_request_error" },
            ...(outcome === "metered400" ? { usage: { input_tokens: 5000, output_tokens: 4 } } : {}),
          }, { status: 400 });
        },
      });
      expect(result.text).toContain(outcome === "success" ? "Metered continuation" : "Provider continuation error 400");
      expect(result.sent).toHaveLength(2);
      const records = result.spendRecords!;
      const dispatched = records.filter(record => record?.kind === "dispatch");
      expect(dispatched).toHaveLength(2);
      const journal = records.filter(record => record?.kind === "settle" || record?.kind === "lost")
        .map(record => ({
          send: dispatched.findIndex(dispatch => dispatch.send === record.send) + 1,
          kind: record.kind,
          ...(record.kind === "settle" ? { tokens: record.tokens } : {}),
        }));
      expect(journal).toEqual(baseline[stream ? "streaming" : "buffered"][outcome]);
    });
  }
}
