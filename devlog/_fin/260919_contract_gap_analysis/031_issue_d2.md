# D2: [Docs]: Correct apiKeys documentation to preserve management/data-plane separation

### Documentation problem type

Incorrect documentation

### Documentation location

`docs-site/src/content/docs/reference/configuration/server.md:27` and translated copies

### What is wrong or missing?

The apiKeys row says generated credentials authorize management and data-plane auth. Runtime rejects data credentials as management tokens: [src/server/management-auth.ts:207](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/server/management-auth.ts#L207). The canonical management reference and [tests/server/server-management-auth.test.ts:780](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/tests/server/server-management-auth.test.ts#L780) already establish independent planes.

### What should the documentation explain instead?

Describe generated apiKeys as data-plane admission credentials only and link the separate management credential instructions. This corrects prose; no authentication behavior changes.

### Suggested wording or example

“Generated data-plane admission credentials. They do not authorize management APIs; management access uses its separate credential.” Preserve documented local listener exceptions rather than broadening either plane.

### Additional context or attachments

Pinned source: `7864869c31c41cca9830d93540238f17df8faafb`. Static documentation/source comparison only; no runtime test result is claimed.

Correct the English row and all seven translated copies carrying the same statement; link `reference/management-api.md`. Confirm by text scan and documentation checks. Existing runtime integration coverage is sufficient; do not alter auth code or add implementation-mirroring tests.

### Checks

- [x] I searched existing documentation issues.
- [x] No secrets or personal information are included.
