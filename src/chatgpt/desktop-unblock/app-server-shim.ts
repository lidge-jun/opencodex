import { rewriteAppServerLine } from "./app-server-rewrite";

/**
 * Stdout filter for the bundled `codex app-server`.
 *
 * The ChatGPT desktop app decides whether the composer can send from what the app-server tells
 * it over JSON-RPC (account rate limits, blocked features). The app-server fetches that state
 * with its own HTTP client, so neither Chromium switches nor a PAC file ever see it. The desktop
 * app does honour `CODEX_CLI_PATH`, so a launch that points it at the launcher script puts this
 * filter on the one pipe that carries the answer, and nothing else:
 *
 *  - the launcher `exec`s the real binary, so the app-server stays the process the app started:
 *    same pid, same parent, same code-signing identity. The app checks that identity before it lets
 *    the server onto its app-tools pipe, and a wrapper process in between fails that check;
 *  - only the server's stdout is redirected, into this process. A line that does not mention a
 *    rate-limit field is written back as the exact bytes it arrived in, and only a line the
 *    rewrite changes is re-serialized. A rewrite that throws passes its line through unchanged;
 *  - stdin, stderr and signals go straight between the app and the server, and no environment
 *    variable, address, certificate or config key is touched;
 *  - the filter needs no running opencodex. If it cannot start, the launcher runs the real binary
 *    with its stdout untouched.
 */

/** Where the real Codex binary lives inside the app bundle. */
export const CHATGPT_APP_CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

const NEWLINE = 0x0a;

/**
 * Splits a byte stream into lines and rewrites the ones that need it. Returns the bytes to write
 * for each chunk; a partial trailing line is held back until its newline arrives (or `flush`).
 */
export function createRpcLineFilter(
  rewrite: (line: string) => string | null = rewriteAppServerLine,
): { push(chunk: Uint8Array): Uint8Array[]; flush(): Uint8Array[] } {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending: Uint8Array = new Uint8Array(0);

  // `line` excludes the newline, `whole` includes it when there is one. An untouched line is
  // returned as the very bytes that arrived; only a rewritten one is re-encoded.
  const emit = (line: Uint8Array, whole: Uint8Array, terminated: boolean): Uint8Array => {
    let rewritten: string | null;
    try {
      rewritten = rewrite(decoder.decode(line));
    } catch {
      return whole;
    }
    if (rewritten === null) return whole;
    const body = encoder.encode(rewritten);
    if (!terminated) return body;
    const out = new Uint8Array(body.length + 1);
    out.set(body, 0);
    out[body.length] = NEWLINE;
    return out;
  };

  return {
    push(chunk) {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending, 0);
      joined.set(chunk, pending.length);
      const out: Uint8Array[] = [];
      let start = 0;
      for (let i = 0; i < joined.length; i++) {
        if (joined[i] !== NEWLINE) continue;
        out.push(emit(joined.subarray(start, i), joined.subarray(start, i + 1), true));
        start = i + 1;
      }
      pending = joined.slice(start);
      return out;
    },
    flush() {
      if (pending.length === 0) return [];
      const last = pending;
      pending = new Uint8Array(0);
      return [emit(last, last, false)];
    },
  };
}

/** Copy `input` to `write`, rewriting gate lines on the way. Resolves when `input` ends. */
export async function runStdoutFilter(
  input: AsyncIterable<Uint8Array>,
  write: (bytes: Uint8Array) => Promise<unknown> | unknown,
  rewrite?: (line: string) => string | null,
): Promise<void> {
  const filter = createRpcLineFilter(rewrite);
  for await (const chunk of input) {
    for (const out of filter.push(chunk)) await write(out);
  }
  for (const out of filter.flush()) await write(out);
}

if (import.meta.main) {
  await runStdoutFilter(Bun.stdin.stream(), bytes => Bun.write(Bun.stdout, bytes));
}
