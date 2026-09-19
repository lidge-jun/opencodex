# Integration preview delivery status

Issue #5118 remains open. [PR #5185](https://github.com/lidge-jun/opencodex/pull/5185) is a draft server-layer implementation. The preview API, confirmation-bound mutation, regression coverage, documentation and dashboard delivery must all be completed and verified before issue closure.

The owner is continuing implementation under independent review. Detailed working review records are retained in ignored scratch. Draft publication and an individual review result are not completion evidence.

No local tests, typecheck, build, installation or proxy runtime execution were performed. Applicable exact-head hosted CI and actual dashboard visual evidence remain required; a built preview artifact alone is not a screenshot.

Draft #5185 now includes a read-only preview entrypoint and a filesystem regression at d987ee4fc9. Independent source/test review and hosted verification are in progress. Management routes, confirmed mutation binding, profile/restore coverage and the dashboard remain unfinished; the draft is not merge-ready.

The untouched dashboard layer was released to the existing policy owner. The runtime owner retains the server implementation and its documentation. The dashboard will be a manual child of #5185 and must provide actual visual evidence. Server implementation and independent review continue; #5118 remains open.

The server now includes the profile preview route, a bound restore success case and structure documentation at50ecfda2c2. Scoped review accepted route reachability and the complete store-content witness, but identified further corrections and missing profile coverage. The owner received the private findings; the server and dashboard remain incomplete.

The additional roster invalidation change at e53d68d0a4 is not yet accepted: review found its new regression does not activate an actual successful discovery publication. The owner is correcting that mismatch; a separate source lookup is checking the existing configuration revision owner. Accepted route and immutability results remain recorded separately from these open requirements.

Correction1c37027d9d now asserts bound restore succeeds, deletes the initially absent target and retains both the prior apply and new restore journal entries. Main inspected the exact diff and its absent-file setup. This corrects the previously invalid postcondition; actual hosted execution, profile history selection and roster authority verification remain outstanding.

Server corrections e99250dfe8 and c4d207cabf now address cache-content publication revision and selected restore operation identity. Independent re-review is checking those exact changes, including actual publication/removal paths and history-store consistency. Configuration authority and complete profile regression evidence remain required.
