import type { Client } from "discord.js";
import { AuditLogEvent, ChannelType } from "discord.js";
import type { LogConfigStore } from "./config.js";
import { sendLog } from "./sendLog.js";
import {
  discordTimestamp,
  formatDuration,
  type VoiceSessionTracker,
} from "./voiceSessions.js";

// ==========================================
// 📡 ゲートウェイエベントのログ送信
// ==========================================

// ===== 1. 表示ヘルパー =====

// 👤 ユーザー表示名（メンション付き）を作る
function userLabel(
  user?: { id: string; username?: string; bot?: boolean } | null,
): string {
  if (!user) return "不明";
  return `${user.username ?? user.id} (<@${user.id}>)`;
}

// 🎭 ロールの増減を差分で求める
function diffRoles(
  before: string[],
  after: string[],
): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((r) => !beforeSet.has(r)),
    removed: before.filter((r) => !afterSet.has(r)),
  };
}

// 🎭 ロール ID をメンション形式に変換する（空なら「なし」）
function mentionRoles(ids: string[]): string {
  return ids.length ? ids.map((id) => `<@&${id}>`).join(", ") : "なし";
}

// 📁 チャンネル種別を日本語名に変換する（数値表示を避ける）
export function channelTypeLabel(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildText:
      return "テキストチャンネル";
    case ChannelType.GuildVoice:
      return "ボイスチャンネル";
    case ChannelType.GuildCategory:
      return "カテゴリー";
    case ChannelType.GuildAnnouncement:
      return "アナウンスチャンネル";
    case ChannelType.AnnouncementThread:
      return "アナウンススレッド";
    case ChannelType.PublicThread:
      return "公開スレッド";
    case ChannelType.PrivateThread:
      return "プライベートスレッド";
    case ChannelType.GuildDirectory:
      return "ディレクトリ";
    case ChannelType.GuildForum:
      return "フォーラム";
    case ChannelType.GuildMedia:
      return "メディアチャンネル";
    case ChannelType.GuildStageVoice:
      return "ステージチャンネル";
    default:
      return "チャンネル";
  }
}

// ===== 2. イベント登録 =====

// 📡 ログ対象の全ゲートウェイエベントを登録する
// 📝 各ハンドラは sendLog() 経由で自分の通知先チャンネルを引く。
//    未設定なら何も送らない。
export function registerEvents(
  client: Client,
  store: LogConfigStore,
  tracker?: VoiceSessionTracker,
): void {
  // 🌱 進行中の VC セッションを起動時に照合する（起動／再参加時）
  // 📝 これが無いと、既に VC にいる人の参加時刻が分からない。
  if (tracker) {
    client.on("guildCreate", (guild) => tracker.seedGuild(guild));
  }

  // ----- 2.1 メッセージ -----

  // ✏️ メッセージ編集ログ
  client.on("messageUpdate", async (oldMessage, newMessage) => {
    if (!newMessage.guildId) return;
    // ⚠️ 旧メッセージがキャッシュに無いと discord.js は content が null の
    //    partial を渡す。「編集前」は空ではなく不明。新しい内容と比べると、
    //    本文が変わっていないイベントでも誤った編集ログ（編集前：(内容なし)）が
    //    出てしまう。例：古いメッセージの埋め込み展開が解決しただけの場合。
    //    編集前の本文が分からない編集は意味のあるログにならないため除外する。
    if (oldMessage.partial || oldMessage.content == null) return;
    // 📝 新しい側も partial の場合がある（キャッシュに無いチャンネル）。
    //    旧側と違い、今の内容は取得できる。
    let afterMessage = newMessage;
    if (newMessage.partial) {
      afterMessage = (await newMessage.fetch().catch(() => null)) ?? newMessage;
      if (afterMessage.partial) return;
    }
    if (afterMessage.author?.bot) return;
    const before = oldMessage.content;
    const after = afterMessage.content ?? "";
    if (before === after) return;
    await sendLog(
      client,
      store,
      afterMessage.guildId ?? newMessage.guildId,
      "message_edit",
      [
        {
          name: "ユーザー",
          value: userLabel(afterMessage.author),
          inline: true,
        },
        {
          name: "チャンネル",
          value: `<#${afterMessage.channelId}>`,
          inline: true,
        },
        { name: "メッセージID", value: `\`${afterMessage.id}\``, inline: true },
        { name: "編集前", value: before || "(内容なし)" },
        { name: "編集後", value: after || "(内容なし)" },
      ],
    );
  });

  // 🗑️ メッセージ削除ログ
  client.on("messageDelete", async (message) => {
    if (!message.guildId || message.author?.bot) return;
    await sendLog(client, store, message.guildId, "message_delete", [
      { name: "ユーザー", value: userLabel(message.author), inline: true },
      { name: "チャンネル", value: `<#${message.channelId}>`, inline: true },
      { name: "メッセージID", value: `\`${message.id}\``, inline: true },
      {
        name: "内容",
        value: message.content || "(内容なし・取得できませんでした)",
      },
    ]);
  });

  // 🗑️ メッセージ一括削除ログ
  client.on("messageDeleteBulk", async (messages) => {
    const first = messages.first();
    if (!first?.guildId) return;
    await sendLog(
      client,
      store,
      first.guildId,
      "message_delete",
      [
        { name: "チャンネル", value: `<#${first.channelId}>`, inline: true },
        { name: "件数", value: `${messages.size}件`, inline: true },
        {
          name: "メッセージID",
          value: messages
            .map((m) => `\`${m.id}\``)
            .slice(0, 10) // メッセージ ID は先頭 10 件まで
            .join(", "),
        },
      ],
      `${messages.size}件のメッセージを一括削除`,
    );
  });

  // ----- 2.2 メンバー -----

  // 👋 メンバー参加ログ
  client.on("guildMemberAdd", async (member) => {
    if (member.user.bot) return;
    await sendLog(
      client,
      store,
      member.guild.id,
      "member_join",
      [
        { name: "ユーザー", value: userLabel(member.user), inline: true },
        { name: "ユーザーID", value: `\`${member.id}\``, inline: true },
        {
          name: "アカウント作成日",
          value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
          inline: true,
        },
      ],
      `参加: ${member.user.username}`,
    );
  });

  // 🚪 メンバー退出ログ
  client.on("guildMemberRemove", async (member) => {
    // ⚠️ キャッシュに無いまま退出したメンバーは partial になりうる。
    //    ユーザー情報が部分的なため、ハンドラ内で例外を起こさないよう
    //    全てのアクセスをガードする。
    if (member.user?.bot) return;
    await sendLog(
      client,
      store,
      member.guild.id,
      "member_leave",
      [
        { name: "ユーザー", value: userLabel(member.user), inline: true },
        { name: "ユーザーID", value: `\`${member.id}\``, inline: true },
      ],
      `退出: ${member.user?.username ?? "不明"}`,
    );
  });

  // 🎭 ロール・ニックネーム変更ログ
  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    if (newMember.user.bot) return;
    // ⚠️ キャッシュに無い旧メンバーは partial でロールキャッシュが空。
    //    そのまま差分を取ると現在のロール全てが「追加」と誤判定される。
    //    本当の変更前は分からない（取得しても現在の状態が返るだけ）ため、
    //    partial の更新は除外する。
    if (oldMember.partial) return;
    const { added, removed } = diffRoles(
      [...oldMember.roles.cache.keys()],
      [...newMember.roles.cache.keys()],
    );
    const nickChanged = oldMember.nickname !== newMember.nickname;
    if (!added.length && !removed.length && !nickChanged) return;
    // 📝 実際に変わったロール項目だけ表示する。ニックネームのみの変更で
    //    「なし」が2つ並ぶノイズを出さないため。
    const fields = [
      { name: "ユーザー", value: userLabel(newMember.user), inline: true },
    ];
    if (added.length)
      fields.push({
        name: "追加ロール",
        value: mentionRoles(added),
        inline: false,
      });
    if (removed.length)
      fields.push({
        name: "削除ロール",
        value: mentionRoles(removed),
        inline: false,
      });
    if (nickChanged) {
      fields.push({
        name: "ニックネーム",
        value: `${oldMember.nickname ?? "なし"} → ${newMember.nickname ?? "なし"}`,
        inline: false,
      });
    }
    await sendLog(client, store, newMember.guild.id, "role_update", fields);
  });

  // ----- 2.3 チャンネル -----

  // ➕ チャンネル作成ログ
  client.on("channelCreate", async (channel) => {
    if (channel.isDMBased()) return;
    if (!channel.guildId) return;
    await sendLog(
      client,
      store,
      channel.guildId,
      "channel_create",
      [
        { name: "チャンネル", value: `<#${channel.id}>`, inline: true },
        { name: "種類", value: channelTypeLabel(channel.type), inline: true },
        { name: "名前", value: channel.name, inline: true },
      ],
      `チャンネル作成: #${channel.name}`,
    );
  });

  // 🔧 チャンネル更新ログ（名前変更のみ）
  client.on("channelUpdate", async (oldChannel, newChannel) => {
    if (newChannel.isDMBased() || oldChannel.isDMBased()) return;
    if (!newChannel.guildId || oldChannel.name === newChannel.name) return;
    await sendLog(client, store, newChannel.guildId, "channel_update", [
      { name: "チャンネル", value: `<#${newChannel.id}>`, inline: true },
      { name: "名前", value: `${oldChannel.name} → ${newChannel.name}` },
    ]);
  });

  // ➖ チャンネル削除ログ
  client.on("channelDelete", async (channel) => {
    if (channel.isDMBased()) return;
    if (!channel.guildId) return;
    await sendLog(
      client,
      store,
      channel.guildId,
      "channel_delete",
      [
        { name: "名前", value: channel.name, inline: true },
        { name: "種類", value: channelTypeLabel(channel.type), inline: true },
        { name: "チャンネルID", value: `\`${channel.id}\``, inline: true },
      ],
      `チャンネル削除: #${channel.name}`,
    );
  });

  // ----- 2.4 ボイス -----

  // 🎙️ VC 状態変化ログ
  client.on("voiceStateUpdate", async (oldState, newState) => {
    const guildId = newState.guild.id;
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;
    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    // ------------------------------------------
    // 🎙️ VC 参加・退出・移動
    // ------------------------------------------
    // 📝 通話時間は記録した参加時刻から測る（保存済みのため再起動でもリセットされない）。
    //    移動では元の参加時刻を維持する。
    if (oldChannelId !== newChannelId) {
      const now = Date.now();
      if (!oldChannelId && newChannelId) {
        const session = tracker?.start(guildId, member.id, newChannelId, now);
        const channelCall = tracker?.channelJoin(
          guildId,
          newChannelId,
          member.id,
          now,
        );
        await sendLog(
          client,
          store,
          guildId,
          "voice",
          [
            { name: "ユーザー", value: userLabel(member.user), inline: true },
            { name: "チャンネル", value: `<#${newChannelId}>`, inline: true },
            ...(session
              ? [
                  {
                    name: "参加時刻",
                    value: discordTimestamp(session.joinedAtMs),
                    inline: true,
                  },
                ]
              : []),
            ...(channelCall && tracker
              ? [
                  {
                    name: "チャンネル通話時間",
                    value: channelCall.isNew
                      ? "通話開始（0秒）"
                      : `${formatDuration(tracker.channelElapsed(channelCall.session, now))}（継続中）`,
                    inline: true,
                  },
                ]
              : []),
          ],
          `VC参加: ${member.user.username} → <#${newChannelId}>`,
        );
        return;
      }
      if (oldChannelId && !newChannelId) {
        const ended = tracker?.end(guildId, member.id, now);
        const channelLeft = tracker?.channelLeave(
          guildId,
          oldChannelId,
          member.id,
          now,
        );
        const fields = [
          { name: "ユーザー", value: userLabel(member.user), inline: true },
          { name: "チャンネル", value: `<#${oldChannelId}>`, inline: true },
        ];
        let description = `VC退出: ${member.user.username} ← <#${oldChannelId}>`;
        if (ended) {
          fields.push(
            {
              name: "参加時刻",
              value: discordTimestamp(ended.session.joinedAtMs),
              inline: true,
            },
            {
              name: "通話時間",
              value: formatDuration(ended.durationMs),
              inline: true,
            },
          );
          description += `（通話時間 ${formatDuration(ended.durationMs)}）`;
          if (ended.session.estimated) {
            fields.push({
              name: "注意",
              value:
                "Bot起動後に計測を開始したため、実際の通話時間より短い可能性があります。",
              inline: false,
            });
          }
        } else {
          fields.push({
            name: "通話時間",
            value: "不明（参加時の記録がありません）",
            inline: true,
          });
        }
        if (channelLeft?.ended) {
          fields.push({
            name: "チャンネル通話時間",
            value: `${formatDuration(channelLeft.ended.durationMs)}（通話終了）`,
            inline: true,
          });
          description += `（チャンネル通話 ${formatDuration(channelLeft.ended.durationMs)}で終了）`;
        } else if (
          channelLeft?.elapsedMs !== null &&
          channelLeft?.elapsedMs !== undefined &&
          tracker
        ) {
          fields.push({
            name: "チャンネル通話時間",
            value: `${formatDuration(channelLeft.elapsedMs)}（継続中）`,
            inline: true,
          });
        }
        await sendLog(client, store, guildId, "voice", fields, description);
        return;
      }
      // 🎙️ 移動：元の参加時刻を維持し、これまでの経過時間を表示する
      // 📝 ここでは両チャンネルとも非 null（参加・退出は上で処理済み）。
      const moved = tracker?.move(guildId, member.id, newChannelId!, now);
      const oldChannelLeft = tracker?.channelLeave(
        guildId,
        oldChannelId!,
        member.id,
        now,
      );
      const newChannelCall = tracker?.channelJoin(
        guildId,
        newChannelId!,
        member.id,
        now,
      );
      await sendLog(
        client,
        store,
        guildId,
        "voice",
        [
          { name: "ユーザー", value: userLabel(member.user), inline: true },
          { name: "チャンネル", value: `<#${newChannelId!}>`, inline: true },
          ...(moved && tracker
            ? [
                {
                  name: "経過時間",
                  value: formatDuration(tracker.elapsed(moved, now)),
                  inline: true,
                },
              ]
            : []),
          // 📞 この移動で旧チャンネルが空になった場合、その通話はここで終了する。
          //    旧コードではこの結果を捨てていたため、旧チャンネルの合計通話時間が
          //    どのログにも出なかった。
          ...(oldChannelLeft?.ended
            ? [
                {
                  name: "チャンネル通話時間",
                  value: `<#${oldChannelId}> ${formatDuration(oldChannelLeft.ended.durationMs)}（通話終了）`,
                  inline: true,
                },
              ]
            : []),
          ...(newChannelCall && tracker
            ? [
                {
                  name: "チャンネル通話時間",
                  value: newChannelCall.isNew
                    ? "通話開始（0秒）"
                    : `${formatDuration(tracker.channelElapsed(newChannelCall.session, now))}（継続中）`,
                  inline: true,
                },
              ]
            : []),
        ],
        `VC移動: ${member.user.username} <#${oldChannelId}> → <#${newChannelId}>`,
      );
      return;
    }

    // ------------------------------------------
    // 🔇 ミュート・デフ・配信の状態変化
    // ------------------------------------------
    // 📝 参加・退出とは別の `voice_state` 種別で送る。
    const changes: string[] = [];
    if (oldState.mute !== newState.mute)
      changes.push(`サーバーミュート: ${newState.mute ? "ON" : "OFF"}`);
    if (oldState.deaf !== newState.deaf)
      changes.push(`サーバーデフ: ${newState.deaf ? "ON" : "OFF"}`);
    if (oldState.selfMute !== newState.selfMute)
      changes.push(`ミュート: ${newState.selfMute ? "ON" : "OFF"}`);
    if (oldState.selfDeaf !== newState.selfDeaf)
      changes.push(`デフ: ${newState.selfDeaf ? "ON" : "OFF"}`);
    if (oldState.streaming !== newState.streaming)
      changes.push(`配信: ${newState.streaming ? "開始" : "終了"}`);
    if (oldState.selfVideo !== newState.selfVideo)
      changes.push(`ビデオ: ${newState.selfVideo ? "ON" : "OFF"}`);
    if (!changes.length) return;
    const session = tracker?.get(guildId, member.id);
    await sendLog(client, store, guildId, "voice_state", [
      { name: "ユーザー", value: userLabel(member.user), inline: true },
      {
        name: "チャンネル",
        value: newChannelId ? `<#${newChannelId}>` : "—",
        inline: true,
      },
      { name: "変更", value: changes.join("\n") },
      ...(session && tracker
        ? [
            {
              name: "経過時間",
              value: formatDuration(tracker.elapsed(session)),
              inline: true,
            },
          ]
        : []),
    ]);
  });

  // ----- 2.5 BAN -----

  // 🔨 メンバー BAN ログ
  client.on("guildBanAdd", async (ban) => {
    // ⚠️ 最新の BAN 監査ログが必ずしも今回の BAN とは限らない。
    //    直前に別の BAN があった場合や、今回の監査ログがまだ書き込まれていない場合、
    //    entries.first() を取ると前の BAN の理由を今回のユーザーに付けてしまう。
    //    対象が BAN されたユーザーと一致するエントリだけ採用し、それ以外は
    //    誤った理由より「理由なし」で報告する。
    const reason = await ban.guild
      .fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 5 }) // 最新 5 件まで確認する
      .then(
        (logs) =>
          logs.entries.find((entry) => entry.target?.id === ban.user.id)
            ?.reason ?? "",
      )
      .catch(() => "");
    await sendLog(
      client,
      store,
      ban.guild.id,
      "member_ban",
      [
        { name: "ユーザー", value: userLabel(ban.user), inline: true },
        { name: "理由", value: reason || "—" },
      ],
      `BAN: ${ban.user.username}`,
    );
  });

  // 🔓 メンバー BAN 解除ログ
  client.on("guildBanRemove", async (ban) => {
    await sendLog(
      client,
      store,
      ban.guild.id,
      "member_unban",
      [{ name: "ユーザー", value: userLabel(ban.user), inline: true }],
      `BAN解除: ${ban.user.username}`,
    );
  });
}
