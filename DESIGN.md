# DESIGN — logbot 再実装の設計記録

v1.0.0（2026-11-28）の再実装における、旧実装（v0.1.2）から新実装への対応と判断を記録する。

## 1. 棚卸しの正

- 棚卸しの正は GitHub ではなく、**本番サーバー（台3 minase）から取得したスナップショット**（2026-11-28 取得）。サーバー側コードが GitHub より進んでいる前例（mabubot）があるため。
- スナップショットには `.env` と `data/` は含まれない。データ保存形式はコードから読み取った。
- 旧バージョンのベースラインとして、スナップショットをそのままビルドしてテストを実行した：**50 pass / 1 fail**。失敗した1件は旧テスト自体の陳腐化（後述の判断記録 #4）で、本番コードの不具合ではない。

## 2. 旧→新対応表

| 旧（v0.1.2、`discord-log-bot`） | 新（v1.0.0、`logbot`） | 備考 |
|---|---|---|
| `src/index.ts`（dist 直下に出力） | `src/index.ts`（`dist/src/index.js`） | 構成は fleet 標準（mabubot）に統一 |
| `src/commands.ts` | `src/commands.ts` | コマンド定義 JSON は旧と機械比較で完全一致 |
| `src/events.ts` | `src/events.ts` | 全ハンドラとガード条件を再現 |
| `src/config.ts` | `src/config.ts` | DB スキーマ4表は旧と機械比較で完全一致 |
| `src/voiceSessions.ts` | `src/voiceSessions.ts` | `seedAll` を含む全 API を再現 |
| `src/logTypes.ts` | `src/logTypes.ts` | 12種別のラベル・絵文字・色を再現 |
| `src/sendLog.ts` | `src/sendLog.ts` | 書記素単位の切り詰め等を再現 |
| `src/presence-cycle.ts` | `src/presence-cycle.ts` | 全Bot統一サイクルを再現 |
| `src/watchdog.ts` | `src/watchdog.ts` | READY ウォッチドッグを再現 |
| `src/execLog.ts` | `src/execLog.ts` | `[exec]` 1行形式を再現 |
| `src/sync-commands.ts` | `src/sync-commands.ts` | GET→PUT→GET 検証、追加・削除の報告を再現 |
| `src/clear-commands.ts` | `src/clear-commands.ts` | スコープごとの削除前後検証を再現 |
| `src/test/*.test.ts`（8ファイル・51件） | `tests/*.test.ts`（8ファイル・51件）＋ `tests/presence-cycle.test.ts`（6件） | 配置を fleet 標準（ルート `tests/`）へ移行。合計57件 |
| `ecosystem.config.cjs`（script: `dist/index.js`） | `ecosystem.config.cjs`（script: `dist/src/index.js`） | pm2 アプリ名 `logbot` は据え置き |
| （なし） | `build.sh` / `build.bat`、`scripts/format.sh` / `format.ps1`、`docs/ci.md` | fleet 標準の雛形を追加 |
| discord.js `14.28.1`（厳密固定） | discord.js `^14.28.1` | fleet 標準に合わせて範囲指定へ |
| @types/node 24.10.0 / tsx 4.20.6 / typescript 5.9.3 | @types/node 26.6.6 / tsx 4.23.15 / typescript 7.0.2 / prettier 3.10.1 | fleet 標準のツールチェーンに更新 |

## 3. 再現した機能（棚卸し一覧）

- コマンド4件（グローバル）：`/log`（set/disable/list、ManageGuild 必須・実行時再確認、set 時の Bot 権限不足警告）、`/watching`（set/show/reset、ManageGuild＋ギルド内必須、空白文言の拒否）、`/vc`（list は公開返信・誰でも可、time は誰でも可、set は ManageGuild 必須で必須オプション `time` を先に配置）、`/ping`
- ログ種別12種と各種別ガード条件（partial 除外、Bot 除外、内容同一の編集除外、BAN 理由は監査ログの対象一致エントリからのみ取得 等）
- VC セッション計測（個人・チャンネル、SQLite 永続化、再起動跨ぎ、起動時照合 `seedGuild`/`seedAll`、推定フラグ、手動補正 `parseManualTime` の全形式）
- 設定ストア（`data/logbot.db`、WAL、prepared statement キャッシュ、ネスト可能な `transaction()`、冪等な `close()`、起動時バックアップ＋世代管理、開く前後の整合性チェック）
- ログ送信（書記素安全な切り詰め、フィールド名絵文字、キャッシュ優先のチャンネル解決、送信不能時の警告ログ）
- プレゼンス・サイクル（Playing、1分交互、Unix 分の偶奇位相、境界200ms前先行送信）
- READY ウォッチドッグ（120秒/30秒、pm2 再起動に委ねる）
- コマンド実行ログ（`[exec]` 1行形式、ユーザー入力は記録しない）
- コマンド同期・削除ツール（上書き同期＋検証、スコープ削除＋検証）
- エラー応答（replied/deferred/未返信で followUp/editReply/reply を使い分け、埋め込み形式）

## 4. 判断記録

1. **パッケージ名の変更**：`discord-log-bot` → `logbot`（リポジトリ名に一致）。pm2 アプリ名と DB ファイル名は運用互換のため変更しない。
2. **レイアウトの fleet 標準化**：テストを `src/test/` からルート `tests/` へ、成果物を `dist/` フラットから `dist/src/` + `dist/tests/` へ移行（mabubot 標準）。これに伴い `ecosystem.config.cjs` の script パスを変更した。
3. **dotenv を入れない**：旧実装は dotenv 依存を持たず、pm2 の ecosystem が `.env` を読んで環境変数を渡す方式だった。再実装でもこの方式を維持した（当初ドラフトで入れた dotenv 読み込みは棚卸しとの照合で除去）。
4. **旧テスト1件の期待値修正**：`/watching set with ManageGuild applies and persists` が統一前のプレゼンス形式 `/help | 42ms` を期待していたが、本番コードはプレゼンス・サイクル形式を適用するため、スナップショットのベースライン実行でも失敗していた（50 pass / 1 fail）。本番コードを正とし、期待値をサイクル形式（`ログボット | 起動して N分` または `ログボット | 現在時刻 HH:MM JST`）に修正した。フェイククライアントには `user.username` を追加した。
5. **`LOG_LEVEL` の扱い**：旧実装でも文書にのみ存在しコードから未参照だった。削除せず、未参照であることを README に明記して残した。
6. **バージョンの振り直し**：旧 v0.1.2 から v1.0.0 に振り直した（再実装の節目のため）。
7. **CI の集約**：旧リポジトリにあった CI 以外の自動化は持ち込まず、`ci.yml` 1本（format:check → typecheck → build → test → audit 参考）に集約した（fleet 標準）。

## 5. 未再現・変更したもの

- なし（機能の削減は行っていない）。上記のレイアウト変更と依存バージョン更新のみが差分。
