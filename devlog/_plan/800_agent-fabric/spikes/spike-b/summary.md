Spike B -- Claude structured acknowledgement (live attempt)
Date: 2026-08-03
Environment: claude Code 2.1.220 (C:\Users\ws\.local\bin\claude.exe), Windows, temp cwd.
Command: claude -p --output-format json --max-turns 1 "<prompt requesting strict JSON ack with task_id, workspace_id, base_commit, acceptance_criteria_hash, loss_ledger_hash, adapter, adapter_version, harness, harness_version>"

Result:
- Process launched (PID 38768) via Start-Process -WindowStyle Hidden -RedirectStandardOutput.
- ack-output.txt and ack-error.txt remained 0 bytes across a bounded ~4-minute window; process CPU stayed ~1.0s (idle/blocked), consistent with an interactive auth/consent or TTY-trust gate that a headless redirected launch cannot satisfy.
- Process terminated on cleanup.

Capability conclusion:
- The Claude Agent SDK (TypeScript, in-process) is the intended Claude adapter path (see 070/020 B), NOT headless `claude -p` in a redirected window. The SDK documents: Sessions (resume/fork), Permissions (auto/approval), Hooks (lifecycle), structured output, `-p --output-format json` for other-language hosts.
- Therefore structured machine-readable acknowledgement is SUPPORTED by primary docs (020 B); the live CLI attempt surfaced an environment/auth boundary for headless non-interactive use, which is itself a useful finding for the Claude adapter design: programmatic structured ack should be obtained via the in-process SDK (structured output) rather than parsing headless CLI stdout in a redirected context.

A natural-language "I understand" was explicitly not accepted as acknowledgement (080 sec.3); the bounded attempt did not even yield natural language, reinforcing that headless CLI is the wrong probe for structured ack.
