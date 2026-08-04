# Documentation-site instructions

This file applies to `docs-site/` and inherits the repository-wide rules in `/AGENTS.md`.

## Source-of-truth rules

- `docs-site/` is the public user-documentation source.
- Document current shipped or intentionally pending behavior. Do not copy claims from historical `docs/` or `devlog/` material without verifying them against current code and configuration.
- English documentation is the canonical source. Translated content must not contradict it.
- Keep commands, paths, configuration keys, defaults, branch names, and URLs synchronized with the repository.
- Do not edit generated build output.

## Editing rules

- Reuse the existing Astro and Starlight structure, navigation, components, and style.
- Update all directly affected pages when a user workflow changes.
- Do not add duplicated policy text when a stable canonical document can be linked instead.
- Use repository-relative links for repository files and site-relative links for documentation pages where the existing site does so.

## Required validation

Run:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

Do not claim documentation validation passed unless this build completes successfully.
