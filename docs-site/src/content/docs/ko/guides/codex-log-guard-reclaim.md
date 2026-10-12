---
title: Codex Log Guard 공간 회수
description: 증분 vacuum을 제한된 범위에서 실행해 Codex 진단 로그 SQLite 저장소의 빈 페이지를 수동으로 회수합니다.
---

공간 회수는 Codex Log Guard에서 수동으로 저장 공간을 되찾는 단계입니다. Log Guard 보호와 동일한 안전 검사를 데이터베이스와 런타임이 통과했을 때만 정식 Codex `logs_2.sqlite` 데이터베이스를 압축합니다.

공간 회수는 **자동으로 예약되지 않으며**, Storage 페이지를 열었다는 이유만으로 실행되지도 않습니다. 대시보드는 변경 요청을 보내기 전에 명시적인 Compact 작업과 두 번째 확인을 요구합니다.

## 공간 회수의 동작

OpenCodex는 다음 오프라인 유지관리 작업을 정해진 한도 안에서 수행합니다.

1. Codex의 실제 `sqlite_home`에서 정식 `logs_2.sqlite`를 찾습니다.
2. 파일의 정체성과 알려진 Codex 로그 스키마를 확인합니다.
3. 프로세스 열거가 성공했고 지원되는 Codex 쓰기 프로세스가 실행 중이지 않은지 확인합니다.
4. Log Guard 전용 프로세스 간 잠금을 획득합니다.
5. 잠금을 유지한 채 Codex 프로세스를 다시 확인합니다.
6. 기존 데이터베이스를 생성 옵션 없이 읽기/쓰기 모드로 열고 즉시 SQLite 쓰기 잠금을 획득할 수 있는지 확인합니다.
7. `PRAGMA auto_vacuum`이 이미 `INCREMENTAL`인지 확인합니다.
8. 유지관리 전에 `PRAGMA quick_check`를 실행합니다.
9. 전체 WAL 체크포인트를 실행하고, 사용 중이거나 완료되지 않은 체크포인트는 거부합니다.
10. 제한된 크기의 `PRAGMA incremental_vacuum(N)` 배치를 실행하고 배치마다 체크포인트를 수행합니다.
11. 유지관리 후 `PRAGMA quick_check`를 다시 실행합니다.
12. 작업 전후의 데이터베이스 크기, WAL 크기, 페이지 수, freelist와 회수 가능 바이트 수를 보고합니다.

기본 배치 목표는 SQLite 페이지 약 **8 MiB**입니다. 한 번 실행할 때 회수하는 페이지는 최대 약 **256 MiB**이며, 반복 횟수에도 상한이 있습니다. 빈 페이지가 더 남아 있으면 부분 완료로 보고하므로 나중에 Compact를 다시 실행할 수 있습니다.

바이트 한도는 데이터베이스의 실제 SQLite 페이지 크기를 기준으로 페이지 수로 환산합니다. 이는 처리하는 논리적 SQLite 페이지의 한도이지 SSD/NAND 쓰기량을 뜻하지 않습니다.

## 안전 보장

공간 회수는 다음 작업을 **하지 않습니다**.

- 전체 `VACUUM` 실행
- 기존 Codex 데이터베이스의 `auto_vacuum` 모드 변경
- Codex `-wal` / `-shm` 파일을 직접 삭제, 자르기, 이름 변경 또는 조작
- 진단 로그 행 삭제
- Log Guard 보호 트리거나 관련 없는 사용자 트리거 수정
- Codex가 실행 중인 것으로 감지되면 작업 진행
- 프로세스 열거 결과가 불확실하면 작업 진행
- 알려지지 않은 미래의 로그 스키마에서 작업 진행
- SQLite 무결성 검사 실패 후 작업 계속

Log Guard 잠금, SQLite 쓰기 잠금 또는 초기 체크포인트가 사용 중이면 백그라운드에서 재시도하지 않고 명시적으로 거부합니다. 증분 vacuum 배치가 이미 커밋된 뒤에만 체크포인트 경합이 발생했다면, 아무 변경도 없었다고 표시하는 대신 완료된 작업을 `stopReason: "busy"`가 포함된 성공적인 부분 결과로 보고합니다.

## CLI

먼저 회수 가능한 공간을 확인합니다.

```bash
ocx storage codex-logs status
```

제한된 유지관리 작업을 한 번 실행합니다.

```bash
ocx storage codex-logs compact
```

작업 전후 지표를 기계 판독 형식으로 받으려면 다음 명령을 사용합니다.

```bash
ocx storage codex-logs compact --json
```

결과에 회수 가능한 공간이 더 남아 있다고 표시되어도, 다른 제한된 작업을 명시적으로 원하지 않는다면 여기서 멈추세요. OpenCodex는 무한히 반복하거나 후속 작업을 자동 예약하지 않습니다.

## 관리 API

압축은 변경 엔드포인트로만 제공됩니다.

```text
POST /api/storage/codex-logs/compact
```

압축용 GET 별칭은 없습니다. 성공 응답의 `report` 객체에는 작업 전후 측정값, 회수한 페이지 수, 주 데이터베이스 파일의 실제 크기 변화, 반복 횟수, 완료 여부, 중단 이유, 무결성 상태가 포함됩니다.

대표적인 거부 상태는 다음과 같습니다.

- `codex_running`: Codex 실행 중
- `process_enumeration_failed`: 프로세스 열거 실패
- `busy`: 자원 사용 중
- `unsupported_schema`: 지원되지 않는 스키마
- `auto_vacuum_not_incremental`: 증분 모드 아님
- `unsafe_path`: 안전하지 않은 경로
- `integrity_check_failed`: 무결성 검사 실패
- `database_error`: 데이터베이스 오류

무결성 실패에는 유지관리 전과 후 중 언제 발생했는지도 포함됩니다. `busy` 거부는 vacuum 배치가 커밋되기 전에 경합이 감지됐다는 뜻입니다. 성공 보고서 안의 `stopReason: "busy"`는 최소 한 배치가 커밋된 뒤 나중에 발생한 체크포인트 경합으로 작업이 멈췄다는 뜻입니다.

## 결과 이해하기

`pagesReclaimed`와 `logicalBytesReclaimed`는 작업 중 제거한 SQLite freelist 페이지를 나타냅니다. `physicalDatabaseBytesReclaimed`는 유지관리 체크포인트 이후 주 데이터베이스 파일에서 관측된 크기 감소량입니다.

이 값들은 서로 다를 수 있습니다. SQLite, WAL, 파일시스템의 동작 때문에 논리적 페이지를 회수해도 실제 파일 크기가 즉시 같은 양만큼 줄어들지는 않습니다. 어느 지표도 NAND 쓰기량, SSD 마모, 소비하거나 절약한 TBW로 해석해서는 안 됩니다.

`complete: true`는 관측된 freelist가 0에 도달했다는 뜻입니다. 부분 결과에서는 실행당 페이지 예산이나 반복 횟수 상한에 도달하면 `stopReason: "page_budget"`, SQLite가 freelist를 더 줄이지 못하면 `stopReason: "no_progress"`, 회수 작업이 커밋된 뒤 체크포인트 경합이 발생하면 `stopReason: "busy"`를 사용합니다. 세 경우 모두 작업은 정해진 범위에서 끝나며 자동 재시도하지 않습니다.
