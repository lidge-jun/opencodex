# Combo editor render evidence

Rendered source b3175ae940cdb7855aa4959982b3a357c8a6fd89; GUI tree 39d746c992b2e10fc4c281169db3b83e89d40637.
Vite development server served this worktree using existing installed dependencies, with its cache
inside ignored scratch space. No install, build, typecheck or test suite was run. A loopback-only
synthetic API supplied a single-key OpenRouter target; no real account or user service was used.

Browser viewport 1440x862, DPR2. Opened Models -> Combos -> review-combo and edited the public model
name to quota-review. DOM inspection read #cwi-edit-save.disabled; screenshots were opened and
visually inspected. No save request was submitted.

| Input | Observed Save disabled | Image |
| --- | --- | --- |
| Fresh server-confirmed exhausted routingQuota | true | [Exhausted](031_exhausted.png) |
| routingQuota state unknown with exhausted display quota | false | [Unknown](032_unknown.png) |
| Exhausted routingQuota with past validUntil | false | [Expired](033_expired.png) |

The initial fixture omitted the unrelated aliases defaults and caused a fixture rendering error;
the fixture was corrected to the API shape before these captures. These are rendered client
observations with synthetic API responses, not server integration or hosted CI proof.
