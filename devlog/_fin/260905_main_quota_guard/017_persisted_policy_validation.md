# Persisted policy field validation

The policy disk decoder now validates usage percentages as finite [0, 100] independently from timestamps, durations and credits. It does not clamp invalid percentages or alter the ordinary rotation-cache decoder. An invalid percentage alone cannot invent a higher-priority window and shadow another valid blocking percentage; independently valid declared window metadata remains meaningful and unknown usage does not switch windows.

Cold identity-matched disk regressions cover invalid numeric/nonnumber values, valid0/99/100, weekly/monthly fallback, metadata/credit independence and updatedAt rejection. They exercise real hydration rather than a policy setter. No local suites. Independent review and exact-head CI are required, followed by both upper-layer cascades.

Averroes source/test re-review PASS, blocking_issues0. Root TypeScript and diff check passed. Test execution remains CI-only; no fresh-head CI success is claimed before publication.
