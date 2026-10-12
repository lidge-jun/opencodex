# Windows quota investigation outcome

FIELD_VALIDATION_PENDING. Issue #3644 remains open. The latest reporter correction
still concerns stable 2.43.0: TUN works, system proxy/rule mode without TUN returns
null plan/quota. The maintainer explicitly requested a categorized comparison from
a build containing #3693. No such current-build result is present.

The existing #3693 diagnostic is on dev: main-account WHAM fetch outcome, identity-
fenced snapshot, and CLI projector preserve the fixed status vocabulary and optional
HTTP code. Null quota is not rewritten to zero. Current CLI declares
ocx account list openai --quota --refresh --json. Source inspection also confirms
service-start environment handling and static WinINET auto discovery.

This unit adds canonical user guidance and seven translated links. It changes no
runtime retry, credentials, quota admission, proxy defaults or user configuration.
No live account/network probes or local suites/typecheck/build were run. Existing
quota/CLI/proxy regressions remain; documentation CI is submitted asynchronously.
The incident is not claimed fixed, and no reporter message is needed beyond the
already posted maintainer request. Final release reconciliation retains the open
field-validation status.
