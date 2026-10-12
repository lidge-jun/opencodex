---
title: Codex Log Guard
description: ログ本文を公開せずに、Codex の診断ログの永続化状態を調べ、明示的に削減します。
---

OpenCodex は Codex の永続診断ログデータベースを検査し、利用者が有効にした場合は Codex が永続化する診断行を減らせます。検査は読み取り専用です。保護は明示的な変更操作であり、既知の Codex ログスキーマが存在し、Codex が停止していなければ拒否されます。

## Inspect が報告する内容

OpenCodex は Codex 既定の優先順位に従って有効な `sqlite_home` を特定し、その場所の正規の `logs_2.sqlite` データベースを検査します。番号の大きいファイルや旧形式の `logs_N.sqlite` を変更対象に代用することはありません。

Storage 画面には次の情報が表示されます。

- メインデータベース、WAL、SHM のファイルサイズ。
- ログ行の総数と、`TRACE` レベルで保存された割合。
- 行数が多いログターゲット群。ターゲット名の代わりに順位ラベルを使用。
- 後から回収できる可能性がある SQLite フリーリスト領域。
- 観測されたスキーマと、現在既知の Codex ログスキーマとの互換性。

`sqlite_home` が `CODEX_HOME` の外にある場合、診断データベースは別に表示されます。そのバイト数を既存の `CODEX_HOME` ストレージ合計へ黙って含めることはありません。

OpenCodex は診断情報の生成時に `feedback_log_body` を選択・公開しません。ログレベルは既知の固定セットと `OTHER` に限定し、ターゲット名もシリアライズしません。

## Protect のモード

保護は**既定ではオフ**です。有効にすると、OpenCodex が所有する `BEFORE INSERT` トリガーを Codex の正規の `logs_2.sqlite` データベースに 1 つ設置します。予約名を使った未知のトリガーは上書きせず、OpenCodex 所有版と SQL が一致するトリガーだけを削除します。

次の 2 モードを利用できます。

- **Compatibility** (`compat`) は推奨モードです。現行 Codex が永続 SQLite ログの書き込み時に既にフィルタリングまたはレベルを下げている、大量のログを生むターゲットに Log Guard v1 の現行ルールを固定します。無関係な `TRACE` 行は保持します。
- **Quiet** (`quiet`) は新しいすべての `TRACE` 行を抑制し、`DEBUG`、`INFO`、`WARN`、`ERROR` 行は保持します。

保護が減らすのは永続 SQLite ストレージに届く行です。Codex がそれ以前に行うトレース処理は**なくなりません**。トリガーが行を無視する前に、イベントの整形、キューへの追加、トランザクションへのまとめ、Codex 自身の間引き処理での評価が行われる可能性があります。Protect は永続書き込みの負荷を抑える仕組みであり、Codex 内部の診断生成を無効にするスイッチではありません。

Log Guard がフィルタリングするのは、ローカル SQLite に永続化されるログ行だけです。Codex の診断処理、[アダプター転送](/ja/reference/adapters/)、プロバイダーのペイロード、ストリーミングの意味、認証、ルーティング、クォータ、アカウント状態は変更しません。

### 安全性チェック

Protect、Disable、Repair が Codex 側のデータベースを変更する前に、OpenCodex は次を実行します。

1. 正規の `logs_2.sqlite` パスだけを特定する。
2. そのパスがシンボリックリンクではない通常ファイルであり、既知のスキーマに正確に一致することを確認する。
3. プロセス列挙に成功し、対応する Codex 書き込みプロセスが動作していないことを確認する。
4. プロセス間で共有する専用の Log Guard ロックを取得する。
5. ロック取得後に Codex プロセスを再確認する。
6. 作成を伴わない読み書きモードでデータベースを開き、待機せずに SQLite の `BEGIN IMMEDIATE` を取得する。
7. OpenCodex 所有の Log Guard トリガーだけを変更し、コミット前に結果を読み直す。
8. Log Guard ロックを保持している間に、要求されたモードを OpenCodex 設定へ保存する。

プロセス列挙が不確か、データベースがビジー、スキーマが未知、または予約されたトリガー名の SQL が別物なら、変更は安全側で失敗します。OpenCodex が Codex を自動終了することはありません。

## 設定とのずれと Repair

要求された保護モードは Codex のログデータベースとは別の OpenCodex 設定に保存されます。Codex の移行で `logs` テーブルが再構築されると、SQLite は置き換えられたテーブルに付いていたトリガーを削除するため、この区別が重要です。

保存されたモードが `compat` または `quiet` でも、対応する所有トリガーが観測されない場合、Log Guard は **drifted** と報告します。`ocx doctor` はそのずれを報告しますが、自動修復はしません。

修復は明示的に行います。

```bash
ocx storage codex-logs repair
```

OpenCodex は起動するたびに保護を作り直すことはしません。将来のリリースで自動修復を再検討するには、Codex の移行をまたいでも安全であるという十分な運用上の証拠が必要です。

## CLI

状態を読み取ります。

```bash
ocx storage codex-logs status
ocx storage codex-logs status --json
ocx doctor
```

推奨の互換ポリシーを有効にします。

```bash
ocx storage codex-logs protect
```

Quiet モードを明示的に選びます。

```bash
ocx storage codex-logs protect --mode quiet
```

OpenCodex の保護を無効にするか、ずれを修復します。

```bash
ocx storage codex-logs unprotect
ocx storage codex-logs repair
```

機械可読な出力が必要なら Log Guard コマンドに `--json` を追加します。正式なコマンド構文と JSON の挙動は [CLI リファレンス](/ja/reference/cli/)を参照してください。

既存のコマンドは変わりません。

```bash
ocx storage --json
```

応答には Storage ページと同じ Codex ログ状態が含まれます。

## 管理 API

状態は次のエンドポイントで取得できます。

```text
GET /api/storage/codex-logs
```

明示的な変更には次を使います。

```text
POST /api/storage/codex-logs/protect
POST /api/storage/codex-logs/unprotect
POST /api/storage/codex-logs/repair
```

Protect の本文は `{"mode":"compat"}` または `{"mode":"quiet"}` です。`GET /api/storage` もレポートを `codexLogs` として含めるため、ダッシュボードは通常のストレージ内訳と Codex ログ診断を 1 回のスナップショット要求で更新できます。

## 読み取り専用スナップショットの意味

状態の検査では SQLite の `immutable=1` を使ってデータベースを読み取り専用で開きます。これにより、診断目的の読み取りが `-wal` や `-shm` のサイドカーファイルを作成・更新することを防ぎます。

この方式には重要な制約があります。SQL 集計と観測されたトリガーのメタデータが示すのは、最後にチェックポイントされたデータベースのスナップショットです。Codex が書き込み中の場合、現在の WAL には変更不可スナップショットより新しい行やスキーマページが含まれます。変更操作が成功した応答には、OpenCodex が書き込みトランザクション内で確認したトリガー状態が使われますが、その後の読み取り専用状態要求は SQLite がスキーマページをチェックポイントするまで一時的に遅れることがあります。

OpenCodex は WAL ファイルサイズを別途報告しますが、その結果を SSD 書き込み速度、NAND 書き込み量、ドライブの摩耗や TBW 消費とは**表示しません**。

## 互換性の状態

既知のスキーマでは検査と保護が対応済みと報告されます。スキーマが欠けている、読み取れない、または将来の未知の形式である場合、メタデータとしての検査は可能でも、変更を伴う操作には非対応と報告されます。

未知のスキーマを推測で互換扱いにはしません。これにより、新しい Codex バージョンも観測できる一方、未確認のデータベース構造を Log Guard が安全に変更できると誤認することを防ぎます。

## 容量回収は別の段階

Protect は SQLite の VACUUM や圧縮を実行しません。[**Reclaim**](/ja/guides/codex-log-guard-reclaim/) では、チェックポイントと整合性チェックを伴う、明示的でオフラインかつ範囲を限定したインクリメンタル VACUUM を実行できます。

Protect は `VACUUM` を実行せず、Codex の WAL を直接切り詰めたり削除したりせず、定期的な領域回収も行いません。
