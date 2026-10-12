# Recovered contributor changes

The train preserves 31 original carry commits. #6474 already landed separately;
the original recovery scope therefore contained 30 remaining source-PR changes plus
the separately reviewed issue implementations. Three source PRs subsequently landed
independently, leaving 27 source changes for the A-D integration PR. Source PRs are carried or reimplemented, not claimed
to be merged by retaining the carry commit ancestry.

| Source PR | Carry commit | Contributor |
| --- | --- | --- |
| #6474 | `11bbc17d9ed40ed27121a526dbe80039c2b951cd` | hedging8563 |
| #6463 | `f5572a0031471b933a4bafe0236fb509ab78ddfd` | lcxhh521 |
| #6459 | `763dda2117e6d1817f62e0c142d8a45c3b5c9c1a` | luvs01 |
| #6445 | `10975564724b93789493522154919f2f6d5e8e19` | xianhongtao |
| #6426 | `6d4e40443c451039f7d215743aea925852565c49` | andrew05060414 |
| #6479 | `b0b884b2c940ed80de3e47256bb2f878882679c1` | Yuxin-Qiao |
| #6119 | `1ad42a70aeb6448f91a8a73037042f37e2f27480` | kdm1jkm |
| #6455 | `9f5194c96dcc1a757467eefe75e16cee6f6f9380` | luvs01 |
| #6471 | `9d3e6e252a362dd01e756bb48b3af3a75225bf4d` | lcxhh521 |
| #6457 | `26755d9622a8531e242ff06ba649c39c94ab4d3a` | luvs01 |
| #6477 | `00c69c38fc43636a6cb7bcd159ccff13886afed4` | andrew05060414 |
| #6460 | `b2d27e35a263817bb0b115dac5a97ab7f9206f4a` | luvs01 |
| #6415 | `4ef04ff37b2513a4355730ee452537cda6dfb041` | andrew05060414 |
| #6335 | `c294e5811999551272cf2196301cfe8b68fcc325` | sungyongcho |
| #6470 | `a85a43755ae164a324afa7ebd05b9f6e612baa86` | lcxhh521 |
| #6417 | `ce0e7672c8b5a974b61c4f593c0ee0ce2b437dec` | arikon |
| #6254 | `60ed4c65b93e449e77b29dedf83f2cfdf3228b9c` | codingbooo |
| #6382 | `7ccc5929cce938a20f38a50533ff1d79a79dd502` | 2836048681 |
| #6416 | `2abd7341a3c761bba14f54c91128ce656ab99ed6` | xyjk0511 |
| #6461 | `2753ef9e43c445fa0843c6a50fe3bbb970344fdf` | luvs01 |
| #6450 | `ce87c68077216ad0275036315410d1a1eab9e0c0` | luvs01 |
| #6449 | `f5483034009781f5492c884b37bd39b48c38de6d` | luvs01 |
| #6451 | `1108236af701a0a5cac4d44ae99a2d20c9de2da2` | luvs01 |
| #6452 | `dbed9c7b9a9d9266f7358805dbe784acbe2f1ff6` | luvs01 |
| #6453 | `0358e72c8c8ec9a4708aff7401632454ff178a3e` | luvs01 |
| #6192 | `f2641871d0871563810b4e87a27047d670310320` | agentHits |
| #6466 | `6ef255fd067342214ffd0518d11c8ecbe0cc894d` | Hylouis233 |
| #6149 | `3e65384642dd6d02d558a425c1a78654cea24ce6` | yuanyuanlove |
| #6151 | `de828619f84659603f6a13740401049f28dd4dde` | shawn-kim-ai |
| #6405 | `56ea6d76e36370bc341ec1592a9a290a459942d4` | imranshaiedi-byte |
| #6458 | `5d7efbb749ffb72efa6696571b73a4a874a8c61d` | rriosfelipe |

The original B/C carry messages contain credit text but lack a trailer separator.
A clean consolidated contributor block accompanies the recovery ledger commit and
will accompany the final merge message, preserving graph attribution without
rewriting the recovered history.

Potential resolved issues after acceptance: #6425, #6309, #6464 and #6465.
The latter retains explicit per-account paid-credit opt-in. #6313 and #6223 require
their complete issue acceptance, not just the old commit close lines. #6220 remains
open pending real launcher acceptance; #6473 remains open pending native Windows
acceptance. #6406/#6290 are references only. #5253 contributes no carried content.

Maintainer requests on #6416, #6192, #6119, #6149 and #6151 require explicit
evidence-backed dispositions. Current source-head review state is not proof of
a defect in the recovered carry, but it must not be silently discarded.

## Progressive source landings

Under the updated delivery direction, #6459 landed at ee2e15f86da111bfac527842aade9ad7780e15fa,
#6455 at 115fa0322cd938da846957e237d4b97b38527bf6, and #6457 at
9fb79230ba8f1df8b6af13bbb6067c359a4f9344. Each retained successful exact-head PR CI,
no unresolved review threads or maintainer objection, and a recorded owner-integration
decision. The reviewed runtime/test blobs matched the recovery carries. Source PR
changes now in dev are reconciled into the train without duplicating their content.

The selected pt-BR contribution supersedes #5253. Although no file content from that
proposal was copied, the superseded author's trailer is included in final delivery
as required by the repository's attribution policy.
