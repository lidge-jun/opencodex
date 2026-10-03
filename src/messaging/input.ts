import { MessageBudget } from "./budget";
import { MAX_BODY_BYTES } from "./envelope";
import { LocalMessagingError } from "./types";

/** Bounded UTF-8 stdin, including when the writer never closes its pipe. */
export async function readMessageInput(stream: ReadableStream<Uint8Array>, budget: MessageBudget): Promise<string> {
  budget.throwIfEnded();
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let rejectAbort: (error: unknown) => void = () => {};
  const ended = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(budget.signal.reason);
  budget.signal.addEventListener("abort", abort, { once: true });
  try {
    if (budget.signal.aborted) abort();
    for (;;) {
      const chunk = await Promise.race([reader.read(), ended]);
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > MAX_BODY_BYTES) throw new LocalMessagingError("invalid_body", "Message stdin exceeds 16 KiB.");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    budget.throwIfEnded();
    return text;
  } catch (error) {
    if (error instanceof LocalMessagingError) throw error;
    throw new LocalMessagingError("invalid_body", "Message stdin could not be read as UTF-8 text.");
  } finally {
    budget.signal.removeEventListener("abort", abort);
    // A hostile producer's cancel hook must not extend the command deadline.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
