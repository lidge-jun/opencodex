# 040 — D record

Terminal outcome: DONE (pending exact-head CI on the final push).

- Branch `codex/voice-sideband-override`, PR https://github.com/lidge-jun/opencodex/pull/3361 against `dev`.
- Commits: 1d5ffdf36 e6a73759f (roadmap), 5f351210c fff79258d (wp2 inject), bb3000dc8 5817505bb 2c296e1e8 (wp3 proxy),
  17cfccf8f f36ff15d3 (wp4 docs).
- First head 2c296e1e8: all CI checks green (test 1-4/4, gates, macos, keyring x3, npm-global x3, hygiene,
  enforce-target, label, react-doctor, storage policy, api usage); Windows shard skipped by the runner
  selector. Second head f36ff15d3 (docs only, CodeRabbit follow-ups): re-run in progress at close time.
- Reviews: Sol auditors Dalton (root cause PASS), Carver (plan FAIL -> blockers folded), Zeno (wp2 FAIL ->
  PASS round 2), Leibniz (wp3 FAIL -> PASS round 2); grok-bot maintainer review recommends merge after CI;
  CodeRabbit 2 minor doc findings folded.
- Gates run: typecheck, focused inject/live/loopback suites, test:changed (10550 pass), privacy:scan,
  docs build. Full local suite deliberately not run (user instruction); CI covers it.

## Residuals (follow-up material, not blockers)

- User-owned root `openai_base_url` (hand-written proxy config): no realtime key injected; those users
  need the manual line. Documented in the guide.
- Provider-table forms (non-loopback admission, authless Desktop): desktop v3 voice stays broken because
  the sideband cannot carry the admission token. Documented as residual.
- Upstream key is `experimental_*`; a rename makes the injected line a no-op (back to today's failure).
- Merge into `dev` is a maintainer action, not taken here.
