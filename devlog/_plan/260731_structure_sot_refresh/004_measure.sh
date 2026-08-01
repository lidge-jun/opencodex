#!/usr/bin/env bash
# 유닛 260731_structure_sot_refresh 의 단일 측정 정본.
# 인벤토리(WP0)와 마감(WP6)이 반드시 이 스크립트를 쓴다. 형태가 다른 임시 rg 는 쓰지 않는다.
#
# 이 스크립트가 증명하는 것과 증명하지 않는 것 (A 감사 2라운드 블로커 6):
#   증명한다  : 문서가 언급한 /api 경로 리터럴이 등록 집합에 드는가, 문서가 지목한 소스 경로가
#               존재하는가, src/ 하위 디렉터리가 어느 문서에든 언급되는가.
#   증명 안 함 : HTTP 메서드/요청 형태 일치, 설정 키·환경변수·워크플로 트리거의 정확성,
#               문서 서술의 의미적 정확성. 이들은 담당 decade 문서의 코드 인용으로만 담보된다.
# 카운트 정의: 경로 리터럴 기준(메서드/경로 쌍이 아니다). 접두 매칭 라우트는 한 개로 센다.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

out="${1:-/tmp/ocx_sot_measure}"
mkdir -p "$out"

# 1) 등록된 관리 API 경로 리터럴
rg -oI '"/api/[a-zA-Z0-9_/:{}.-]*"' src/server src/codex/auth-api.ts \
  | sed 's/.*"\(\/api[^"]*\)"/\1/' | sort -u > "$out/registered_routes.txt"

# 2) SOT 문서가 언급하는 경로.
#    제외: `/api/system/*` 같은 와일드카드 요약 표기와 업스트림 URL 안의 `/api/v1`.
rg -oI '/api/[a-zA-Z0-9_/-]+' structure/ | sed 's/^[^:]*://' \
  | grep -vx '/api/system/' | grep -vx '/api/v1' | sort -u > "$out/documented_routes.txt"

# 3) 문서에만 있는 라우트(비어 있어야 한다)
comm -23 "$out/documented_routes.txt" "$out/registered_routes.txt" > "$out/doc_only_routes.txt"

# 4) 문서가 지목한 소스 경로가 모두 존재하는지.
#    문서는 반드시 저장소 루트 기준 완전 경로를 쓴다: `src/chat/` 은 맞고 `chat/` 은 안 된다.
#    `{a,b}` 중괄호 축약도 쓰지 않는다 — 이 검사가 통과시켜 버린다(4b 가 잡는다).
: > "$out/dead_paths.txt"
# Alternation order matters: `tsx` must precede `ts`, otherwise a .tsx path is truncated to .ts and
# reported as a false dead path.
rg -oI '(src|gui/src|tests|scripts|docs-site|\.github)/[a-zA-Z0-9_./-]+\.(tsx|ts|mjs|cjs|json|yml|sh)' structure/ \
  | sed 's/^[^:]*://' | sort -u | while read -r p; do
    [ -e "$p" ] || echo "$p" >> "$out/dead_paths.txt"
  done

# 4b) 검사를 우회하는 표기 금지: 중괄호 축약 경로
rg -oI '(src|gui/src|tests|scripts)/[a-zA-Z0-9_./-]*\{[^}]*\}[a-zA-Z0-9_./-]*' structure/ \
  | sed 's/^[^:]*://' | sort -u > "$out/brace_paths.txt" || true

# 5) src/ 하위 디렉터리 중 어느 SOT 문서에도 언급되지 않은 것
: > "$out/undocumented_dirs.txt"
for d in $(ls -d src/*/ | sed 's#/$##'); do
  rg -q -- "$d" structure/ || echo "$d" >> "$out/undocumented_dirs.txt"
done

# 6) 소유 매니페스트의 초기 목록. 주의: 이것은 전체 상태 파일 목록이 아니다.
#    매니페스트는 런타임에 자란다(`config-ownership.ts` 의 `[...manifest.paths, rel]`),
#    그리고 `auth.json.pre-multiauth` 같은 파생 파일과 $CODEX_HOME 쪽 산출물은 포함되지 않는다.
rg -o '^\s+"[a-z0-9.][a-zA-Z0-9._-]*",?$' src/lib/config-ownership.ts \
  | tr -d ' ",' | sort -u > "$out/initial_owned_paths.txt"

printf 'registered_route_literals  %s\n' "$(wc -l < "$out/registered_routes.txt")"
printf 'documented_route_literals  %s\n' "$(wc -l < "$out/documented_routes.txt")"
printf 'doc_only_routes            %s (must be 0)\n' "$(wc -l < "$out/doc_only_routes.txt")"
printf 'dead_paths                 %s (must be 0)\n' "$(wc -l < "$out/dead_paths.txt")"
printf 'brace_paths                %s (must be 0)\n' "$(wc -l < "$out/brace_paths.txt")"
printf 'undocumented_dirs          %s\n' "$(wc -l < "$out/undocumented_dirs.txt")"
printf 'initial_owned_paths        %s (NOT the total state-file count)\n' "$(wc -l < "$out/initial_owned_paths.txt")"
