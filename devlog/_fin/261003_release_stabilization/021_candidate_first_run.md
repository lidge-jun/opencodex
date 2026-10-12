# First complete candidate run: NO-GO

The final candidate check ran once against source
`0818ea1812a028e1c14cd0b0511b44863407bc52` on the immutable
`codex/release-2770-0818-candidate` branch. Run
[37162399902](https://github.com/lidge-jun/opencodex/actions/runs/37162399902),
attempt 1, used `workflow_dispatch` with `lane=all`. Its scope outputs selected
all areas, including native, GUI, desktop packaging, docs and helper matrices.

The result is **NO-GO**: 37 jobs succeeded, Windows shard 8/9 failed, and the
aggregate correctly failed. The separate privacy-only job was intentionally
unrequested; the privacy scan inside `gates` executed successfully.

Linux's four shards, macOS's two shards and full-membership control, and eight
Windows shards passed. macOS widget/app verification and Linux AppImage/deb,
sidecar-keyring and packaged-shell E2E also passed. Those results remain valid
observations of this attempt, not permission to ignore its failed shard.

The reported error is `EPERM` in the temporary-directory teardown of
`server-management-auth.test.ts`, in the self-logout case. The failing batch
reported 140 passes and one failure; later batches in that shard did not run.
The log identifies the recursive removal root, not the particular retained
resource or permission condition. The cause is not established by the error
message or by unchanged owning source relative to the earlier green candidate.

A bounded investigation is collecting causal evidence. No cleanup retry budget,
assertion, test membership, Windows requirement or release gate has been relaxed.
There has been no blind retry, version pre-move, main promotion or publication.
Any separate native diagnostic run is evidence collection only and cannot replace
successful release verification. Production changes require a reviewed,
evidence-backed repair and appropriate current-source regression/CI evidence.
