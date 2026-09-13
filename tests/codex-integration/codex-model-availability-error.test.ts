import { describe, expect, test } from "bun:test";
import {
  CodexModelAvailabilityError,
  CodexPoolAuthenticationError,
} from "../../src/codex/auth-context";
import {
  codexModelAvailabilityErrorResponse,
  mapCodexAuthContextErrorToResponse,
} from "../../src/server/responses/codex-auth-error";

describe("Codex model availability HTTP errors", () => {
  test("unsupported model is a request error, not invalid_api_key", async () => {
    const error = new CodexModelAvailabilityError(
      "unsupported",
      "No eligible Codex account supports this model",
    );
    expect(error).toBeInstanceOf(CodexPoolAuthenticationError);

    const response = mapCodexAuthContextErrorToResponse(error, { now: Date.now() });
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: {
        type: "invalid_request_error",
        code: "invalid_request_error",
        message: "No eligible Codex account supports this model",
      },
    });
  });

  test("temporarily unavailable model is retryable quota capacity", async () => {
    const response = codexModelAvailabilityErrorResponse(new CodexModelAvailabilityError(
      "temporarily_unavailable",
      "Codex accounts that support this model are currently unavailable",
    ));
    expect(response.status).toBe(429);
    expect(response.headers.has("retry-after")).toBeFalse();
    expect(await response.json()).toEqual({
      error: {
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        message: "Codex accounts that support this model are currently unavailable",
      },
    });
  });

  test("ordinary pool credential failures retain authentication semantics", async () => {
    const response = mapCodexAuthContextErrorToResponse(
      new CodexPoolAuthenticationError(),
      { now: Date.now() },
    );
    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({
      error: { type: "authentication_error", code: "invalid_api_key" },
    });
  });
});
