# ADR-0025 — Ultra reasoning level

- Contract owner: [catalog.md](../catalog.md#ultra-reasoning-level)

## Decision record

- 목적과 의도: GitHub Copilot의 live model catalog가 명시하는 모델별 image-input 지원을
  Codex catalog에 정확히 보존한다.
- 기존 구현 및 제약 조건: 공용 discovery parser는 직접 `capabilities.vision`과 표준 modality
  필드는 읽었지만 Copilot의 `capabilities.supports.vision` 중첩 boolean은 읽지 않아 모든
  Copilot 모델이 text-only fallback으로 축소되었다.
- 검토한 주요 대안: 모든 Copilot 모델에 정적 vision seed를 추가하기, 모델 이름을 외부
  metadata alias에 연결하기, live 모델별 boolean을 공용 parser에서 해석하기.
- 선택한 방식: 직접 vision boolean이 없을 때만 중첩 `supports.vision`의 명시적 boolean을
  사용하고, `false`도 보존하며 malformed 값은 추론하지 않는다.
- 다른 대안 대신 이 방식을 선택한 이유: live 응답이 모델별 capability의 가장 좁은 근거라서
  새 모델에도 적용되며 text-only 모델을 image-capable로 과장하지 않는다.
- 장점, 단점 및 영향: Copilot vision 모델은 image attachment를 받을 수 있고 명시적 text-only
  모델은 계속 차단된다. Capability를 제공하지 않는 모델은 기존 fallback을 유지한다.
