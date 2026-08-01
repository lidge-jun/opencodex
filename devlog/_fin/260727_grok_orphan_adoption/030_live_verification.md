# 030 — WP3: live verification on this machine

A unit test proving the sweep on a fixture is not the same as proving #511 is gone for
the person who reported it. This phase verifies the real file and the real TUI.

## Preconditions

The fix must be merged and the proxy restarted. **The user restarts it themselves via
`ocx service`** — do not run `ocx restart` on their behalf (standing instruction).

## Step 1 — before/after on the real config

Capture the current state first, since the sweep is destructive to the orphans:

```bash
cp ~/.grok/config.toml /tmp/grok-config-before-511.toml
rg -c '^\[model\.' ~/.grok/config.toml          # expect 46 before
rg -n '^default = ' ~/.grok/config.toml         # expect ocx-gpt-5-6-sol (the orphan)
```

After the restart-driven sync:

- `rg -c '^\[model\.'` drops to roughly half (one table per model);
- no `[model.*]` table remains ABOVE the `>>> opencodex managed block` marker except
  genuinely hand-written ones;
- every surviving opencodex table has a `context_window`;
- `default` names an alias that still exists (F2).

A diff of before/after against `/tmp/grok-config-before-511.toml` is the artifact.

## Step 2 — the TUI actually shows the right number

The config being right is necessary but not sufficient: Grok has to READ it. Open the
Grok TUI through computer-use and read the context indicator for the default model.

- expected for `gpt-5.6-sol`: **372k**, not 200k;
- spot-check a 500k model (`xai/grok-4.5`) and a 1M model
  (`alibaba-token-plan-intl/glm-5.2`).

Screenshot is the evidence for `c-live`. If the TUI still reads 200k while the config is
correct, the diagnosis in `000` is incomplete and the unit returns to P rather than
claiming success.

## Step 3 — idempotence on the real file

Trigger one more sync and confirm the file does not change again (F7). This catches a
sweep that "converges" only on the synthetic fixture.

## Rollback

`~/.grok/config.toml.bak-opencodex` is written once at first injection and may be stale.
`/tmp/grok-config-before-511.toml` from step 1 is the trustworthy restore point for this
session.
