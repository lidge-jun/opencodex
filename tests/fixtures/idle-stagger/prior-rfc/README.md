# Historical RFC source and evidence

This directory preserves the original 15-test offline scheduler from [Issue #7206](https://github.com/lidge-jun/opencodex/issues/7206#issuecomment-6211624192), together with the runnable source, test cases, and a reproducibility receipt.

This is **historical model evidence only**. The current PR A planner is under `src/codex/idle-stagger-planner.ts`. Neither model performs networking, credential access, production configuration mutation, or synthetic upstream activation.

Run from this directory:

```sh
node --experimental-strip-types --test offline-scheduler-model.rfc-spec.ts
```

The old test file intentionally uses the `.rfc-spec.ts` name rather than a `.test.ts` suffix, so it is not included in OpenCodex's ordinary test-layout registry. It can still be reproduced explicitly as shown above.
