// ==========================================
// 🏷️ ログ種別の一覧と表示名
// ==========================================
//
// 📝 ログ種別ごとに通知先チャンネルをサーバー単位で設定する。
//    管理者が同じチャンネルを2回指定しない限り、種別間で通知先は共有されない。
// 📝 `voice` は参加・退出・移動のみ。ミュート・デフ・配信の変化は
//    `voice_state` に分け、うるさい状態変化だけ別送り・無効化できるようにする。

// ===== 1. 種別の一覧 =====
export const LOG_TYPES = [
  "message_edit",
  "message_delete",
  "member_join",
  "member_leave",
  "role_update",
  "channel_create",
  "channel_update",
  "channel_delete",
  "voice",
  "voice_state",
  "member_ban",
  "member_unban",
] as const;

export type LogType = (typeof LOG_TYPES)[number];

// ===== 2. 表示名・絵文字・色 =====

// 🏷️ ログ種別の日本語名
export const LOG_TYPE_LABELS: Record<LogType, string> = {
  message_edit: "メッセージ編集",
  message_delete: "メッセージ削除",
  member_join: "メンバー参加",
  member_leave: "メンバー退出",
  role_update: "ロール変更",
  channel_create: "チャンネル作成",
  channel_update: "チャンネル更新",
  channel_delete: "チャンネル削除",
  voice: "VC参加・退出・移動",
  voice_state: "VCミュート・デフ・配信",
  member_ban: "メンバーBAN",
  member_unban: "メンバーBAN解除",
};

// 😀 ログ種別の絵文字
export const LOG_TYPE_EMOJIS: Record<LogType, string> = {
  message_edit: "✏️",
  message_delete: "🗑️",
  member_join: "👋",
  member_leave: "🚪",
  role_update: "🎭",
  channel_create: "➕",
  channel_update: "🔧",
  channel_delete: "➖",
  voice: "🎙️",
  voice_state: "🔇",
  member_ban: "🔨",
  member_unban: "🔓",
};

// 🎨 ログ種別の埋め込み色
export const LOG_TYPE_COLORS: Record<LogType, number> = {
  message_edit: 0xfee75c,
  message_delete: 0xed4245,
  member_join: 0x57f287,
  member_leave: 0xeb459e,
  role_update: 0x5865f2,
  channel_create: 0x57f287,
  channel_update: 0xfee75c,
  channel_delete: 0xed4245,
  voice: 0x9b59b6,
  voice_state: 0x95a5a6,
  member_ban: 0xed4245,
  member_unban: 0x57f287,
};

// ===== 3. 判定 =====

// 🏷️ 文字列がログ種別かどうかを判定する
export function isLogType(value: string): value is LogType {
  return (LOG_TYPES as readonly string[]).includes(value);
}
