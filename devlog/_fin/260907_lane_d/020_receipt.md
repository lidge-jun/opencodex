# 020 Display-name receipt recovery
MODIFY gui/src/components/ModelDisplayNameDialog.tsx.
Before: input/reset enabled whenever saving=false; input onEdit clears recovery.
After: new mutationOutcomeUnknown prop from Models.tsx recovery.confirmed===false
disables draft editing and reset, submit retains
read/retry action. Handler guards prevent synthetic events bypassing disabled controls.
Close/cancel stays available. This is bounded UI recovery, not server request ordering.
MODIFY gui/tests/models-display-name-editor.test.tsx: unknown receipt cannot replace intent; retry recovers; confirmed saved:true
and ordinary validation error remain
editable. Screenshot changed disabled input/reset with retry available.

Verification: NOT RUN locally by user instruction; focused tests execute in final top-head Cross-platform CI.

Implementation: unknown outcome guards input/reset handlers and submit, and focuses Retry
when saving fails without a receipt. Saved:true remains editable. Transport/body failure
matrix attempts a replacement intent and asserts no second PUT before read-only retry.
Astra Herschel plan verdict PASS. Screenshots and product execution await top CI artifact.
