# 090 — release train 5 outcome

Dev tip at close: 09f8e5ebfe. Final cross-platform CI: run 36449656366, success (attempt 2; attempt 1 failed only two timing flakes that had passed on run 36442547971 at equivalent code).

Merged (29): #6146, #6148, #6160 (claude-cli in the Paid/API group with a subscription warning), #6164, #6165, #6166, #6167, #6168, #6169, #6170, #6171, #6172, #6173, #6174, #6175, #6176, #6177, #6178, #6179, #6180, #6181, #6182, #6183, #6184, #6189, #6190, #6191, #6199, #6202. Per-PR evidence is in 020_merge_ledger.md.

Issues closed: #6118, #6122, #6153, #5561. Contributor PRs closed as superseded with credit: #6144, #6121, #6150, #6030, #5964, #6130, #6131, #6158, #6123, #6110, #6155, #6085, #6154, #5099, #5956, #4177, #3282, #4228 (others were already closed by their authors).

Deferred with reasons: #6188 and the rest of #5831 (unconfirmed provider contract for an omitted tertiary WHAM window); #6163 (superseded by @Ingwannu's #6161); #5539 (reverses a pinned passthrough contract previously declined); #5995 (needs OpenCode's written permission); GUI-heavy and design-level items listed in 000_roadmap.md.

Follow-ups recorded on merged PRs: #6179 recovery-delay notes, #6181 affinity/GET validation (fixed in #6199), #6182 flush elapsed-time assertion, #6167 root-owned POSIX delegation targets, #6169 lifecycle.md sentence, #6190 EIO caching.

Incidents: the platform-service lane's cleanup removed other lanes' /private/tmp verification checkouts (no commits lost); local bun tests were stopped by user order mid-train and PR CI became the only test evidence.
