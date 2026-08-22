# 020 — Release recommendation

**Recommend: minor bump (2.26.0) on the next train, cut from `fe3bbad97`
or later.** The delta carries behavior changes (FastWire B1 capability
semantics, Grok Responses backend switch, cursor replay roles) beyond patch
scope, plus the three audit fixes that must ride the same train as the
regressions they fix.

Pre-promotion gates for whoever runs the train (maintainer-owned; nothing
here was executed by this campaign):

1. Exact-head Cross-platform CI green on the promoted SHA.
2. Service lifecycle workflow at the promoted SHA (`src/service.ts` moved
   in the Windows stack).
3. Registry/tag/GH-release verification per the scripts/release.ts flow.

Held out of this train: #1885 (xAI Priority) behind the #1875 B2 pricing
gate.

