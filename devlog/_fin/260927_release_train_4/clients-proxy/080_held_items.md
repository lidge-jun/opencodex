# Phase 8: source PR and issue disposition

Depends on outcomes from `010`-`070`. This is a GitHub triage phase, not a
product-code batch. It is complete only when each row has a current link and
the correct open/closed state. Comments are in English and name the specific
missing proof or replaced PR. Do not close a source PR until its replacement
has merged into `dev`; leave a genuine enhancement open when held.

## Exact external change map

- COMMENT, then CLOSE replaced source PRs #6051, #5893, #5272,
  #5193, #5871, #5983 only if the corresponding carried behavior actually
  landed. Include the lane PR and merge SHA and thank the original author.
- COMMENT, KEEP OPEN #5950 and linked #5660: Qoder is held because its opt-in
  config-write, restore and path contracts have not been revalidated on this train.
- COMMENT, KEEP OPEN #5905: opening Cursor status currently fetches a remote
  installer manifest without a user action. Ask for an explicit discovery
  policy and timeout/status regression. Keep draft and no installer launch.
- COMMENT, KEEP OPEN #3833: the literal `apiKey` placeholder in its export is
  rejected by Command Code; require a documented supported keyless/reference
  form and client-side proof, then refresh against `dev` and security review.
- COMMENT, KEEP OPEN #4854: require OpenScience config path/schema and
  override/restore ownership evidence; the manual endpoint remains usable.
- COMMENT, KEEP OPEN #3494: require one named VS Code extension's officially
  supported settings, reload behavior, and per-scope ownership contract.
- COMMENT, KEEP OPEN #1416: require a versioned, secret-free Orca launch
  manifest that can be generated while the proxy is stopped; do not insert
  it into live model export before the consumer schema is agreed.
- COMMENT, KEEP OPEN #2811: record the design-only judgment. #5016 was
  closed unmerged because `managed: true` was unreachable from the production
  inspector. Establish a real provenance predicate and read-only plan before
  considering an apply mutation.
- CLOSE linked #5853 and #5982 only when the exact behavior is on
  `dev`, with the lane merge link. #5679 remains open while #5905 is held.

## Acceptance and proof

Fetch each PR/issue after each comment/close and verify state and URL. Do not
count a `gh` command's exit alone as proof. The issue-close list is conditional
on actual merged outcomes. Re-read source authors for attribution trailers.
