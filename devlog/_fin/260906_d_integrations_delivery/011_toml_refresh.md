# TOML cycle P refresh

Parent: cb75f49c9401e10f8bd37f4817cdef32b0a5cbe1, documentation PR #3681.
Source: f6db9cae8e8854c6df06087288a074d767f9787d by Hako.

Read-only git comparison from source parent to the current parent returned no changes in config-io.ts and the two affected client regression files. The 010 diff remains applicable. The shared parser admits both status and writers; no caller-specific exception or new option is required.

Implementation scope stays as 010. Main will cherry-pick the original commit and add the structure contract. An inherited independent reviewer audits the candidate; no local application tests or typecheck are permitted. Hosted CI supplies runtime verification; docs build may run in a fresh macmini-cf scratch checkout with no real credentials or service changes.
