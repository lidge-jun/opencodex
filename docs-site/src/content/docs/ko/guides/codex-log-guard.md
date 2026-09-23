---
title: Codex Log Guard
description: 로그 본문을 노출하지 않고 Codex 진단 로그의 저장 상태를 살펴보고 명시적으로 줄입니다.
---

OpenCodex는 Codex의 영구 진단 로그 데이터베이스를 살펴볼 수 있습니다. 사용자가 선택하면 Codex가 저장하는 진단 로그 행도 줄일 수 있습니다. 조회는 읽기 전용이며, 보호 설정은 알려진 Codex 로그 스키마가 있고 Codex가 중지된 경우에만 허용되는 명시적 변경 작업입니다.

## Inspect가 보고하는 내용

OpenCodex는 Codex의 기존 우선순위에 따라 실제 `sqlite_home`을 찾고 그 안의 정식 `logs_2.sqlite` 데이터베이스를 검사합니다. 번호가 더 높거나 구형인 `logs_N.sqlite` 파일을 변경 가능한 대상으로 대신 사용하지 않습니다.

Storage 화면에는 다음 정보가 표시됩니다.

- 주 데이터베이스, WAL, SHM 파일 크기
- 전체 로그 행 수와 `TRACE` 수준으로 저장된 비율
- 행 수가 가장 많은 로그 대상 그룹. 대상 이름 대신 순위 레이블을 사용합니다.
- 나중에 회수할 수 있는 SQLite freelist 공간
- 관측된 스키마가 현재 알려진 Codex 로그 스키마와 호환되는지 여부

`sqlite_home`이 `CODEX_HOME` 밖에 있다면 진단 데이터베이스를 별도로 표시합니다. 해당 바이트 수를 기존 `CODEX_HOME` 저장소 합계에 몰래 합산하지 않습니다.

OpenCodex는 이 진단 정보를 만들 때 `feedback_log_body`를 조회하거나 노출하지 않습니다. 로그 수준은 정해진 알려진 수준과 `OTHER`로만 분류하며, 대상 이름은 직렬화하지 않습니다.

## Protect 모드

보호 기능은 기본적으로 **꺼져 있습니다**. 켜면 Codex의 정식 `logs_2.sqlite` 데이터베이스에 OpenCodex 소유의 `BEFORE INSERT` 트리거 하나를 설치합니다. OpenCodex는 예약된 이름을 가진 알 수 없는 트리거를 교체하지 않으며, SQL이 OpenCodex 소유 버전과 일치하는 트리거만 제거합니다.

두 가지 모드를 사용할 수 있습니다.

- **Compatibility** (`compat`)는 권장 모드입니다. 현재 Codex가 영구 SQLite 로그 저장 과정에서 이미 필터링하거나 로그 수준을 낮추는 대량 발생 대상에 Log Guard v1 규칙을 고정합니다. 관련 없는 `TRACE` 행은 유지합니다.
- **Quiet** (`quiet`)는 새 `TRACE` 행을 모두 억제하고 `DEBUG`, `INFO`, `WARN`, `ERROR` 행은 유지합니다.

보호 기능은 영구 SQLite 저장소에 도달하는 행을 줄입니다. Codex가 그 전에 수행하는 추적 작업까지 없애지는 **않습니다**. 트리거가 행을 무시하기 전에 이벤트가 형식화되고, 대기열에 들어가고, 트랜잭션으로 묶이고, Codex 자체 정리 로직의 검토 대상이 될 수 있습니다. Protect는 Codex 내부의 진단 정보 생성을 끄는 스위치가 아니라 영구 저장소의 쓰기 부하를 줄이는 장치로 보세요.

Log Guard는 로컬 SQLite에 저장되는 로그 행만 필터링합니다. Codex의 진단 처리, [어댑터 전송](/ko/reference/adapters/), 프로바이더 페이로드, 스트리밍 의미, 인증, 라우팅, 할당량, 계정 상태는 바꾸지 않습니다.

### 안전 검사

Protect, Disable, Repair가 외부 데이터베이스를 변경하기 전에 OpenCodex는 다음을 확인합니다.

1. 정식 `logs_2.sqlite` 경로만 찾습니다.
2. 해당 경로가 심볼릭 링크가 아닌 일반 파일이고 알려진 스키마와 정확히 일치하는지 확인합니다.
3. 프로세스 열거가 성공했고 지원되는 Codex 쓰기 프로세스가 실행 중이지 않은지 확인합니다.
4. Log Guard 전용 프로세스 간 잠금을 획득합니다.
5. 잠금을 획득한 뒤 Codex 프로세스를 다시 확인합니다.
6. 생성 옵션 **없이** 데이터베이스를 읽기/쓰기 모드로 열고 대기 시간 없이 SQLite `BEGIN IMMEDIATE`를 획득합니다.
7. OpenCodex 소유 Log Guard 트리거만 변경하고 커밋 전에 결과를 다시 읽어 확인합니다.
8. Log Guard 잠금을 유지한 상태에서 요청한 모드를 OpenCodex 설정에 저장합니다.

프로세스 열거가 불확실하거나, 데이터베이스가 사용 중이거나, 스키마를 알 수 없거나, 예약된 트리거 이름에 다른 SQL이 연결되어 있으면 변경을 거부합니다. OpenCodex는 Codex를 자동 종료하지 않습니다.

## 설정 이탈과 복구

요청한 보호 모드는 Codex 로그 데이터베이스와 별도로 OpenCodex 설정에 저장됩니다. Codex 마이그레이션이 `logs` 테이블을 다시 만들면 SQLite가 교체된 테이블에 연결된 트리거를 삭제할 수 있으므로 이 구분이 중요합니다.

저장된 모드가 `compat` 또는 `quiet`인데 해당 소유 트리거가 더 이상 보이지 않으면 Log Guard는 상태를 **drifted**로 보고합니다. `ocx doctor`는 이탈을 보고하지만 자동으로 복구하지는 않습니다.

복구는 명시적으로 실행합니다.

```bash
ocx storage codex-logs repair
```

OpenCodex는 시작할 때마다 보호 기능을 다시 만들지 않습니다. 향후 릴리스에서 Codex 마이그레이션 전반에 걸친 안전성을 뒷받침하는 현장 증거가 충분히 모이면 자동 복구를 다시 검토할 수 있습니다.

## CLI

상태를 읽습니다.

```bash
ocx storage codex-logs status
ocx storage codex-logs status --json
ocx doctor
```

권장 호환 정책을 켭니다.

```bash
ocx storage codex-logs protect
```

Quiet 모드를 명시적으로 선택합니다.

```bash
ocx storage codex-logs protect --mode quiet
```

OpenCodex 보호를 끄거나 설정 이탈을 복구합니다.

```bash
ocx storage codex-logs unprotect
ocx storage codex-logs repair
```

Log Guard 명령에 `--json`을 추가하면 기계 판독 형식으로 출력합니다. 정식 명령 구문과 JSON 동작은 [CLI 레퍼런스](/ko/reference/cli/)를 참고하세요.

기존 명령은 바뀌지 않았습니다.

```bash
ocx storage --json
```

응답에는 Storage 페이지에서 사용하는 것과 동일한 Codex 로그 상태가 포함됩니다.

## 관리 API

상태는 다음 경로에서 확인합니다.

```text
GET /api/storage/codex-logs
```

명시적 변경 요청은 다음 경로를 사용합니다.

```text
POST /api/storage/codex-logs/protect
POST /api/storage/codex-logs/unprotect
POST /api/storage/codex-logs/repair
```

Protect 요청 본문은 `{"mode":"compat"}` 또는 `{"mode":"quiet"}`입니다. `GET /api/storage`에도 보고서가 `codexLogs`로 포함되어 있어 대시보드가 저장소 구성과 Codex 로그 진단을 하나의 스냅샷 요청으로 갱신할 수 있습니다.

## 읽기 전용 스냅샷의 의미

상태 조회는 SQLite `immutable=1`을 사용해 데이터베이스를 읽기 전용으로 엽니다. 따라서 진단 조회가 `-wal` 또는 `-shm` 보조 파일을 만들거나 갱신하지 않습니다.

여기에는 중요한 제약이 있습니다. SQL 집계와 관측된 트리거 메타데이터는 마지막 체크포인트가 반영된 데이터베이스 스냅샷을 설명합니다. Codex가 쓰는 중이라면 현재 WAL에 불변 스냅샷보다 새로운 행이나 스키마 페이지가 들어 있을 수 있습니다. 성공한 변경 응답은 OpenCodex가 쓰기 트랜잭션 안에서 확인한 트리거 상태를 사용하지만, 이후 읽기 전용 상태 요청은 SQLite가 해당 스키마 페이지를 체크포인트할 때까지 잠시 뒤처질 수 있습니다.

OpenCodex는 WAL 파일 크기를 별도로 보고하며 그 결과를 SSD 쓰기 속도, NAND 쓰기량, 드라이브 마모/TBW 소비량으로 표시하지 **않습니다**.

## 호환성 상태

알려진 스키마에서는 조회와 보호가 지원되는 것으로 보고합니다. 스키마가 없거나 읽을 수 없거나 알려지지 않은 미래 버전이라면 메타데이터는 살펴볼 수 있지만 변경 작업은 지원되지 않는 것으로 보고합니다.

알 수 없는 스키마를 추측으로 호환 처리하지 않습니다. 이 덕분에 새 Codex 버전의 상태는 관찰하면서도 검토하지 않은 데이터베이스 구조를 Log Guard가 안전한 변경 대상으로 간주하지 않습니다.

## 공간 회수는 별개입니다

Protect는 SQLite를 vacuum하거나 압축하지 않습니다. [**Reclaim**](/ko/guides/codex-log-guard-reclaim/)에서 체크포인트와 무결성 검사를 포함한 명시적이고 제한된 오프라인 증분 vacuum 절차를 사용할 수 있습니다.

Protect는 `VACUUM`을 실행하거나 Codex의 WAL을 직접 자르거나 삭제하지 않으며, 공간 회수를 예약 실행하지 않습니다.
