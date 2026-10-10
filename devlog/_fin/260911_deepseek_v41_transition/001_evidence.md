# 001 — 근거

2026-09-11 웹 조사. 출처는 DeepSeek 공식 API 문서와 9/10 공지.

## 확인된 사실

| 사실 | 출처 |
| --- | --- |
| V4.1-Flash 출시 2026-09-10 | <https://api-docs.deepseek.com/news/news260910/> |
| 공식 API id는 `deepseek-flash` | <https://api-docs.deepseek.com/> |
| `deepseek-v4-flash`와 `deepseek-v4-flash-vision-exp`는 모델로서 은퇴, 이름은 V4.1-Flash로 라우팅되는 호환 별칭으로 유지, Flash 가격 과금 | <https://api-docs.deepseek.com/> |
| `deepseek-v4-pro`는 2026-09-14 04:00 UTC부터 단계적 퇴역, 이후 요청은 V4.1-Flash로 자동 라우팅, 신규 연동은 `deepseek-flash` 권고 | <https://api-docs.deepseek.com/news/news260910/> |

## 기록해 두는 불일치

같은 체인지로그를 근거로, 질의 표현에 따라 상반된 요약이 돌아왔다. 한쪽은 위 표대로 v4-pro 퇴역과 Flash 요금 적용을 말했고, 다른 쪽은 "9월 14일 이후에도 서비스 계속, 과금 변동 없음, 7월 24일 퇴역한 건 `deepseek-chat`/`deepseek-reasoner`"라고 답했다.

이 유닛은 전자를 따른다. 다만 두 해석이 공통으로 인정하는 사실 하나만으로도 변경 근거는 충분하다: **9월 14일부터 `deepseek-v4-pro` 요청은 V4.1-Flash로 라우팅된다.** 퇴역이냐 임시 라우팅이냐와 무관하게, 그 시점 이후 `deepseek-v4-pro` 행은 Pro 사다리·Pro 컨텍스트·Pro 가격을 광고하면서 Flash를 서빙한다. 잘못된 광고를 남겨두는 쪽이 제거보다 나쁘다.

저장소 내부 근거로는 이슈 #4253과 PR #4258이 Command Code 라이브 로스터에서 `deepseek/deepseek-v4.1-flash`가 실제로 서빙되는 것을 확인해 준다.

## 이 유닛이 주장하지 않는 것

- 벤더 호스팅(Volcengine, Alibaba, Ollama Cloud, NVIDIA NIM, Baseten, cline-pass, orcarouter, codebuddy, qoder) 로스터에서 v4-pro가 중단됐다는 주장은 **하지 않는다**. 그쪽은 각자 스냅샷과 일정이 있고, Volcengine은 `deepseek-v4-pro-260425`처럼 날짜가 박힌 id를 쓴다.
- Zen 게이트웨이가 `deepseek-flash` 철자를 받는다는 주장도 하지 않는다. 게이트웨이 쪽은 관측된 `deepseek-v4.1-flash`를 쓴다.
