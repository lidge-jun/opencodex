import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { interactiveConfirm } from "../src/cli/interactive-confirm";

/**
 * A fake TTY pair: the input side supports raw mode (so the selector takes the
 * keypress path), and the output side records everything painted.
 */
function makeTty() {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
  input.isRaw = false;
  input.setRawMode = ((mode: boolean) => {
    input.isRaw = mode;
    return input;
  }) as NodeJS.ReadStream["setRawMode"];

  const frames: string[] = [];
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    frames.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return write(chunk as string, ...(rest as []));
  }) as NodeJS.WriteStream["write"];

  return { input, output, frames };
}

async function ask(keys: string[], defaultYes = false): Promise<{ answer: boolean; frames: string[]; raw: boolean }> {
  const { input, output, frames } = makeTty();
  const pending = interactiveConfirm({ question: "Star it?", defaultYes, input, output });
  for (const key of keys) input.write(key);
  const answer = await pending;
  return { answer, frames, raw: input.isRaw };
}

const ARROW_LEFT = "\x1b[D";
const ARROW_RIGHT = "\x1b[C";
const ENTER = "\r";
const ESCAPE = "\x1b";

describe("interactiveConfirm", () => {
  test("bare enter takes whichever choice is highlighted", async () => {
    expect((await ask([ENTER])).answer).toBe(false);
    expect((await ask([ENTER], true)).answer).toBe(true);
  });

  test("arrow keys move the selection and enter confirms it", async () => {
    expect((await ask([ARROW_LEFT, ENTER])).answer).toBe(true);
    expect((await ask([ARROW_LEFT, ARROW_RIGHT, ENTER])).answer).toBe(false);
  });

  test("y and n answer immediately without enter", async () => {
    expect((await ask(["y"])).answer).toBe(true);
    expect((await ask(["n"], true)).answer).toBe(false);
    expect((await ask(["Y"])).answer).toBe(true);
  });

  test("escape declines rather than consenting", async () => {
    expect((await ask([ESCAPE], true)).answer).toBe(false);
  });

  test("both choices are shown and the terminal mode is restored", async () => {
    const { frames, raw } = await ask([ENTER]);
    const painted = frames.join("");

    expect(painted).toContain("Yes");
    expect(painted).toContain("No");
    expect(painted).toContain("y/n");
    expect(raw).toBe(false);
  });

  test("without raw mode it falls back to a typed answer honoring the same default", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    const declined = interactiveConfirm({ question: "Star it?", defaultYes: false, input, output });
    input.write("\n");
    expect(await declined).toBe(false);

    const accepted = interactiveConfirm({ question: "Star it?", defaultYes: true, input, output });
    input.write("\n");
    expect(await accepted).toBe(true);
  });

  test("the highlighted choice sets both colours so it stays readable", async () => {
    const { frames } = await ask([ENTER]);
    const painted = frames.join("");

    // Bare reverse video (\x1b[7m) inherits the surrounding foreground colour,
    // which rendered the selected label as black-on-black on some themes. The
    // highlight must name a foreground AND a background instead.
    expect(painted).toContain("\x1b[30;47m");
    expect(painted).not.toContain("\x1b[7m");
  });
});
