import { createInterface } from "node:readline/promises";

/**
 * Inline yes/no selector for interactive CLI prompts.
 *
 * Both choices are drawn on one line: the user moves between them with the
 * arrow keys (or Tab), confirms with Enter, or answers straight away with
 * `y`/`n`. Escape and Ctrl-C resolve to "no", so backing out never counts as
 * consent.
 *
 * The highlighted choice is caller-supplied and is what a bare Enter returns.
 * Whatever the default, the selector always shows which side is highlighted, so
 * Enter never does something the screen did not already say it would.
 */

export interface InteractiveConfirmOptions {
  /** Question text rendered before the choices. May contain ANSI styling. */
  question: string;
  /** Which choice starts highlighted, and therefore what a bare Enter returns. */
  defaultYes: boolean;
  /** Key hint shown after the choices. */
  hint?: string;
  /** Overridable for tests; defaults to the process streams. */
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

// The highlight sets an explicit black-on-white pair rather than bare reverse
// video (\x1b[7m). Reverse alone inherits whatever foreground colour is in
// effect, so on some themes the selected label rendered as black text on a black
// block and the choice became invisible.
const REVERSE = "\x1b[30;47m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[K";

const KEY_ENTER = new Set(["\r", "\n"]);
const KEY_YES_SIDE = new Set(["\x1b[D", "\x1b[A", "\x1bOD", "\x1bOA"]); // left / up
const KEY_NO_SIDE = new Set(["\x1b[C", "\x1b[B", "\x1bOC", "\x1bOB"]); // right / down
const KEY_ESCAPE = "\x1b";
const KEY_INTERRUPT = "\x03";
const KEY_TAB = "\t";

function renderChoices(question: string, yes: boolean, hint: string): string {
  const yesLabel = yes ? `${REVERSE} Yes ${RESET}` : `${DIM} Yes ${RESET}`;
  const noLabel = yes ? `${DIM} No ${RESET}` : `${REVERSE} No ${RESET}`;
  return `${CLEAR_LINE}${question} ${yesLabel} ${noLabel}  ${DIM}${hint}${RESET}`;
}

function renderAnswer(question: string, yes: boolean): string {
  return `${CLEAR_LINE}${question} ${yes ? "Yes" : "No"}\n`;
}

/** Fallback for terminals without raw mode: a plain typed answer. */
async function readlineConfirm(
  options: InteractiveConfirmOptions,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<boolean> {
  const suffix = options.defaultYes ? "[Y/n]" : "[y/N]";
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${options.question} ${suffix} `)).trim().toLowerCase();
    if (answer === "") return options.defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Ask a yes/no question with an inline arrow-key selector. Resolves to the
 * user's choice; never throws for input handling and always restores the
 * terminal mode it changed.
 */
export async function interactiveConfirm(options: InteractiveConfirmOptions): Promise<boolean> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const hint = options.hint ?? "←/→ move · y/n · enter";

  // Raw mode is what makes single-keypress navigation possible. Without it
  // (pipes, some CI shells, Windows consoles without a TTY) fall back to a
  // typed answer rather than silently swallowing the question.
  if (typeof input.setRawMode !== "function") {
    return await readlineConfirm(options, input, output);
  }

  return await new Promise<boolean>(resolve => {
    let yes = options.defaultYes;
    const wasRaw = input.isRaw === true;
    const hadOtherReaders = input.listenerCount("data") > 0;

    const paint = () => {
      output.write(renderChoices(options.question, yes, hint));
    };

    const finish = (answer: boolean, interrupted: boolean) => {
      input.off("data", onData);
      if (!wasRaw) input.setRawMode(false);
      if (!hadOtherReaders) input.pause();
      output.write(renderAnswer(options.question, answer));
      resolve(answer);
      // A Ctrl-C during the prompt is still a Ctrl-C: hand it back to the
      // process so the normal shutdown path runs instead of being eaten here.
      if (interrupted) process.kill(process.pid, "SIGINT");
    };

    const onData = (chunk: Buffer | string) => {
      const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (key === KEY_INTERRUPT) return finish(false, true);
      if (key === KEY_ESCAPE) return finish(false, false);
      if (KEY_ENTER.has(key)) return finish(yes, false);
      const lower = key.toLowerCase();
      if (lower === "y") return finish(true, false);
      if (lower === "n") return finish(false, false);
      if (KEY_YES_SIDE.has(key)) {
        yes = true;
        paint();
        return;
      }
      if (KEY_NO_SIDE.has(key) || key === KEY_TAB) {
        yes = key === KEY_TAB ? !yes : false;
        paint();
        return;
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    paint();
  });
}
