import type { Client, Guild } from "discord.js";
import type {
  LogConfigStore,
  VoiceChannelSessionRow,
  VoiceSessionRow,
} from "./config.js";

// ==========================================
// 🎙️ VC セッション・通話時間の管理
// ==========================================

// ===== 1. セッションの型 =====

export interface VoiceSession {
  guildId: string;
  userId: string;
  channelId: string;
  joinedAtMs: number;
  estimated: boolean;
}

export interface VoiceChannelSession {
  guildId: string;
  channelId: string;
  startedAtMs: number;
  estimated: boolean;
}

// ===== 2. 表示整形 =====

// ⏱️ ミリ秒を「○日○時間○分○秒」形式にする
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}日`);
  if (hours) parts.push(`${hours}時間`);
  if (minutes) parts.push(`${minutes}分`);
  // ⏱️ 秒は常に表示する。ただし上位の単位でちょうど割り切れる場合は除く。
  if (seconds || !parts.length) parts.push(`${seconds}秒`);
  return parts.join("");
}

// 🕐 Discord の日時表示（フル形式）を作る
export function discordTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

// 🕐 Discord の日時表示（短い時刻形式）を作る（見る人のタイムゾーンで表示される）
export function shortTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:t>`;
}

// ===== 3. 手動時刻の解析（/vc set 用） =====

// ⏱️ /vc set 用の手動時刻の解析（全て日本時間・JST）
//
// 📝 受け付ける形式：
//    - 相対：`90分前`、`2時間前`、`1時間30分前`、`3日前`
//    - 当日の時刻：`17:00`、`17:00:30`（未来なら前日とみなす）
//    - 日付と時刻：`2026-11-14 17:00`、`2026/11/14 17:00`、`11-14 17:00`
//    - ISO 8601：`2026-11-14T17:00:00+09:00`
// 📝 エポックミリ秒を返す。入力が使えない・未来・30日より前の場合は null。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // 🕐 JST は UTC+9 時間
const MAX_MANUAL_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 📅 手動指定できるのは過去 30 日まで

// 🕐 エポックミリ秒を JST の年月日時分秒に分解する
function jstParts(ms: number): {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
} {
  const date = new Date(ms + JST_OFFSET_MS);
  return {
    y: date.getUTCFullYear(),
    mo: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    h: date.getUTCHours(),
    mi: date.getUTCMinutes(),
    s: date.getUTCSeconds(),
  };
}

// 🕐 JST の年月日時分秒をエポックミリ秒に変換する（存在しない日時は null）
function jstToMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s = 0,
): number | null {
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > 31 ||
    h < 0 ||
    h > 23 ||
    mi < 0 ||
    mi > 59 ||
    s < 0 ||
    s > 59
  )
    return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) - JST_OFFSET_MS;
  const back = jstParts(ms);
  if (
    back.y !== y ||
    back.mo !== mo ||
    back.d !== d ||
    back.h !== h ||
    back.mi !== mi ||
    back.s !== s
  )
    return null;
  return ms;
}

// ⏱️ /vc set 用の時刻文字列を解析する（日本時間）
export function parseManualTime(
  input: string,
  now = Date.now(),
): number | null {
  const text = input
    .trim()
    .replace(/[０-９]/g, (c) => String("０１２３４５６７８９".indexOf(c)))
    .replace(/　/g, " ");
  if (!text) return null;

  // ⏱️ 相対指定（`2時間30分前`・`90分前`・`3日前`）
  const relative = text.match(/^(.+?)前$/);
  if (relative) {
    const body = relative[1];
    const days = body.match(/(\d+(?:\.\d+)?)\s*日/);
    const hours = body.match(/(\d+(?:\.\d+)?)\s*時間/);
    const minutes = body.match(/(\d+(?:\.\d+)?)\s*分/);
    const seconds = body.match(/(\d+(?:\.\d+)?)\s*秒/);
    if (!days && !hours && !minutes && !seconds) return null;
    // ⚠️ 厳密な消費チェック：`<数値><単位>` の部分を全て取り除いた後に
    //    空白以外が残ってはいけない。これが無いと `1時間xyz分前` のような入力が
    //    「1時間前」として黙って受理され、読めない部分が捨てられてしまう。
    const rest = body
      .replace(/(\d+(?:\.\d+)?)\s*日/g, "")
      .replace(/(\d+(?:\.\d+)?)\s*時間/g, "")
      .replace(/(\d+(?:\.\d+)?)\s*分/g, "")
      .replace(/(\d+(?:\.\d+)?)\s*秒/g, "")
      .trim();
    if (rest) return null;
    const deltaMs =
      (days ? Number(days[1]) * 86400000 : 0) +
      (hours ? Number(hours[1]) * 3600000 : 0) +
      (minutes ? Number(minutes[1]) * 60000 : 0) +
      (seconds ? Number(seconds[1]) * 1000 : 0);
    if (!deltaMs) return null;
    const ms = now - deltaMs;
    return now - ms <= MAX_MANUAL_AGE_MS ? ms : null;
  }

  let ms: number | null = null;
  // 📅 `2026-11-14 17:00` / `2026/11/14 17:00:30` 形式
  const dated = text.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (dated) {
    ms = jstToMs(
      Number(dated[1]),
      Number(dated[2]),
      Number(dated[3]),
      Number(dated[4]),
      Number(dated[5]),
      Number(dated[6] ?? 0),
    );
  } else {
    // 📅 `11-14 17:00` 形式（今年・日本時間）
    const monthDay = text.match(
      /^(\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (monthDay) {
      ms = jstToMs(
        jstParts(now).y,
        Number(monthDay[1]),
        Number(monthDay[2]),
        Number(monthDay[3]),
        Number(monthDay[4]),
        Number(monthDay[5] ?? 0),
      );
      // 📅 年末年始の配慮：今年の「未来」の月日は、ほぼ確実に去年の年末を指す
      //    （例：1月に `12-31 17:00` と打つのは大晦日の通話のため）。
      //    時刻のみの形式は同じ場面で1日戻すため、ここでは1年戻す。
      //    30日制限のチェックは後で行うため、去年の日付が古すぎれば却下される。
      if (ms !== null && ms > now) {
        ms = jstToMs(
          jstParts(now).y - 1,
          Number(monthDay[1]),
          Number(monthDay[2]),
          Number(monthDay[3]),
          Number(monthDay[4]),
          Number(monthDay[5] ?? 0),
        );
      }
    } else {
      // 🕐 `17:00` 形式（当日・日本時間。未来なら前日）
      const timeOnly = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (timeOnly) {
        const today = jstParts(now);
        ms = jstToMs(
          today.y,
          today.mo,
          today.d,
          Number(timeOnly[1]),
          Number(timeOnly[2]),
          Number(timeOnly[3] ?? 0),
        );
        if (ms !== null && ms > now) ms -= 86400000; // 🕐 未来なら1日分戻す
      } else if (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(
          text,
        )
      ) {
        // 🕐 ISO 8601（オフセット付き。例：`2026-11-14T17:00:00+09:00`）
        // 📝 この形だけ Date.parse に渡す。素の Date.parse フォールバックは
        //    日付のみの文字列（`2026-01-14` は UTC 0時と読まれる）や
        //    サーバーのタイムゾーン依存の書式も受理してしまい、
        //    管理者の意図と違う時刻を黙って作ってしまうため。
        const parsed = Date.parse(text);
        ms = Number.isNaN(parsed) ? null : parsed;
      }
    }
  }
  if (ms === null || ms > now || now - ms > MAX_MANUAL_AGE_MS) return null;
  return ms;
}

// ===== 4. 行との変換 =====

// 🔄 DB 行をユーザーセッションに変換する
function fromRow(row: VoiceSessionRow): VoiceSession {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    channelId: row.channel_id,
    joinedAtMs: row.joined_at_ms,
    estimated: row.estimated === 1,
  };
}

// 🔄 ユーザーセッションを DB 行に変換する
function toRow(session: VoiceSession): VoiceSessionRow {
  return {
    guild_id: session.guildId,
    user_id: session.userId,
    channel_id: session.channelId,
    joined_at_ms: session.joinedAtMs,
    estimated: session.estimated ? 1 : 0,
  };
}

// 🔄 DB 行をチャンネルセッションに変換する
function channelFromRow(row: VoiceChannelSessionRow): VoiceChannelSession {
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    startedAtMs: row.started_at_ms,
    estimated: row.estimated === 1,
  };
}

// 🔄 チャンネルセッションを DB 行に変換する
function channelToRow(session: VoiceChannelSession): VoiceChannelSessionRow {
  return {
    guild_id: session.guildId,
    channel_id: session.channelId,
    started_at_ms: session.startedAtMs,
    estimated: session.estimated ? 1 : 0,
  };
}

// ===== 5. トラッカー本体 =====

// 🎙️ 進行中の VC セッションを追跡し、通話時間を正確に測る
//
// 📝 - 参加は壁時計の時刻で記録して SQLite に保存するため、Bot の再起動で
//      タイマーがリセットされない。通話時間＝退出時刻−参加時刻。
//    - チャンネル間の移動では元の参加時刻を維持し、チャンネルのみ更新する。
//      合計時間は1つの連続したセッションとして扱う。
//    - 起動時に既に VC にいる人は参加時刻の記録が無い（Discord は
//      ボイス状態の開始時刻を出さない）。タイマーは Bot 起動時から始まり
//      推定扱いになる。退出ログでその旨を伝える。
export class VoiceSessionTracker {
  // 👥 チャンネルごとの在室者（通話の開始・終了の判定用）
  // 📝 セッションの開始時刻自体は保存済みのため、再起動でチャンネルタイマーはリセットされない。
  private channelMembers = new Map<string, Set<string>>();

  constructor(private store: LogConfigStore) {}

  // 🔑 チャンネル識別キー（guild:channel）を作る
  private channelKey(guildId: string, channelId: string): string {
    return `${guildId}:${channelId}`;
  }

  // ----- 5.1 チャンネルセッション -----

  // 📞 VC チャンネルセッションを1件取得する
  channelGet(guildId: string, channelId: string): VoiceChannelSession | null {
    const row = this.store.getVoiceChannelSession(guildId, channelId);
    return row ? channelFromRow(row) : null;
  }

  // 📞 VC チャンネルセッションを全件取得する
  channelList(guildId: string): VoiceChannelSession[] {
    return this.store.listVoiceChannelSessions(guildId).map(channelFromRow);
  }

  // ⏱️ チャンネル通話の経過時間を計算する
  channelElapsed(session: VoiceChannelSession, now = Date.now()): number {
    return Math.max(0, now - session.startedAtMs);
  }

  // 🎙️ ユーザーがチャンネルに参加したときの処理
  // 📝 チャンネルセッションと、それが新規通話の開始（開始前は空だった）かを返す。
  channelJoin(
    guildId: string,
    channelId: string,
    userId: string,
    now = Date.now(),
    estimated = false,
  ): { session: VoiceChannelSession; isNew: boolean } {
    const key = this.channelKey(guildId, channelId);
    let members = this.channelMembers.get(key);
    if (!members) {
      members = new Set();
      this.channelMembers.set(key, members);
    }
    members.add(userId);
    // 📝 保存済みセッションが無いときだけ新規通話を開始する。
    //    再起動でチャンネルタイマーをリセットしてはいけないため、
    //    メモリ上の在室者が空でも保存済みの開始時刻を維持する。
    const existing = this.channelGet(guildId, channelId);
    if (!existing) {
      const session: VoiceChannelSession = {
        guildId,
        channelId,
        startedAtMs: now,
        estimated,
      };
      this.store.setVoiceChannelSession(channelToRow(session));
      return { session, isNew: true };
    }
    return { session: existing, isNew: false };
  }

  // 🚪 ユーザーがチャンネルから退出したときの処理
  // 📝 最後の1人だった場合は終了したチャンネルセッション（合計時間付き）を返し、
  //    それ以外は継続中のチャンネル通話の経過時間を返す。
  channelLeave(
    guildId: string,
    channelId: string,
    userId: string,
    now = Date.now(),
  ): {
    ended: { session: VoiceChannelSession; durationMs: number } | null;
    elapsedMs: number | null;
  } {
    const key = this.channelKey(guildId, channelId);
    this.channelMembers.get(key)?.delete(userId);
    const remaining = this.channelMembers.get(key)?.size ?? 0;
    const session = this.channelGet(guildId, channelId);
    if (!session) return { ended: null, elapsedMs: null };
    if (remaining > 0) {
      return { ended: null, elapsedMs: Math.max(0, now - session.startedAtMs) };
    }
    this.store.deleteVoiceChannelSession(guildId, channelId);
    this.channelMembers.delete(key);
    return {
      ended: { session, durationMs: Math.max(0, now - session.startedAtMs) },
      elapsedMs: null,
    };
  }

  // ----- 5.2 ユーザーセッション -----

  // 🎙️ ユーザーの VC セッションを1件取得する
  get(guildId: string, userId: string): VoiceSession | null {
    const row = this.store.getVoiceSession(guildId, userId);
    return row ? fromRow(row) : null;
  }

  // 🎙️ ユーザーの VC セッションを全件取得する
  list(guildId: string): VoiceSession[] {
    return this.store.listVoiceSessions(guildId).map(fromRow);
  }

  // 🎙️ VC セッションを開始する（参加時刻を記録して保存する）
  start(
    guildId: string,
    userId: string,
    channelId: string,
    now = Date.now(),
    estimated = false,
  ): VoiceSession {
    const session: VoiceSession = {
      guildId,
      userId,
      channelId,
      joinedAtMs: now,
      estimated,
    };
    this.store.setVoiceSession(toRow(session));
    return session;
  }

  // 🔀 ユーザーがチャンネル間を移動したときの処理（元の参加時刻を維持する）
  move(
    guildId: string,
    userId: string,
    channelId: string,
    now = Date.now(),
  ): VoiceSession | null {
    const existing = this.get(guildId, userId);
    if (!existing) {
      // ⚠️ 参加が観測できなかった場合（Bot 起動中の通話で照合漏れなど）：
      //    セッションを失うより、今から推定タイマーを開始する。
      return this.start(guildId, userId, channelId, now, true);
    }
    const moved: VoiceSession = { ...existing, channelId };
    this.store.setVoiceSession(toRow(moved));
    return moved;
  }

  // 🚪 VC セッションを終了し、通話時間を返す
  end(
    guildId: string,
    userId: string,
    now = Date.now(),
  ): { session: VoiceSession; durationMs: number } | null {
    const existing = this.get(guildId, userId);
    if (!existing) return null;
    this.store.deleteVoiceSession(guildId, userId);
    return {
      session: existing,
      durationMs: Math.max(0, now - existing.joinedAtMs),
    };
  }

  // ⏱️ VC セッションの経過時間を計算する
  elapsed(session: VoiceSession, now = Date.now()): number {
    return Math.max(0, now - session.joinedAtMs);
  }

  // ----- 5.3 手動補正（/vc set） -----

  // ⏱️ 参加時刻を手動で補正する
  // 📝 セッションは既に存在することが条件。通話中の人・チャンネルのみ補正できる。
  //    手動補正すると推定フラグが外れる：ユーザーが真の時刻を入れたため、
  //    タイマーはもう推定ではない。補正時刻は保存するため再起動しても残る。
  setJoinTime(
    guildId: string,
    userId: string,
    joinedAtMs: number,
  ): VoiceSession | null {
    const existing = this.get(guildId, userId);
    if (!existing) return null;
    const corrected: VoiceSession = {
      ...existing,
      joinedAtMs,
      estimated: false,
    };
    this.store.setVoiceSession(toRow(corrected));
    return corrected;
  }

  // ⏱️ チャンネル通話の開始時刻を手動で補正する
  setChannelStart(
    guildId: string,
    channelId: string,
    startedAtMs: number,
  ): VoiceChannelSession | null {
    const existing = this.channelGet(guildId, channelId);
    if (!existing) return null;
    const corrected: VoiceChannelSession = {
      ...existing,
      startedAtMs,
      estimated: false,
    };
    this.store.setVoiceChannelSession(channelToRow(corrected));
    return corrected;
  }

  // ----- 5.4 起動時照合 -----

  // 🌱 全サーバーの VC セッションを照合する
  seedAll(client: Client, now = Date.now()): void {
    for (const guild of client.guilds.cache.values())
      this.seedGuild(guild, now);
  }

  // 🌱 保存済みセッションと現在の VC 在室状況を照合する
  // 📝 ready 時に1回、サーバーが利用可能になったときにそのサーバー分だけ呼ぶ。
  seedGuild(guild: Guild, now = Date.now()): void {
    // 🔁 照合全体を1つの作業単位にする：トランザクションで囲み、行ごとの fsync を1回にまとめる。
    this.store.transaction(() => this.seedGuildInner(guild, now));
  }

  private seedGuildInner(guild: Guild, now: number): void {
    const present = new Set<string>();
    const presentChannels = new Set<string>();
    // 🔄 このサーバー分のメモリ上の在室状況を最初から作り直す。
    //    ここで追加しかしないと、同じサーバーで seedGuild が再実行された場合
    //    （障害後の復旧で guildCreate が再発火するなど）、その間に退出した人が
    //    在室集合に残り続け、そのチャンネルの通話は channelLeave が
    //    「残っている人」を見続けて永遠に終わらなくなる。
    for (const key of [...this.channelMembers.keys()]) {
      if (key.startsWith(`${guild.id}:`)) this.channelMembers.delete(key);
    }
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId || !state.member || state.member.user.bot) continue;
      present.add(state.member.id);
      presentChannels.add(state.channelId);
      const existing = this.get(guild.id, state.member.id);
      if (!existing) {
        this.start(guild.id, state.member.id, state.channelId, now, true);
      } else if (existing.channelId !== state.channelId) {
        this.store.setVoiceSession(
          toRow({ ...existing, channelId: state.channelId }),
        );
      }
      // 🔄 実際にここにいる人から在室状況とチャンネルセッションを作り直す。
      //    保存済みのチャンネルセッションがあれば維持する（再起動でチャンネル
      //    タイマーをリセットしない）。無い場合だけ推定セッションを開始する。
      const key = this.channelKey(guild.id, state.channelId);
      let members = this.channelMembers.get(key);
      if (!members) {
        members = new Set();
        this.channelMembers.set(key, members);
      }
      members.add(state.member.id);
      if (!this.channelGet(guild.id, state.channelId)) {
        this.store.setVoiceChannelSession(
          channelToRow({
            guildId: guild.id,
            channelId: state.channelId,
            startedAtMs: now,
            estimated: true,
          }),
        );
      }
    }
    // 🧹 Bot 停止中に退出した人は退出イベントが無いため、記録された通話時間が
    //    誤ったものになる。古いセッションは黙って捨てる。
    for (const session of this.list(guild.id)) {
      if (!present.has(session.userId))
        this.store.deleteVoiceSession(guild.id, session.userId);
    }
    for (const channelSession of this.channelList(guild.id)) {
      if (!presentChannels.has(channelSession.channelId)) {
        this.store.deleteVoiceChannelSession(
          guild.id,
          channelSession.channelId,
        );
        this.channelMembers.delete(
          this.channelKey(guild.id, channelSession.channelId),
        );
      }
    }
  }
}
