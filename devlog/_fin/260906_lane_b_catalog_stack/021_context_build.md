# Context selection carry build

Replacement #3695 carries #3654 final head `8facdb0d8c10109701015c0f6109fc67b1d9dd3c` with Robin Bially's author identity, coauthor trailer, source screenshots and setAll clarification. The new `providerContextCapValues` map preserves inactive selections without applying them to catalog metadata.

Additional regression cases cover both setAll payload shapes, legacy active-only reloads, invalid-request memory/disk atomicity, removal/editor cleanup, rename collision, disabled native budgets and GUI remount/old-response fallback. The source/security review identified a numeric-selection lookup defect for valid inherited property names; the carry now requires an own numeric remembered value and covers first-enable/off/reload/on for toString and valueOf. Final review and remote/hosted execution remain pending at this checkpoint. Public API, provider config and routing documentation are synchronized across existing locales.

Parent #3685 completed full exact-head CI 33978686258 and independent code/security plus remote GUI/docs verification. It was admin-merged into dev as `9115b179a29f1366561139b8502cebb17bf816e9`; source #3653 and issue #3650 were immediately closed after ancestry proof. #3695 was retargeted to dev before parent merge to preserve the stack safely.
