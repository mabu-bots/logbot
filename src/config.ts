import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { LogType } from "./logTypes.js";

// ==========================================
// 🗄️ 設定・SQLite ストア
// ==========================================

// ===== 1. 定数 =====
export const DB_FILE_NAME = "logbot.db";

// 💾 起動時バックアップの保持世代数（DB_BACKUP_RETENTION、既定 10 世代。
//    DB_BACKUP_ON_START=false でバックアップ自体を無効化できる）
const BACKUP_RETENTION = Math.max(
  1,
  Number(process.env.DB_BACKUP_RETENTION || 10),
);

// ===== 2. 起動時バックアップと整合性チェック =====

export interface DatabaseIntegrityResult {
  exists: boolean;
  ok: boolean;
  result: string;
}

// 🕐 タイムスタンプ形式（例：20261123T010203Z）
// 📝 バックアップのディレクトリ名が文字列ソートで時系列順に並ぶ
function backupTimestamp(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

// 🔍 DB ファイルの整合性チェック（読み取り専用で開く）
export function integrityCheckDatabaseFile(
  dbPath: string,
): DatabaseIntegrityResult {
  if (!existsSync(dbPath))
    return { exists: false, ok: true, result: "new database" };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    const result = row?.integrity_check ?? "unknown";
    return { exists: true, ok: result === "ok", result };
  } catch (error) {
    return {
      exists: true,
      ok: false,
      result: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

// 💾 書き込み用に開く前に DB を backups/<タイムスタンプ>/ へコピーする
// 📝 WAL を先にチェックポイントしてコピーを自己完結させる。
//    チェックポイントに失敗した場合は -wal / -shm のサイドカーも一緒にコピーする。
export function backupDatabaseFile(
  dbPath: string,
  backupDir: string,
  timestamp: string,
): string | null {
  if (!existsSync(dbPath)) return null;

  const directory = join(backupDir, timestamp);
  mkdirSync(directory, { recursive: true });

  let checkpointed = false;
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      checkpointed = true;
    } finally {
      db.close();
    }
  } catch (error) {
    console.warn(
      `logbot.db WAL checkpoint failed; backing up sidecar files as-is: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const destination = join(directory, DB_FILE_NAME);
  copyFileSync(dbPath, destination);
  if (!checkpointed) {
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${destination}${suffix}`);
    }
  }
  return destination;
}

// 🧹 古いバックアップ世代を削除する（保持世代数を超えた分だけ）
export function pruneDatabaseBackups(
  backupDir: string,
  retention: number,
): void {
  if (!existsSync(backupDir)) return;
  const dirs = readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const dir of dirs.slice(retention)) {
    rmSync(join(backupDir, dir), { recursive: true, force: true });
  }
}

// ===== 3. 行の型 =====

export interface VoiceSessionRow {
  guild_id: string;
  user_id: string;
  channel_id: string;
  joined_at_ms: number;
  estimated: number;
}

export interface VoiceChannelSessionRow {
  guild_id: string;
  channel_id: string;
  started_at_ms: number;
  estimated: number;
}

// ===== 4. ストア本体 =====

// 🗄️ サーバーごと・ログ種別ごとの通知先チャンネル
// 📝 SQLite（Node 標準の node:sqlite、ネイティブ依存なし）に保存する。
//    Schema: log_channels(guild_id, log_type, channel_id, updated_at)
//    未設定＝そのサーバーではそのログ種別は無効。全体の既定チャンネルは無く、
//    種別ごとに独立してオン／オフを切り替える設計。
export class LogConfigStore {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private closed = false;
  private transactionDepth = 0;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, DB_FILE_NAME);
    this.backupAndCheckOnStart(dataDir, dbPath);
    this.db = new DatabaseSync(dbPath);
    // 📝 WAL＋NORMAL 同期：VC セッションの書き込みは参加・退出・移動のたびにあり、
    //    読み取りは全ログイベントのたびにある。WAL なら読み書きが互いに
    //    阻害せず、書き込みごとの完全 fsync も避けられる。このデータには
    //    妥当なトレードオフ（最悪、クラッシュで失うのは起動時照合で
    //    復旧できる直近のセッション行だけ）。busy_timeout は短いロック
    //    （手動の sqlite3 確認など）を例外にせず待たせる。
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS log_channels (
        guild_id TEXT NOT NULL,
        log_type TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, log_type)
      );
      -- Bot 全体の設定（サーバー単位ではない）。例：/watching で設定する watching_text。
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- 進行中の VC セッション（通話時間の計測用）。
      -- joined_at_ms は壁時計の時刻のため、Bot が再起動してもセッションは
      -- 継続し、通話時間（退出 − 参加）は正確なままになる。
      -- estimated = 1 は Bot が参加自体を見ていない場合（Bot 起動時に
      -- 既に VC にいた人）。タイマーは Bot 起動時から始まるため、
      -- 実際の通話時間は計測値より長い。
      CREATE TABLE IF NOT EXISTS voice_sessions (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        joined_at_ms INTEGER NOT NULL,
        estimated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      );
      -- 進行中の VC チャンネルセッション（チャンネル単位の通話時間用）。
      -- 最初の人が空のチャンネルに参加したときに始まり、最後の人が
      -- 退出したときに終わる。壁時計・推定の規則は voice_sessions と同じ。
      CREATE TABLE IF NOT EXISTS voice_channel_sessions (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        estimated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, channel_id)
      )
    `);
    // 🔍 起動後の整合性チェック：破損はここで大きく失敗させる。
    //    後から設定の消失として表に出るより良い。
    const after = this.db.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    const afterResult = after?.integrity_check ?? "unknown";
    if (afterResult !== "ok") {
      this.db.close();
      throw new Error(
        `SQLite integrity check failed after startup: logbot.db=${afterResult}`,
      );
    }
  }

  // 💾 起動時バックアップ＋整合性チェック
  // 📝 開く前に前回の DB ファイルをバックアップ（世代整理付き）し、破損ファイルでは
  //    起動を拒否する。バックアップはその時点で保存済みのため、停止しても何も失わない。
  //    DB_BACKUP_ON_START=false でバックアップを省略する（整合性チェックは行う）。
  private backupAndCheckOnStart(dataDir: string, dbPath: string): void {
    const backupDir = join(dataDir, "backups");
    const shouldBackup =
      String(process.env.DB_BACKUP_ON_START ?? "true").toLowerCase() !==
      "false";
    if (shouldBackup) {
      const saved = backupDatabaseFile(dbPath, backupDir, backupTimestamp());
      if (saved) console.log(`Database backup saved: ${saved}`);
      pruneDatabaseBackups(backupDir, BACKUP_RETENTION);
    }
    const before = integrityCheckDatabaseFile(dbPath);
    if (before.exists && !before.ok) {
      throw new Error(
        `SQLite integrity check failed: logbot.db=${before.result}. The startup backup was saved under ${backupDir}.`,
      );
    }
  }

  // ⚡ プリペアドステートメントをキャッシュして再利用する
  // 📝 全ログイベントと VC 変化がここを通るため、毎回 SQL を再準備するのは
  //    解析の無駄になる。StatementSync は引数を変えて再利用できる。
  private prepare(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  // 🔁 fn を1つのトランザクションで実行する
  // 📝 一括照合（VC の起動時シード）用で、行ごとにコミットするのを防ぐ。
  //    ネスト呼び出しは BEGIN-in-BEGIN で失敗せず外側のトランザクションに参加する。
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  // ----- 4.1 VC チャンネルセッション -----

  // 📞 VC チャンネルセッションを1件取得する
  getVoiceChannelSession(
    guildId: string,
    channelId: string,
  ): VoiceChannelSessionRow | null {
    const row = this.prepare(
      "SELECT guild_id, channel_id, started_at_ms, estimated FROM voice_channel_sessions WHERE guild_id = ? AND channel_id = ?",
    ).get(guildId, channelId) as VoiceChannelSessionRow | undefined;
    return row ?? null;
  }

  // 📞 VC チャンネルセッションを全件取得する（開始時刻順）
  listVoiceChannelSessions(guildId: string): VoiceChannelSessionRow[] {
    return this.prepare(
      "SELECT guild_id, channel_id, started_at_ms, estimated FROM voice_channel_sessions WHERE guild_id = ? ORDER BY started_at_ms",
    ).all(guildId) as unknown as VoiceChannelSessionRow[];
  }

  // 📞 VC チャンネルセッションを保存する（無ければ追加、あれば更新）
  setVoiceChannelSession(session: VoiceChannelSessionRow): void {
    this.prepare(
      `INSERT INTO voice_channel_sessions (guild_id, channel_id, started_at_ms, estimated)
         VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, channel_id)
         DO UPDATE SET started_at_ms = excluded.started_at_ms, estimated = excluded.estimated`,
    ).run(
      session.guild_id,
      session.channel_id,
      session.started_at_ms,
      session.estimated,
    );
  }

  // 📞 VC チャンネルセッションを削除する
  deleteVoiceChannelSession(guildId: string, channelId: string): void {
    this.prepare(
      "DELETE FROM voice_channel_sessions WHERE guild_id = ? AND channel_id = ?",
    ).run(guildId, channelId);
  }

  // ----- 4.2 VC セッション -----

  // 🎙️ VC セッションを1件取得する
  getVoiceSession(guildId: string, userId: string): VoiceSessionRow | null {
    const row = this.prepare(
      "SELECT guild_id, user_id, channel_id, joined_at_ms, estimated FROM voice_sessions WHERE guild_id = ? AND user_id = ?",
    ).get(guildId, userId) as VoiceSessionRow | undefined;
    return row ?? null;
  }

  // 🎙️ VC セッションを全件取得する（参加時刻順）
  listVoiceSessions(guildId: string): VoiceSessionRow[] {
    return this.prepare(
      "SELECT guild_id, user_id, channel_id, joined_at_ms, estimated FROM voice_sessions WHERE guild_id = ? ORDER BY joined_at_ms",
    ).all(guildId) as unknown as VoiceSessionRow[];
  }

  // 🎙️ VC セッションを保存する（無ければ追加、あれば更新）
  setVoiceSession(session: VoiceSessionRow): void {
    this.prepare(
      `INSERT INTO voice_sessions (guild_id, user_id, channel_id, joined_at_ms, estimated)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id)
         DO UPDATE SET channel_id = excluded.channel_id, joined_at_ms = excluded.joined_at_ms, estimated = excluded.estimated`,
    ).run(
      session.guild_id,
      session.user_id,
      session.channel_id,
      session.joined_at_ms,
      session.estimated,
    );
  }

  // 🎙️ VC セッションを削除する
  deleteVoiceSession(guildId: string, userId: string): void {
    this.prepare(
      "DELETE FROM voice_sessions WHERE guild_id = ? AND user_id = ?",
    ).run(guildId, userId);
  }

  // ----- 4.3 Bot 全体設定 -----

  // ⚙️ Bot 全体設定を1件取得する
  getSetting(key: string): string | null {
    const row = this.prepare("SELECT value FROM settings WHERE key = ?").get(
      key,
    ) as { value: string } | undefined;
    return row?.value ?? null;
  }

  // ⚙️ Bot 全体設定を保存する（無ければ追加、あれば更新）
  setSetting(key: string, value: string): void {
    this.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, new Date().toISOString());
  }

  // ⚙️ Bot 全体設定を削除する
  deleteSetting(key: string): void {
    this.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  // ----- 4.4 ログ通知先 -----

  // 📋 ログ種別の通知先チャンネルを1件取得する
  get(guildId: string, logType: LogType): string | null {
    const row = this.prepare(
      "SELECT channel_id FROM log_channels WHERE guild_id = ? AND log_type = ?",
    ).get(guildId, logType) as { channel_id: string } | undefined;
    return row?.channel_id ?? null;
  }

  // 📋 ログ種別の通知先を全件取得する
  getAll(guildId: string): Map<LogType, string> {
    const rows = this.prepare(
      "SELECT log_type, channel_id FROM log_channels WHERE guild_id = ?",
    ).all(guildId) as unknown as Array<{
      log_type: LogType;
      channel_id: string;
    }>;
    return new Map(rows.map((r) => [r.log_type, r.channel_id]));
  }

  // 📋 ログ種別の通知先を設定する（無ければ追加、あれば更新）
  set(guildId: string, logType: LogType, channelId: string): void {
    this.prepare(
      `INSERT INTO log_channels (guild_id, log_type, channel_id, updated_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, log_type)
         DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
    ).run(guildId, logType, channelId, new Date().toISOString());
  }

  // 📋 ログ種別の通知先を削除する（通知を止める）
  delete(guildId: string, logType: LogType): void {
    this.prepare(
      "DELETE FROM log_channels WHERE guild_id = ? AND log_type = ?",
    ).run(guildId, logType);
  }

  // ----- 4.5 終了 -----

  // 🚪 DB を閉じる（冪等にする）
  // 📝 シグナルハンドラ（SIGINT＋SIGTERM）と終了処理が競合しうるうえ、
  //    DatabaseSync.close() は2回呼ぶと例外になるため。
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}
