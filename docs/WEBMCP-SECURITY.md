# WebMCP Security Model

- No shell, arbitrary commands, unrestricted file writes, deletion, Git push,
  or publishing tools are exposed.
- Browser tools call the authenticated Agent OS API.
- Scanner remains read-only, excludes secret-named files and never follows
  symlinks.
- Default policy is deny.
- Write-class actions require policy and human approval.
- Write permits are scope-hashed, expiring and single-use.
- Inputs have required-field, length, enum, numeric and traversal checks.
- Audits store hashes and redacted summaries.

Before public release run:

    bun run privacy:scan
    bun audit --audit-level=high
