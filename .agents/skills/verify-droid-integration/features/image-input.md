# Image input

## Sub-features

- Catalog image capability maps to `noImageSupport: false`
- Droid Read loads the image
- The routed model reads visible pixels

## How to get to it (user POV)

Select an image-capable OpenCodex custom model and ask Droid to inspect an image file.

## Driving it with Droid CLI

Run `--cases image`. The helper asks Droid to read `assets/pr-gate-screenshot-required.png` without
putting the headline in the prompt, then requires the exact pixel-only answer plus a matching Read
call and result.

## Gotchas

Models exported with `noImageSupport: true` are `unsupported`. Filename or alt-text inference is not
enough; the expected headline exists only in the image pixels.
