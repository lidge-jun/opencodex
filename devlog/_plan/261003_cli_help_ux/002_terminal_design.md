# Terminal design and consultation evidence

Read this as a command index for a first-time operator and a returning terminal
user. Use plain labels, indentation and whitespace. Root answers what to do next;
family help preserves existing usage and lists declared operations with partial
coverage marked; detailed help explains declared paths or reports unavailable detail. No boxes, icons, animated output, automatic pager or interactive selection.

Design variance 2/10; motion 1/10 (none); density D8 with a compact entry page.
Terminal font/colors remain user-owned. Concept-image generation is inapplicable
to this text-only utility surface. Plain and redirected output carry all meaning.

Root target: at most 28 logical lines, preferably at most 80 columns. Use short
purpose groups rather than every command's operands. Expose setup/start/status,
doctor/logs/usage, core family names, full reference, command help and JSON
capability discovery. Full reference may be long and retains existing details.
Do not truncate command tokens; allow natural wrapping rather than terminal probes
or a new width/layout dependency. Narrow terminal verification reads real output.

Magpie evidence at the pinned source: main.go lines 31-103 groups examples with
concrete effects, providers_cli.go line 25 has local usage, model_cli.go line 99
recognizes local help, and groups_cli.go line 226 suggests similar model names.
Magpie does not prove a compact root or uniform command typo recovery; those are
our design decisions. No source is copied from Magpie.

UX explorer: `01a100e1-f5e8-7080-85cb-e2ab8de5093d`.
Parser explorer: `01a100e1-f53a-78c1-be32-066cb3e5d4f1`.
Accepted findings: nested path loss, provider self-loop, complete-reference escape,
ordinary help-valued operands, unknown-root preflight, incomplete capabilities.
Excluded: #6483 config flags-only defaults, health parser policy, missing-home
bootstrap changes, and new client support. An incomplete help declaration means
"no detailed help available", not "the executable command does not exist".

Representative desired journey:

```text
ocx --help
  -> ocx help models
  -> ocx help models context
  -> ocx models context status
```

Failure journey: `ocx help modles` offers `ocx help models`, never invokes models.
Static help never reads user configuration to personalize recommendations.
