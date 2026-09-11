# 015 — Layer 1 live evidence (Cursor Private Inference 3.18.25, darwin-arm64)

Setup: worktree at `49d4447a0` + the `output_modalities` fix (committed next), isolated
scratch proxy (not the machine service on :10100) with a request tap in front logging
request bodies, Cursor gateway Base URL through the tap, isolated `--user-data-dir`.

## What the first attempt taught (activation grounding)

With `api_types` + `capabilities` but no `output_modalities`, Cursor still showed no control.
Reading `fetchLocalProviderModels` (`vye`) in `cursor-agent-exec/dist/main.js`: once a row
carries `api_types`, the runtime keeps it only if `capabilities.output_modalities` includes
`"text"` (`Tye`/inline filter) and `supports_tool_use === true`. Rows failing that filter are
dropped from the enriched picker, so the whole list fell back to plain names. Adding
`output_modalities: ["text"]` fixed it. Also: Cursor caches `/models` per base-URL string
(`npe` map), so a changed schema needs a different base URL or an app restart to re-fetch.

## Evidence

- Tap log: `GET /v1/models auth=yes ua=Cursor/3.18.25 -> 200 rows=16 sol_api_types=["chat_completions","responses","anthropic_messages"]`
- Composer picker after refresh: `gpt-5.6-sol Medium` → menu "Reasoning: Medium / Model: gpt-5.6-sol" → Reasoning options **Low / Medium / High / Extra High** (Cursor's GPT-5.6 table; ocx's max/ultra are not exposed, as documented). Screenshots: `011_effort_control.png`, `012_effort_ladder.png`, `013_high_turn.png`.
- Selected High, sent "Reply with exactly the word HIGHPONG2": tap logged
  `REQ /v1/responses model= gpt-5.6-sol reasoning= {"effort":"high"} keys= model,input,store,tools,tool_choice,stream,reasoning` → `POST /v1/responses -> 200`; reply `HIGHPONG2`.
- Because `api_types` advertises `responses`, Cursor switched from `/chat/completions` to
  `/v1/responses` for this gateway (inbound protocol `responses`, `reasoning.effort` form).
