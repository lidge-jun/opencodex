# 020 — wp3 / ISSUE-2: glm-5.3-flash 입력 모달리티 양수 선언

## 결함

glm-5.3 은 text-only 이고 glm-5.3-flash 는 네이티브 VLM 이다(001 문서, 그리고 상류
GET https://api.z.ai/api/v1/models 의 input_modalities).

zai 와 zhipu-bigmodel-coding 행은 이 사실을 noVisionModels 음수 선언으로만 표현한다.
ZAI_GLM_5X_SIDECAR_VISION_MODELS 가 flash 를 제외하므로 vision sidecar 우회는 막히지만,
modelInputModalities 가 없어 configuredInputModalities 가 undefined 를 돌려주고 카탈로그가
["text"] 플로어로 떨어진다. 결과적으로 클라이언트 export(ZCode / Pi / OMP)의 모델 피커에
네이티브 VLM 이 text-only 로 실리고 이미지 첨부가 막힌다.

zhipu-bigmodel-responses 행은 이미 양수로 선언한다. 같은 모델인데 행마다 다르게 표현된 상태다.

## 변경

### MODIFY src/providers/registry.ts

ZAI_GLM_5X_SIDECAR_VISION_MODELS 정의 바로 아래에 공유 상수를 추가한다.

    const ZAI_GLM_5X_INPUT_MODALITIES: Record<string, string[]> = {
      ...Object.fromEntries(ZAI_GLM_5X_SIDECAR_VISION_MODELS.map(id => [id, ["text"]])),
      "glm-5.3-flash": ["text", "image"],
    };

주석으로 남길 근거: noVisionModels 는 음수 진술이라 sidecar 우회만 막고 카탈로그에 모델이 무엇을
읽을 수 있는지 말해주지 않는다는 것, 그리고 권위 출처가 GET https://api.z.ai/api/v1/models 의
input_modalities(["text"] vs ["text","image"], evidence/zai-responses-models.json 에 캡처)와
docs.z.ai/devpack/latest-model 의 산문이라는 것.

zai 행과 zhipu-bigmodel-coding 행 각각에 한 줄씩 추가한다.

         noVisionModels: ZAI_GLM_5X_SIDECAR_VISION_MODELS,
    +    modelInputModalities: ZAI_GLM_5X_INPUT_MODALITIES,
         modelReasoningEfforts: ZAI_GLM_5X_REASONING_EFFORTS,

glm-4.6 은 두 행의 models 에 있지만 5.x 가족이 아니라 이 맵에 없다. 선언이 없으면 기존 폴백 동작이
유지되므로 의도적으로 건드리지 않는다.

### MODIFY tests/providers/provider-registry-parity.test.ts

기존 전역 assertion 은 "flash 선언이 있으면 image 를 포함해야 한다"는 조건부다. 이제 Chat 행에서도
선언이 존재해야 하므로 고정 기대값을 추가한다.

    test("the Chat-path Z.AI rows declare glm-5.3-flash as multimodal, not just out of the sidecar list", () => {
      for (const id of ["zai", "zhipu-bigmodel-coding"] as const) {
        const row = PROVIDER_REGISTRY.find(entry => entry.id === id);
        expect(row?.modelInputModalities?.["glm-5.3-flash"]).toEqual(["text", "image"]);
        expect(row?.modelInputModalities?.["glm-5.3"]).toEqual(["text"]);
        expect(row?.noVisionModels ?? []).not.toContain("glm-5.3-flash");
      }
    });

## 범위 밖

src/generated/model-metadata.ts 와 scripts/model-metadata.source.json 의 zai 번들에는 glm-5.3-flash
행 자체가 없다. 그 파일은 vendored 스냅샷 + 생성물이고 tests/codex-integration/model-metadata-sync.test.ts
가 바이트 동기화를 강제한다. 스냅샷 갱신은 별도의 의도적 커밋이므로 이 PR 에 섞지 않는다.
레지스트리 선언이 폴백보다 우선하므로 이 결함은 레지스트리 한 곳에서 닫힌다.

상류가 말하는 Flash 의 입력은 Video / Image / Text / File 이지만 이 변경은 image 까지만 선언한다.
ocx 의 내부 모달리티 어휘는 text / image / audio 이고 ZCode·Pi export 어휘는 text / image 뿐이라
(src/clients/config-export/model-metadata.ts:56-58) video 와 file 은 표현할 자리가 없다.
피커 결함은 image 선언만으로 닫힌다. video / file 은 명시적으로 범위 밖이다.

## 검증

    bun test tests/providers/provider-registry-parity.test.ts tests/codex-integration/catalog-vision-sidecar-modalities.test.ts
    bun run typecheck
