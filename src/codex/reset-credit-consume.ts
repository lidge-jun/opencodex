import { BOUNDED_BODY_MAX_BYTES, readBoundedResponseBody } from "../lib/bounded-body";
import { cancelBodyOnAbort, signalWithTimeout } from "../lib/abort";
import {
  isCodexResetCreditConsumeCode,
  isCodexResetCreditOperationId,
  type CodexResetCreditConsumeCode,
} from "./reset-credit-recovery";

const RESET_CREDIT_CONSUME_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const RESET_CREDIT_CONSUME_TIMEOUT_MS = 10_000;
export type CodexResetCreditConsumeResult = Readonly<{
  code: CodexResetCreditConsumeCode;
  operationId: string;
}>;

export class CodexResetCreditConsumeError extends Error {
  constructor(
    readonly reason: "invalid-input" | "upstream" | "invalid-response" | "transport",
    readonly upstreamStatus?: number,
    options?: ErrorOptions,
  ) {
    super(
      upstreamStatus === undefined
        ? `Reset-credit consume failed: ${reason}`
        : `Reset-credit consume upstream returned ${upstreamStatus}`,
      options,
    );
    this.name = "CodexResetCreditConsumeError";
  }
}

export interface CodexResetCreditConsumeInput {
  accessToken: string;
  chatgptAccountId: string;
  operationId: string;
  signal: AbortSignal;
}

export interface CodexResetCreditConsumeDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function ownConsumeCode(value: unknown): CodexResetCreditConsumeCode | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, "code")) return undefined;
  const code = (value as { code?: unknown }).code;
  return isCodexResetCreditConsumeCode(code)
    ? code
    : undefined;
}

function validateInput(input: CodexResetCreditConsumeInput): void {
  if (!isCodexResetCreditOperationId(input.operationId)
    || typeof input.accessToken !== "string"
    || input.accessToken.length === 0
    || typeof input.chatgptAccountId !== "string"
    || input.chatgptAccountId.length === 0
    || !(input.signal instanceof AbortSignal)) {
    throw new CodexResetCreditConsumeError("invalid-input");
  }
}

export async function consumeCodexResetCredit(
  input: CodexResetCreditConsumeInput,
  deps: CodexResetCreditConsumeDeps = {},
): Promise<CodexResetCreditConsumeResult> {
  validateInput(input);
  if (input.signal.aborted) throw input.signal.reason;
  const linked = signalWithTimeout(deps.timeoutMs ?? RESET_CREDIT_CONSUME_TIMEOUT_MS, input.signal);
  let detachBodyAbort = () => {};
  try {
    let response: Response;
    try {
      response = await (deps.fetchImpl ?? fetch)(RESET_CREDIT_CONSUME_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "ChatGPT-Account-Id": input.chatgptAccountId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ redeem_request_id: input.operationId }),
        signal: linked.signal,
      });
    } catch (cause) {
      throw new CodexResetCreditConsumeError("transport", undefined, { cause });
    }
    detachBodyAbort = cancelBodyOnAbort(response.body, linked.signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new CodexResetCreditConsumeError("upstream", response.status);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(declaredLength)
      && declaredLength >= 0
      && declaredLength > BOUNDED_BODY_MAX_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new CodexResetCreditConsumeError("invalid-response");
    }
    let value: unknown;
    try {
      const body = await readBoundedResponseBody(response, {
        signal: linked.signal,
        maxBytes: BOUNDED_BODY_MAX_BYTES,
        fatalUtf8: true,
      });
      if (!body.displaySafe || body.truncated || !body.text.trim()) {
        throw new Error("invalid body");
      }
      value = JSON.parse(body.text) as unknown;
    } catch (cause) {
      throw new CodexResetCreditConsumeError("invalid-response", undefined, { cause });
    }
    const code = ownConsumeCode(value);
    if (!code) throw new CodexResetCreditConsumeError("invalid-response");
    return Object.freeze({ code, operationId: input.operationId });
  } finally {
    detachBodyAbort();
    linked.cleanup();
  }
}
