# 140 — dev release prep

After wp11 lands. Version bump per release train conventions; release notes cover:
sidecar unification (L1-L9), chat-default regression + opt-in switch, responses fixes
(#2237/#2229/#2228, reshaped #2217), maintainer fixes (#2196/#2207/#2202), luvs01
fixes (#2214/#2236/#2226), devlog docs (#2181/#2168). scripts/release.ts is the
authority; no release action without the doc-150 gate green.
