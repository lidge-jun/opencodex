# ADR-0076 — decision recorded under "Startup safety"

- Contract owner: [gui-and-management-api.md](../gui-and-management-api.md#startup-safety)

## Decision record

- 목적과 의도: Make Windows scheduler installation recovery work on non-English systems without broadening the commands that may request UAC.
- 기존 구현 및 제약 조건: Access-denied classification parsed English and German stderr. Chinese OEM output decoded as UTF-8 became mojibake, so the fixed scheduler-create failure lost its machine marker and the dashboard could not select its existing elevation transaction.
- 검토한 주요 대안: Add translations and code-page decoders; elevate every scheduler failure; always launch installation elevated; or combine a native effective-token probe with the already fixed command shape and exit status.
- 선택한 방식: Preserve text detection, then use the native token probe only for status-1 creation of the owned `opencodex-proxy` XML task. Unknown probe results fail closed.
- 다른 대안 대신 이 방식을 선택한 이유: Windows localization and OEM code pages are open-ended, while the token state and owned command shape are stable security signals already bounded by the elevated transaction protocol.
- 장점, 단점 및 영향: Non-English users receive stable guidance and dashboard UAC recovery. A non-permission status-1 failure from the exact owned command may be retried once elevated, but foreign operations cannot cross the elevation boundary and the elevated transaction still fails closed.
