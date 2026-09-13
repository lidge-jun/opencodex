# 054 — residual delivery and final CI pin

All prepared residual and corrective changes are merged. Code is frozen for CI at 55395a9dc8a252a01f606b7b65859579e4f2e53d.

| PR | Head | Merge |
|---|---|---|
| #3612 | c60f95bb54de1d7985d866db848102ca97f933c6 | bef04efbcf506ac26ebd3eeba8ac397a5d8a8d0d |
| #3614 | e965d651c2c8e37dfede53a934e4b97b613e4a4e | 00139c1bc9ad3b9b344b433c053e6246650574b9 |
| #3615 | 7800a744b6d28ea4ec86952cca66c70e5152b354 | 7a704e3b078f1a92b81c0f7878a57cf881ca546b |
| #3616 | 59a1108055de175101ec3f53cf7c383e37ae9e17 | 4e2246c327f33ab25d7635ca3dd2275417b43f0c |
| #3617 | 5cdf65dcec782c839a1bbda1e7ecd2788d37a9af | 3b3fe21d45e57761e9769020da4b37de5cd95726 |
| #3618 | e02a4f51df290f8b69f06141efa9ee4dae7edddd | 55395a9dc8a252a01f606b7b65859579e4f2e53d |
| #3619 | beb116a8f2d939ae7b82329b55632d7baff32a2c | 808b3dca3fdc319b54b9c4e1c3b2663b886da139 |
| #3608 | 1d47274769b9f4b56c610c3af6d4466adc37bbf6 | c44e187ee901275f977f5a2be32c782f4e1f1794 |
| #3508 | b78cadf12506df20b1e14ee42224ab4321dedbe5 | c9e4cf0d7bfbf3285df45341f7b3bc0a3cce2ae3 |
| #3521 | 5b75c8046fd047279f60bbe9477442a7ae22fa76 | f008a553dc99d8038fe644c57c1718846da04fa3 |

Final Cross-platform CI: https://github.com/lidge-jun/opencodex/actions/runs/33943525788
This is the push run for exactly 55395a9dc8a252a01f606b7b65859579e4f2e53d; pending is not green.

The canonical-discovery top was rebased after its lower layers were squash-merged, then pushed with a lease. Source credit and the exact-proxy IPv6 gate were retained. The misleading pure-benchmark-only comment was corrected to match the resolver's existing per-answer behavior, without changing admission logic.

#3508 is delivered as a standalone filter-engine module, not new live Logs controls. #3521 retains exact-model precedence and numeric-family inheritance only for the Anthropic adapter. #3528 is now an effort-only carry; it is no longer incorrectly classified as superseded by the agy alias.

No more speculative development or local tests: only actual final Linux failures or concrete post-merge defects can reopen source work.

