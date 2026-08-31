/**
 * The exit code `ocx stop` uses to say "teardown succeeded, history cleanup did not".
 *
 * This is plain ESM rather than TypeScript because it has two consumers on opposite sides
 * of a process boundary: `src/update/index.ts` and the Node launcher `bin/ocx.mjs`, which
 * cannot import a `.ts` module. A TypeScript union would not survive `spawnSync` anyway —
 * the value has to be on the wire, and an exit code is the wire.
 *
 * 79 is deliberate. It sits above the `sysexits.h` block (64-78), below `128 + signal`,
 * and outside every code this CLI already uses: `src/cli/index.ts` emits 0, 1 and 130,
 * and `src/cli/dispatch.ts` adds 2, 4 and 64. Picking one of those would have made a
 * history-only stop indistinguishable from a config conflict, and `bin/ocx.mjs` mirrors
 * the child's code faithfully enough to propagate the confusion.
 */
export const STOP_HISTORY_INCOMPLETE_EXIT_CODE = 79;
