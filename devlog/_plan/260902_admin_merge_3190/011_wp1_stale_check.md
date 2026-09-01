# 011 — wp1 stale check against current tree

Rebased this branch onto `origin/dev` = `c87071400` (#3194) before wp1 implementation. 091 is unchanged: line 13 still has the two remote macOS home-path tokens that `bun run privacy:scan` reports. 020's Windows npm prefix uses allowed username `user` and is not a scan hit. 010's replacement text is still valid; no line-number drift.
