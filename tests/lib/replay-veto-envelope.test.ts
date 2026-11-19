import { responsesCompletionError } from "../../src/lib/errors";
import { expect, test } from "bun:test";
import { fetchWithTransientRetry, hasClientReplayVeto, observedReplayRefusalCode, replayRefusalVerdict, REPLAY_REFUSAL_MESSAGE } from "../../src/lib/upstream-retry";

import { NON_REPLAYABLE_COMPLETION_MESSAGE, rewriteNonRetryableFailurePayload } from "../../src/server/responses/non-replayable-error";

const code = "upstream_response_refused";
type Fields = Record<string, unknown>;
const carriers: Record<string, (fields: Fields) => Fields> = {
  root: fields => fields,
  error: fields => ({ error: fields }),
  last_error: fields => ({ last_error: fields }),
  response: fields => ({ response: fields }),
  "response.error": fields => ({ response: { error: fields } }),
  "response.last_error": fields => ({ response: { last_error: fields } }),
  incomplete_details: fields => ({ incomplete_details: fields }),
  "incomplete_details.cause": fields => ({ incomplete_details: { cause: fields } }),
  "incomplete_details.details[0]": fields => ({ incomplete_details: { details: [fields] } }),
  "response.incomplete_details": fields => ({ response: { incomplete_details: fields } }),
  "error.cause": fields => ({ error: { cause: fields } }),
  "error.cause.cause": fields => ({ error: { cause: { cause: fields } } }),
  "error.details": fields => ({ error: { details: fields } }),
  "error.details[0]": fields => ({ error: { details: [fields] } }),
  "error.details[0][0]": fields => ({ error: { details: [[fields]] } }),
  "error.details[0].cause": fields => ({ error: { details: [{ cause: fields }] } }),
};

for (const [path, wrap] of Object.entries(carriers)) {
  for (const fields of [{ code }, { retryable: false }] as const) {
    test(`${path} carries ${Object.keys(fields)[0]}`, async () => {
      const body = wrap(fields);
      let sends = 0;
      const response = await fetchWithTransientRetry(async () => ++sends === 1
        ? Response.json(body, { status: 503 }) : new Response("retried"),
      { attempts: 2, slowAttemptMs: 60_000 });
      expect([sends, response.status]).toEqual([1, 503]);
      const coded = "code" in fields;
      expect(replayRefusalVerdict(body)).toEqual(coded
        ? { refusalCode: code, explicitVeto: false } : { explicitVeto: true });
      if (coded) expect(observedReplayRefusalCode(response)).toBe(code);
      else expect(hasClientReplayVeto(response)).toBe(true);

      const diagnostic = "fixture diagnostic";
      const terminal = JSON.stringify({
        ...wrap({ ...fields, message: diagnostic }),
        type: "response.completed",
        last_error: body.last_error ?? { code: "server_error", message: diagnostic },
      });
      const rewritten = rewriteNonRetryableFailurePayload(terminal, false, value => value);
      expect(JSON.parse(rewritten).response).toMatchObject({
        retryable: false,
        error: coded ? { code, message: REPLAY_REFUSAL_MESSAGE } : { message: NON_REPLAYABLE_COMPLETION_MESSAGE },
      });
      expect(rewritten).not.toContain(diagnostic);
    });
  }
}

for (const key of ["tools", "input", "messages", "metadata"]) {
  for (const fields of [{ code }, { retryable: false }]) {
    test(`ignores echoed ${key} with ${Object.keys(fields)[0]}`, async () => {
      const body = { error: { details: [{ [key]: [{ example: fields }] }] } };
      expect(replayRefusalVerdict(body)).toEqual({ explicitVeto: false });
      let sends = 0;
      const response = await fetchWithTransientRetry(async () => ++sends === 1
        ? Response.json(body, { status: 503 }) : new Response("retried"),
      { attempts: 2, slowAttemptMs: 60_000 });
      expect([sends, response.status]).toEqual([2, 200]);
    });
  }
}

test("ordinary transient failure carries no veto", () => {
  expect(replayRefusalVerdict({ error: { code: "server_error", retryable: true } })).toEqual({ explicitVeto: false });
});

test("bounds cause traversal, including cyclic records", () => {
  const cyclic: Fields = {};
  cyclic.cause = cyclic;
  let deep: Fields = { code, retryable: false };
  for (let depth = 0; depth < 20; depth++) deep = { cause: deep };
  expect(replayRefusalVerdict(cyclic)).toEqual({ explicitVeto: false });
  expect(replayRefusalVerdict(deep)).toEqual({ explicitVeto: false });
});

for (const type of ["response.completed", "response.incomplete"] as const) {
  for (const wrap of [carriers.root!, carriers.response!]) {
    for (const code of ["upstream_response_refused", "upstream_reset_replay_refused"]) {
      test(`${type} recognizes standalone ${code} at ${wrap({ code }).code ? "root" : "snapshot"}`, () => {
        const terminal = { type, ...wrap({ code, message: "fixture diagnostic" }) };
        expect(responsesCompletionError(terminal, type)).toMatchObject({ code });
        const rewritten = rewriteNonRetryableFailurePayload(JSON.stringify(terminal), false, value => value);
        expect(JSON.parse(rewritten).response).toMatchObject({
          retryable: false, error: { code, message: REPLAY_REFUSAL_MESSAGE },
        });
        expect(rewritten).not.toContain("fixture diagnostic");
      });
    }
    test(`${type} keeps a clean boolean-only veto at ${wrap({ retryable: false }).response ? "snapshot" : "root"}`, () => {
      const terminal = { type, ...wrap({ retryable: false }) };
      expect(responsesCompletionError(terminal, type)).toBeUndefined();
      const payload = JSON.stringify(terminal);
      expect(rewriteNonRetryableFailurePayload(payload, false, value => value)).toBe(payload);
    });
  }
}
