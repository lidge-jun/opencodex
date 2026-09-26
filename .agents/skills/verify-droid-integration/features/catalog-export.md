# Catalog export

## Sub-features

- Live active-model filtering
- Stable `custom:opencodex:<selector>` IDs
- Exact generic Chat provider and loopback URL
- A 16,384-token response ceiling instead of the full context window
- Context, image, and reasoning metadata
- Keyless config and per-row ownership

## How to get to it (user POV)

Open **Integrations → Factory Droid**, or run `ocx integration client enable --client droid`.
For a non-persistent preview, run `ocx export --client droid --out <temp> --force`.

## Driving it with Droid CLI

Run the verifier with `--dry-run`. Inspect `settings.json` and each model's `catalog.json`.

## Gotchas

The export includes hub-approved Fast rows as active selectors. Do not compare it with a raw provider
count. The inbound Factory bridge in the docs is a separate direction.
