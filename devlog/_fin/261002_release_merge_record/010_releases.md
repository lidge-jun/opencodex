# Four release rounds

The eight rows below identify GitHub releases and their successful Release
workflow runs. Times are GitHub `published_at` values in UTC, not workflow
start or completion times. All eight release objects are non-draft.

| Tag | Published (UTC) | Release/tag commit | Successful Release run |
| --- | --- | --- | --- |
| [v2.73.0-preview.20260930](https://github.com/lidge-jun/opencodex/releases/tag/v2.73.0-preview.20260930) | 2026-09-30 01:12:39 | [`0cdf0f1f64`](https://github.com/lidge-jun/opencodex/commit/0cdf0f1f6457ab0378047ef2bbf143cf1263341b) | [36652390709](https://github.com/lidge-jun/opencodex/actions/runs/36652390709) — success |
| [v2.73.0](https://github.com/lidge-jun/opencodex/releases/tag/v2.73.0) | 2026-09-30 01:31:08 | [`569e3e7dae`](https://github.com/lidge-jun/opencodex/commit/569e3e7dae48bafc54b8a1a7e3a85129befe2d98) | [36654088816](https://github.com/lidge-jun/opencodex/actions/runs/36654088816) — success |
| [v2.74.0-preview.20260930](https://github.com/lidge-jun/opencodex/releases/tag/v2.74.0-preview.20260930) | 2026-09-30 12:33:10 | [`cbfa828cf5`](https://github.com/lidge-jun/opencodex/commit/cbfa828cf5ba6bec44838ee535e21abe37f8fc65) | [36713179697](https://github.com/lidge-jun/opencodex/actions/runs/36713179697) — success |
| [v2.74.0](https://github.com/lidge-jun/opencodex/releases/tag/v2.74.0) | 2026-09-30 13:33:25 | [`cae9b553e9`](https://github.com/lidge-jun/opencodex/commit/cae9b553e9b882dd13781a7f3ee6f68c0dcc8c4f) | [36720108460](https://github.com/lidge-jun/opencodex/actions/runs/36720108460) — success |
| [v2.75.0-preview.20261001](https://github.com/lidge-jun/opencodex/releases/tag/v2.75.0-preview.20261001) | 2026-10-01 04:15:55 | [`dc1a1b0cc9`](https://github.com/lidge-jun/opencodex/commit/dc1a1b0cc9123ae2fddf5c406921dfae2bc76845) | [36812938867](https://github.com/lidge-jun/opencodex/actions/runs/36812938867) — success |
| [v2.75.0](https://github.com/lidge-jun/opencodex/releases/tag/v2.75.0) | 2026-10-01 04:31:52 | [`ef0297f86c`](https://github.com/lidge-jun/opencodex/commit/ef0297f86c4540c7d757c8595170d66f9c584aec) | [36814374365](https://github.com/lidge-jun/opencodex/actions/runs/36814374365) — success |
| [v2.76.0-preview.20261003](https://github.com/lidge-jun/opencodex/releases/tag/v2.76.0-preview.20261003) | 2026-10-02 17:55:02 | [`7a1faecb1f`](https://github.com/lidge-jun/opencodex/commit/7a1faecb1f7b42dcc512efa473ac58affae42860) | [37041498025](https://github.com/lidge-jun/opencodex/actions/runs/37041498025) — success |
| [v2.76.0](https://github.com/lidge-jun/opencodex/releases/tag/v2.76.0) | 2026-10-02 18:42:21 | [`249462bf57`](https://github.com/lidge-jun/opencodex/commit/249462bf570555aad103957025eea96f7489c7eb) | [37047146196](https://github.com/lidge-jun/opencodex/actions/runs/37047146196) — success |

## Failed runs and subsequent publication

| Round | Failed Release run | Run commit | Observed result |
| --- | --- | --- | --- |
| 2.73.0 preview | [36648529039](https://github.com/lidge-jun/opencodex/actions/runs/36648529039) | [`c3eabadc2c`](https://github.com/lidge-jun/opencodex/commit/c3eabadc2c9a6fe6b0093a6ada569c69ec02e1d7) | macOS desktop bundle build failed; publish was skipped. |
| 2.74.0 stable | [36717981696](https://github.com/lidge-jun/opencodex/actions/runs/36717981696) | [`cae9b553e9`](https://github.com/lidge-jun/opencodex/commit/cae9b553e9b882dd13781a7f3ee6f68c0dcc8c4f) | The publish job failed at “Require successful Cross-platform CI for this commit”; the publication step was skipped. |

Together with the eight successful runs above, these are ten Release runs:
eight successes and two failures. They are distinct run IDs, not a count of
individual jobs.

For 2.73.0, the successful preview and stable release commits include the
macOS keyring-signing carry via [#6272](https://github.com/lidge-jun/opencodex/pull/6272)
and [#6273](https://github.com/lidge-jun/opencodex/pull/6273), following the failed preview build.

For 2.74.0, the later successful run [36720108460](https://github.com/lidge-jun/opencodex/actions/runs/36720108460)
is a new workflow run on the same `cae9b553e9` commit, not a partial-publication
resumption. Both runs have `run_attempt=1`; the successful
[publish job](https://github.com/lidge-jun/opencodex/actions/runs/36720108460/job/109909686130)
records `RESUME: false`.

The 2.76.0 preview tag contains `20261003`, but its GitHub release was
published on October 2 UTC.

## Declared dev content ranges

Each range excludes the left endpoint and includes the candidate at the right.
These are first-parent commit counts, not counts of all transitive commits or
unique user-facing features.

| Round | Range | First-parent count |
| --- | --- | --- |
| 2.73.0 | [`73289d46ae`](https://github.com/lidge-jun/opencodex/commit/73289d46ae3c93d06b9add99d1c834d2e5733d9a)..[`cfa56e34df`](https://github.com/lidge-jun/opencodex/commit/cfa56e34df9e48546c17335dbb2d674e23b60797) | 16 |
| 2.74.0 | [`a30e67f7bb`](https://github.com/lidge-jun/opencodex/commit/a30e67f7bbc8a10db31fe2157d4a462d5120736c)..[`26acb40769`](https://github.com/lidge-jun/opencodex/commit/26acb407694719dc94f241b8ba7a87b18983f37e) | 15 |
| 2.75.0 | [`3008bae770`](https://github.com/lidge-jun/opencodex/commit/3008bae77043701fe0f6200c9117ab7e1f9da2ee)..[`82a4955196`](https://github.com/lidge-jun/opencodex/commit/82a495519608780361d30604d651efe5b89d29cd) | 21 |
| 2.76.0 | [`82a4955196`](https://github.com/lidge-jun/opencodex/commit/82a495519608780361d30604d651efe5b89d29cd)..[`e0af52c8a2`](https://github.com/lidge-jun/opencodex/commit/e0af52c8a2701dccd81fa5e672c92744e59d2e29) | 60 |

The 2.73.0 range contains 16 first-parent commits. The 2.76.0 range includes
[#6351](https://github.com/lidge-jun/opencodex/pull/6351), which opens dev at **2.76.0 before releasing 2.75.0**.
The subsequent [#6462](https://github.com/lidge-jun/opencodex/pull/6462) opens dev at 2.77.0 before releasing
2.76.0 and lies outside that release-content range.

Successful dispatch-triggered Cross-platform CI also exists for the 2.75.0
candidate [36808122713](https://github.com/lidge-jun/opencodex/actions/runs/36808122713)
at `82a4955196` and the 2.76.0 candidate
[37012309480](https://github.com/lidge-jun/opencodex/actions/runs/37012309480) at `e0af52c8a2`
(the latter reports attempt 2). These are separate from the ten Release runs.
A statement about absent push-triggered CI would omit this candidate evidence.
