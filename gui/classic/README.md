# Classic dashboard

The dashboard as it was before the design system v2 redesign, kept so people can switch back.
It is built by `vite.classic.config.ts` into `dist/classic/` and the proxy serves it at `/classic/`.

## What is in here

`src/` holds only the files the redesign changed, frozen at their content on `dev` commit
`b7e01c16e` (locale catalogues excluded: the redesign only added keys), plus every stylesheet of
that commit so CSS `@import` chains resolve inside the snapshot. Every other import comes from
`../src/`, so the classic UI shares the current API clients, hooks, locale catalogues and helpers.
The overlay plugin in `vite.classic.config.ts` decides: an import resolves to the classic copy
when one exists, otherwise to `../src/`.

## Rules

- Do not restyle or extend it. New pages and settings go into the current dashboard only.
- The one addition is the **New dashboard** button at the top of the sidebar foot in
  `src/App.tsx`, which leads back (`../src/lib/dashboard-edition.ts`).
- A change to a shared file in `../src/` reaches this UI too. If it breaks the classic build,
  `bun run build` fails; fix the shared file, or copy the old version of that file in here.
- It is excluded from lint, react-doctor and the file-size ratchet, and it is not type-checked.
  For that reason the lint suppression comments the old files carried were removed: nothing
  reads them here, and PR hygiene treats every added suppression as new.
