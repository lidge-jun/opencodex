# Cursor schema cycle P refresh

Parent: d6bfb044a5dc6494cba57c1238ded7c23faf5586, open PR #3702. Original #3628 remains at 37e6115c8a2ad3ffe20fee1e5a1e79a054625a56, author SB Yoon (yansigit).

The source commits 1b29236c5bee9dd166b9d23983a2f1f1c2f0b793 and 37e6115c8a2ad3ffe20fee1e5a1e79a054625a56 are prepared as mailbox patches with only production diff paths mapped from tool-definitions.ts to current tool-schemas.ts. `git apply --check` accepted the first mapped patch. Apply both in order during B, retaining their original author/date/message. Main then adds the new constant to the existing public re-export, closes the freeform object with additionalProperties:false, strengthens literal/protobuf assertions and updates the planned docs/structure.

The current naming path preserves namespaces through namespacedToolName; the existing bare-shell helper remains the authority for the original rejection. No tool execution or approval policy changes are introduced. Read current 030 for all activation cases and complete scope.

Main owns authored patch application, public facade and documentation edits, commits and PR publication. An inherited worker may amend only tool-schemas.ts and cursor-tool-definitions.test.ts after A; no Git or local tests/typecheck. Independent review plus current-head remote full/typecheck/docs and hosted CI supply proof. The candidate can remain open in the stack while shipping/closure criteria remain separately pending.
