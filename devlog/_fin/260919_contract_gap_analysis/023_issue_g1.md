# G1: [Feature]: Report endpoint-scoped tool-schema loss before applying stricter policy

### Area

Provider adapters

### What are you trying to accomplish?

Let an operator distinguish lossless normalization from compatibility widening for a tool declaration, while keeping current working requests compatible by default.

### What prevents this today?

All Google endpoint modes currently use the same sanitizer. [src/adapters/google-tool-schema.ts:88](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/adapters/google-tool-schema.ts#L88) drops non-string enums; [src/adapters/google-tool-schema.ts:120](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/adapters/google-tool-schema.ts#L120) widens mixed unions; [src/adapters/google-wire-compiler.ts:97](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/adapters/google-wire-compiler.ts#L97) has no endpoint profile or loss report. Existing tests intentionally expect several constraints to be removed. A request passing upstream does not establish original-schema fidelity.

### What should OpenCodex do?

Compile against an explicit endpoint profile and return bounded, content-free loss categories. Preserve the conservative current behavior initially. Add opt-in reject-lossy behavior only after the report is wired through initial compilation and compatibility repair. Do not claim a broader accepted dialect until that endpoint has evidence.

### Example usage or interface

Given an integer enum or a mixed union, diagnostics identify a bounded category such as `enum-value-filtered` or `union-widened`, plus counts and endpoint class. Default mode sends the existing compatible shape. Opt-in reject-lossy refuses before the changed physical send. Names are illustrative, not an existing API.

### Alternatives or workarounds

Forwarding arbitrary keywords would remove current request-containment guarantees. Globally turning off tool support confuses availability with fidelity. A mandatory universal argument validator is outside this proposal because client tool execution and inbound-protocol contracts differ.

### Additional context

Source snapshot: `7864869c31c41cca9830d93540238f17df8faafb` after fast-forwarding `dev` on 2026-09-19. This is source-grounded analysis, not a runtime test result.

Bounded follow-up to #2358; distinct from the input-modality/context axes in #3377. [src/adapters/google-http.ts:73](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/adapters/google-http.ts#L73) and [src/adapters/google-http.ts:149](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/adapters/google-http.ts#L149) establish repair scope. Official endpoint docs do not prove one universal schema dialect.

### Implementation path

1. MODIFY `src/adapters/google-tool-schema.ts`: return parameters plus loss report; retain traversal limits.
2. MODIFY `src/adapters/google-wire-compiler.ts`: consume endpoint profile and aggregate reports without names/property paths/schema text.
3. MODIFY `src/adapters/google.ts`: derive profile from the existing `googleMode`; update all three call sites.
4. Carry the selected policy to `src/adapters/google-http.ts` so a 400 repair cannot silently bypass it; direct mode already disables that repair.
5. If policy becomes persisted, wire type in `src/types/provider.ts`, provider config validation/persistence, management and CLI creation, hydration/default handling and every compiler/retry consumer in one change. Start report-only if that full chain is not in scope.
6. Update `structure/providers/google.md` and all adapter owners; add focused `tests/adapters/google/google-tool-schema-contract.test.ts`.

### Acceptance criteria and verification

- Profile matrix: numeric enum, bounds, mixed union, recursion, depth/node budget loss.
- Unset policy stays byte-compatible; explicit reject-lossy sends zero initial requests for initial loss and zero repaired sends when a repair would erase constraints.
- Indexed and unindexed 400 repair are reported; direct mode still does not repair.
- Output `responseMimeType`/`responseJsonSchema` stay untouched.
- Privacy fixtures use canary tool/property/value strings and assert none appear in report output.

Register new tests in both layout inventories, preserve size caps, and update the existing structure owners. User-facing policy changes need corresponding public documentation and non-contradictory translations. Run focused tests and exact-head hosted CI during implementation; no local suite was run for this analysis.

### Checks

- [x] I searched existing issues and documentation.
- [x] This request describes a concrete OpenCodex workflow rather than merely naming a desired technology.
- [x] I removed secrets and personal data.
