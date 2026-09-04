# 260904_gpt6_astra_prereg — preemptive gpt-6-astra registration

## Evidence
- 2026-09-03/04 X + dev community: Responses API probe of `gpt-6-astra` returns 404 like internal
  staging slugs (arbitrary slugs 400); OpenAI posted a launch teaser the same day (2.5M views).
- aside-jun X search on the signed-in profile confirmed the chatter and the OpenAI teaser post.
- Upstream codex-rs (main @ 7a7c18868, pulled 2026-09-04): no astra/gpt-6 reference yet.
- GPT-6 / GPT-5.7 / standalone naming is unconfirmed; only the API slug is evidenced.

## Change (GPT native side only, per user)
- NATIVE_GPT6_ASTRA_MODEL = "gpt-6-astra": account-gated (roster-proven availability only),
  capability metadata inherited from gpt-5.6-sol, GPT-5.6-era context clamp until measured,
  NOT wire-normalized (the slug is the API id).
- Nothing surfaces anywhere until an entitled account's authenticated /models roster lists it —
  the registration is invisible until OpenAI ships.
