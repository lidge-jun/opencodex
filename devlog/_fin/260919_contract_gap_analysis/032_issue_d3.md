# D3: [Docs]: Bind core/Lab isolation and synchronous activation in the invariant index

### Documentation problem type

Incorrect documentation

### Documentation location

`structure/overview.md:90`, `structure/adapters/compatibility-lab.md`, `tests/lab/core-lab-boundary.test.ts`

### What is wrong or missing?

The root agent guidance declares core/Lab import isolation and synchronous activation non-negotiable, and a transitive mutation-tested guard exists, but the overview invariant index has no corresponding stable binding. [tests/lab/core-lab-boundary.test.ts:20](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/tests/lab/core-lab-boundary.test.ts#L20) and [tests/lab/core-lab-boundary.test.ts:991](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/tests/lab/core-lab-boundary.test.ts#L991) already own enforcement.

### What should the documentation explain instead?

Add a stable invariant ID tying both guarantees to the existing guard, with a backlink in the test and a link from the Lab contract document. Preserve the guard and its current negative coverage.

### Suggested wording or example

“INV-LAB-01: the protected core entrypoints cannot reach optional Lab runtime imports; gated Lab activation remains synchronous before startServer returns.” Check that this ID is unused before implementation.

### Additional context or attachments

Pinned source: `7864869c31c41cca9830d93540238f17df8faafb`. Static documentation/source comparison only; no runtime test result is claimed.

Update `structure/overview.md`, `structure/adapters/compatibility-lab.md` and an existing test comment/describe label. Use the existing invariant binding checker and focused guard in implementation; no new runtime mechanism is needed. Closed #4704 hardened the guard, not this documentation binding.

### Checks

- [x] I searched existing documentation issues.
- [x] No secrets or personal information are included.
