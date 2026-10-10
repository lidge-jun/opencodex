# Lane A — build order

Commits on codex/260923-bundle-a-tests-hygiene, in order, each with the original author's Co-authored-by trailer:

1. #5482 capture resolveAdapter before mocking — Fred Amartey <43480311+FredAmartey@users.noreply.github.com>. Applied as-is.
2. #5607 per-test translator budget disposal — Fred Amartey. Applied as-is.
3. #5570 restore inherited OPENCODEX_HOME in every test file — Fred Amartey. Both PR commits squashed into one carry.
4. #5605 restore real modules after image mocks — Fred Amartey. Fold: snapshot each module before its first override, restore only captured snapshots, and restore in z-handler-activation before the throwable directory cleanup.
5. #5630 guard the real desktop restart adapter in armed test processes — terin <100397903+sh940701@users.noreply.github.com>. Fold: structure/runtime.md documents the skipped outcome.
6. #5340 derived README memory inventory counts — codingbo <9621077+codingbooo@users.noreply.github.com>. Rebuilt on dev after #5615: 14 retained stores, pinned-store eviction wording, recomputed readme/i18n-manifest.json hash, new test registered in layout.json and test-layout-expected.json.

Focused proof per commit: the PR's named files plus a non-isolated same-process ordering that reproduced the leak on dev (run before and after where cheap).
