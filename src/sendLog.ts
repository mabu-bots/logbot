import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import type { LogConfigStore } from "./config.js";
import {
  LOG_TYPE_COLORS,
  LOG_TYPE_EMOJIS,
  LOG_TYPE_LABELS,
  type LogType,
} from "./logTypes.js";

// ==========================================
// 📨 ログ埋め込みの送信
// ==========================================

// ===== 1. テキストの切り詰め =====

// 🔤 テキストを書記素クラスタに分割する（切り詰めで文字を壊さないため）
// 📝 素の string.slice() は UTF-16 コード単位で数えるため、
//    サロゲートペア（多くの絵文字）を分割して壊れた文字を作ることがある。
//    Intl.Segmenter は Node 22 以降で使える。無い環境ではコードポイントに分ける。
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

// 🔤 テキストを書記素クラスタの配列に分ける
export function graphemes(text: string): string[] {
  if (graphemeSegmenter)
    return [...graphemeSegmenter.segment(text)].map((s) => s.segment);
  return Array.from(text);
}

// ✂️ 書記素を壊さずに指定長へ切り詰める（末尾に ... を付ける）
// 📝 `max` は UTF-16 コード単位の上限。どの数え方でも Discord の
//    長さ制限に収まるよう、クラスタ単位で予算まで保持してから "..." を足す。
export function truncate(text: string, max = 1000): string {
  if (text.length <= max) return text;
  const suffix = max > 3 ? "..." : "";
  const budget = max - suffix.length;
  let used = 0;
  let out = "";
  for (const part of graphemes(text)) {
    if (used + part.length > budget) break;
    out += part;
    used += part.length;
  }
  return `${out}${suffix}`;
}

// ===== 2. フィールド名の絵文字 =====

// 😀 フィールド名の先頭に付ける絵文字
const FIELD_EMOJIS: Record<string, string> = {
  ユーザー: "👤",
  ユーザーID: "🆔",
  チャンネル: "💬",
  チャンネルID: "🆔",
  メッセージID: "🆔",
  内容: "📝",
  編集前: "📝",
  編集後: "✏️",
  件数: "🔢",
  アカウント作成日: "📅",
  追加ロール: "➕",
  削除ロール: "➖",
  ニックネーム: "🏷️",
  種類: "📁",
  名前: "🏷️",
  変更: "🔄",
  理由: "💭",
  通話時間: "⏱️",
  経過時間: "⏱️",
  参加時刻: "🕐",
  チャンネル通話時間: "📞",
};

// 😀 フィールド名の先頭に絵文字を付ける
function fieldName(name: string): string {
  const emoji = FIELD_EMOJIS[name];
  return emoji ? `${emoji} ${name}` : name;
}

// ===== 3. 送信 =====

// 📨 ログ埋め込みを1件送信する
// 📝 通知先が未設定の種別は無効扱いで黙って破棄する。
//    設定済みでも使えないチャンネル（削除済み・テキスト系でない・送信失敗）は
//    黙らない：コンソールへ警告を出す。黙るとその種別のログが全て消えても
//    管理者が設定ミスに気付けなくなるため。
export async function sendLog(
  client: Client,
  store: LogConfigStore,
  guildId: string,
  logType: LogType,
  fields: Array<{ name: string; value: string; inline?: boolean }>,
  description?: string,
): Promise<void> {
  const channelId = store.get(guildId, logType);
  if (!channelId) return;
  // ⚡ キャッシュ優先：channels.fetch / guilds.fetch は REST 呼び出しで、
  //    ログは頻繁（VC 状態変化など）に来る。稼働中のサーバーなら
  //    両方ともキャッシュにあるため、キャッシュに無いときだけ REST に頼る。
  const channel =
    client.channels.cache.get(channelId) ??
    (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased()) {
    console.warn(
      `[logbot] log channel unusable for ${logType} in guild ${guildId}: channel ${channelId} not found or not text-based. The log was dropped.`,
    );
    return;
  }
  const guildName =
    client.guilds.cache.get(guildId)?.name ??
    (await client.guilds
      .fetch(guildId)
      .then((g) => g.name)
      .catch(() => null));
  const embed = new EmbedBuilder()
    .setTitle(`${LOG_TYPE_EMOJIS[logType]} ${LOG_TYPE_LABELS[logType]}`)
    .setColor(LOG_TYPE_COLORS[logType])
    .setTimestamp(new Date())
    .setFooter({ text: "🔍 ログボット" });
  if (guildName) embed.setAuthor({ name: `📋 ${guildName}` });
  if (description) embed.setDescription(truncate(description, 4000)); // Discord の説明文上限 4096 文字に収める（余裕を持って 4000）
  for (const field of fields) {
    embed.addFields({
      name: fieldName(field.name),
      value: truncate(field.value || "—", 1024), // Discord のフィールド値上限 1024 文字
      inline: field.inline ?? false,
    });
  }
  await (channel as TextChannel)
    .send({ embeds: [embed] })
    .catch((error: unknown) => {
      console.warn(
        `[logbot] failed to send ${logType} log to channel ${channelId} in guild ${guildId}:`,
        error,
      );
    });
}
