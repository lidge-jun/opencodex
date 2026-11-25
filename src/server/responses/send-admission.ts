import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Combo admission, checked again at the physical send.
 *
 * A Combo child and a Combo the router collapses to one pick check the key's model scope and paid
 * consent before they dispatch, then still wait on transport and sidecar preparation and on provider
 * pacing. Either can be withdrawn during those waits, so the send boundary checks again.
 *
 * Each request runs in its own slot, nested in the slot of the request or Combo loop that started it.
 * A send passes every check up that chain, and a check a nested request adds stays in its own slot.
 */
interface SendAdmission {
  parent: SendAdmission | undefined;
  /** The answer for a request that may no longer send, or undefined while it still may. */
  refusal?: () => Response | undefined;
  refused?: Response;
}

const admissionScope = new AsyncLocalStorage<SendAdmission>();

export class SendAdmissionRefusedError extends Error {
  constructor() {
    super("The Combo admission of this request was withdrawn before the send");
    this.name = "SendAdmissionRefusedError";
  }
}

/**
 * Run one dispatch in a new slot nested in the current one. A refused send answers with its refusal,
 * whatever the dispatch made of the thrown error.
 */
export async function runWithSendAdmission(
  refusal: (() => Response | undefined) | undefined,
  run: () => Promise<Response>,
): Promise<{ response: Response; refused: boolean }> {
  const admission: SendAdmission = { parent: admissionScope.getStore(), refusal };
  try {
    const response = await admissionScope.run(admission, run);
    if (!admission.refused) return { response, refused: false };
    // A nested slot may already answer with this same refusal, whose body must stay readable.
    if (response !== admission.refused) void response.body?.cancel().catch(() => undefined);
  } catch (error) {
    if (!admission.refused) throw error;
  }
  return { response: admission.refused, refused: true };
}

/** Open the slot of one request. */
export async function withSendAdmissionScope(run: () => Promise<Response>): Promise<Response> {
  return (await runWithSendAdmission(undefined, run)).response;
}

/** Request preparation names the check its own sends must still pass. */
export function requireSendAdmission(refusal: () => Response | undefined): void {
  const admission = admissionScope.getStore();
  if (admission) admission.refusal = refusal;
}

function assertAdmitted(innermost: SendAdmission | undefined): void {
  for (let admission = innermost; admission; admission = admission.parent) {
    const refused = admission.refusal?.();
    if (!refused) continue;
    // Every slot from the send up to the one whose check failed answers with this refusal.
    for (let marked = innermost; marked; marked = marked.parent) {
      marked.refused = refused;
      if (marked === admission) break;
    }
    throw new SendAdmissionRefusedError();
  }
}

/** The physical send boundary: throws when the current request may no longer send. */
export function assertSendAdmission(): void {
  assertAdmitted(admissionScope.getStore());
}

/**
 * Bind the current request's admission for work that socket callbacks start outside the request's
 * async context. `assert` checks a frame before it is written, and `run` keeps an HTTP fallback in
 * the request's admission, so its own physical send is checked.
 */
export function captureSendAdmission(): { assert(): void; run<T>(work: () => T): T } {
  const captured = admissionScope.getStore();
  return {
    assert: () => assertAdmitted(captured),
    run: work => captured ? admissionScope.run(captured, work) : work(),
  };
}
