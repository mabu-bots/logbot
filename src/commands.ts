import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { LogConfigStore } from "./config.js";
import { currentPresenceText, startPresenceCycle } from "./presence-cycle.js";
import {
  LOG_TYPES,
  LOG_TYPE_EMOJIS,
  LOG_TYPE_LABELS,
  isLogType,
} from "./logTypes.js";
import { truncate } from "./sendLog.js";
import {
  discordTimestamp,
  formatDuration,
  parseManualTime,
  shortTimestamp,
  type VoiceSessionTracker,
} from "./voiceSessions.js";

// ==========================================
// 💬 スラッシュコマンド
// ==========================================

// ===== 1. 共通部品 =====

// 👀 既定の Watching 文言（WATCHING_TEXT 環境変数、次に /watching set の保存値で上書き）
export const DEFAULT_WATCHING_TEXT = "ログを見守り中";
export const WATCHING_SETTING_KEY = "watching_text";

// 🎨 埋め込みの色（情報・成功・エラー）
const EMBED_COLOR_INFO = 0x5865f2;
const EMBED_COLOR_SUCCESS = 0x57f287;
const EMBED_COLOR_ERROR = 0xed4245;

// 📝 Discord は 4096 文字を超える埋め込み説明文と空の説明文を拒否する。
//    /vc list は VC 全員の説明文を組み立てるため、賑やかなサーバーでは
//    上限を超えて返信が丸ごと失敗する。ここで一元的に抑える：
//    書記素の境界で切り、残りを省略した旨を添える。
const MAX_DESCRIPTION = 4096; // Discord の埋め込み説明文上限
const OMITTED_NOTE = "\n…（長いため省略しました）";

// 💬 コマンド返信を共通の埋め込み形式で送る
// 📝 ephemeral 返信も埋め込みに対応する。埋め込み＋Ephemeral フラグの返信は
//    コマンド実行者にだけ見える埋め込みになる。全コマンド返信はここを通し、
//    タイトル・フッター・タイムスタンプの見た目を統一する。
//    （`ephemeral: true` は discord.js 14 で非推奨のため、
//    MessageFlags.Ephemeral のフラグ形式を使う。）
export async function replyEmbed(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string,
  color: number = EMBED_COLOR_INFO,
  ephemeral = true,
): Promise<void> {
  let body = description.trim() ? description : "—";
  if (body.length > MAX_DESCRIPTION) {
    body = truncate(body, MAX_DESCRIPTION - OMITTED_NOTE.length) + OMITTED_NOTE;
  }
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(body)
    .setColor(color)
    .setFooter({ text: "🔍 ログボット" })
    .setTimestamp(new Date());
  await interaction.reply({
    embeds: [embed],
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  });
}

// ===== 2. 権限チェック =====

// 🛡️ 管理コマンド用の実行時権限チェック
// 📝 コマンド定義の setDefaultMemberPermissions はあくまで「既定」。
//    サーバー管理者はサーバーの連携設定で全員に再許可できるうえ、
//    DM でのコマンドには一切評価されない。そのためハンドラ側で
//    ManageGuild を自分で確認する（/vc set と同じ確認）。
//    ログの通知先変更や Bot 全体の Watching 文言変更には常にこれが必要。
export function hasManageGuild(
  interaction: ChatInputCommandInteraction,
): boolean {
  return (
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false
  );
}

// 🛡️ 管理権限が無い旨を返す
async function denyManageGuild(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await replyEmbed(
    interaction,
    "🛡️ 権限がありません",
    "このコマンドはサーバー管理権限（Manage Guild）が必要です。",
    EMBED_COLOR_ERROR,
  );
}

// ===== 3. プレゼンス文言の解決 =====

// 👀 保存値→環境変数→既定の順で Watching 文言を決める
export function resolveWatchingText(store: LogConfigStore): string {
  const stored = store.getSetting(WATCHING_SETTING_KEY)?.trim();
  if (stored) return stored;
  const env = process.env.WATCHING_TEXT?.trim();
  if (env) return env;
  return DEFAULT_WATCHING_TEXT;
}

// 👀 現在表示されるプレゼンス文字列（全 Bot 共通のプレゼンス・サイクル形式）
// 📝 /watching set/reset で保存される文言は互換のため残すが、実際に適用される
//    プレゼンスは常にサイクル形式であり、保存テキストは適用されない。
export function watchingPresenceText(client: Client): string {
  return currentPresenceText(client);
}

// 👀 統一プレゼンス（プレゼンス・サイクル）を適用する
export function applyWatching(client: Client, store: LogConfigStore): void {
  // 📝 store は互換のため引数として残す（保存テキストはプレゼンスに使わない）。
  void store;
  startPresenceCycle(client);
}

// ===== 4. /log =====

// 📋 /log コマンド定義
export const logCommand = new SlashCommandBuilder()
  .setName("log")
  .setDescription("各種ログの通知先チャンネルを個別に設定します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("ログ種別ごとの通知先チャンネルを設定します")
      .addStringOption((opt) =>
        opt
          .setName("event")
          .setDescription("ログ種別")
          .setRequired(true)
          .addChoices(
            ...LOG_TYPES.map((t) => ({ name: LOG_TYPE_LABELS[t], value: t })),
          ),
      )
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("通知先チャンネル")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("disable")
      .setDescription("ログ種別の通知を止めます")
      .addStringOption((opt) =>
        opt
          .setName("event")
          .setDescription("ログ種別")
          .setRequired(true)
          .addChoices(
            ...LOG_TYPES.map((t) => ({ name: LOG_TYPE_LABELS[t], value: t })),
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("全ログ種別の通知先を表示します"),
  );

// 📋 /log コマンドの処理
export async function handleLogCommand(
  interaction: ChatInputCommandInteraction,
  store: LogConfigStore,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "このコマンドはサーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (!hasManageGuild(interaction)) {
    await denyManageGuild(interaction);
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === "list") {
    const all = store.getAll(guildId);
    // ✅ 通知オン／オフに分けて表示する（一目で分かるように）
    const on = LOG_TYPES.filter((t) => all.get(t));
    const off = LOG_TYPES.filter((t) => !all.get(t));
    const sections: string[] = [];
    sections.push(`✅ **通知する（${on.length}件）**`);
    sections.push(
      on.length
        ? on
            .map(
              (t) =>
                `${LOG_TYPE_EMOJIS[t]} ${LOG_TYPE_LABELS[t]} → <#${all.get(t)}>`,
            )
            .join("\n")
        : "なし",
    );
    sections.push(`\n⛔ **通知しない（${off.length}件）**`);
    sections.push(
      off.length
        ? off
            .map((t) => `${LOG_TYPE_EMOJIS[t]} ${LOG_TYPE_LABELS[t]}`)
            .join("\n")
        : "なし",
    );
    await replyEmbed(interaction, "📋 ログ通知先一覧", sections.join("\n"));
    return;
  }
  const event = interaction.options.getString("event", true);
  if (!isLogType(event)) {
    await replyEmbed(
      interaction,
      "⚠️ 不明なログ種別です",
      "不明なログ種別です。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (sub === "disable") {
    store.delete(guildId, event);
    await replyEmbed(
      interaction,
      `${LOG_TYPE_EMOJIS[event]} ${LOG_TYPE_LABELS[event]}`,
      "通知を止めました。",
      EMBED_COLOR_SUCCESS,
    );
    return;
  }
  // 📌 set：通知先チャンネルを設定する
  const channel = interaction.options.getChannel("channel", true);
  store.set(guildId, event, channel.id);
  // ⚠️ Bot 自身が選んだチャンネルへ投稿できない場合は警告する。
  //    これが無いと、設定は成功に見えてもその種別のログは全て
  //    送信時に捨てられてしまう。キャッシュからのベストエフォートで、
  //    Bot のメンバー情報やチャンネルの権限上書きがキャッシュに無ければ
  //    設定を妨げずにチェックを省略する。
  let warning = "";
  const me = interaction.guild?.members.me;
  if (
    me &&
    "permissionsFor" in channel &&
    typeof channel.permissionsFor === "function"
  ) {
    const perms = channel.permissionsFor(me);
    if (perms) {
      const missing: string[] = [];
      if (!perms.has(PermissionFlagsBits.ViewChannel))
        missing.push("チャンネルを見る");
      if (!perms.has(PermissionFlagsBits.SendMessages))
        missing.push("メッセージを送信する");
      if (!perms.has(PermissionFlagsBits.EmbedLinks))
        missing.push("埋め込みリンク");
      if (missing.length) {
        warning = `\n⚠️ このチャンネルではBotに次の権限がありません：${missing.join("、")}。権限が付くまでログは送信されません。`;
      }
    }
  }
  await replyEmbed(
    interaction,
    `${LOG_TYPE_EMOJIS[event]} ${LOG_TYPE_LABELS[event]}`,
    `通知先を <#${channel.id}> に設定しました。${warning}`,
    EMBED_COLOR_SUCCESS,
  );
}

// ===== 5. /watching =====

// 👀 /watching コマンド定義
export const watchingCommand = new SlashCommandBuilder()
  .setName("watching")
  .setDescription("視聴中ステータス（○○を視聴中）を設定します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("視聴中ステータスの文言を設定します（Bot全体に適用）")
      .addStringOption((opt) =>
        opt
          .setName("text")
          .setDescription("表示する文言（例：サーバーを見守り中）")
          .setRequired(true)
          .setMaxLength(128),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("show").setDescription("現在の視聴中ステータスを表示します"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("reset")
      .setDescription("視聴中ステータスを既定（ログを見守り中）に戻します"),
  );

// 👀 /watching コマンドの処理
export async function handleWatchingCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: LogConfigStore,
): Promise<void> {
  // 🛡️ Watching 文言は Bot 全体で共通で、サーバー単位ではない。
  //    defaultMemberPermissions は DM では評価されないため、権限確認が無いと
  //    DM で実行できる人なら誰でも全サーバー分の Bot ステータスを書き換えられる。
  //    /log と同じくサーバー内＋ManageGuild を必須にする。
  if (!interaction.guildId) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "このコマンドはサーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (!hasManageGuild(interaction)) {
    await denyManageGuild(interaction);
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === "show") {
    // 👀 現在のプレゼンスは全Bot統一のサイクル形式で表示する
    await replyEmbed(
      interaction,
      "👀 視聴中ステータス",
      `現在の視聴中ステータス：${watchingPresenceText(client)}`,
    );
    return;
  }
  if (sub === "reset") {
    // 📝 保存テキストは互換のため削除するが、適用されるプレゼンスはサイクル形式
    store.deleteSetting(WATCHING_SETTING_KEY);
    applyWatching(client, store);
    await replyEmbed(
      interaction,
      "👀 視聴中ステータスを既定に戻しました",
      `現在の視聴中ステータス：${watchingPresenceText(client)}`,
      EMBED_COLOR_SUCCESS,
    );
    return;
  }
  // 📌 set：プレゼンスは Bot 全体共通のため、Bot がいる全サーバーに適用される
  const text = interaction.options.getString("text", true).trim();
  if (!text) {
    // ⚠️ 空白だけの文言は以前空の設定として保存され成功と表示された一方、
    //    resolveWatchingText は黙って既定にフォールバックした。
    //    管理者は（空白の）ステータスが設定されたと信じてしまう。
    await replyEmbed(
      interaction,
      "⚠️ 文言が空です",
      "空白だけの文言は設定できません。表示する文言を入力してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  // 📝 保存動作は互換のため残すが、適用されるプレゼンスは全Bot統一の
  //    サイクル形式であり、保存した文言自体は表示されない。
  store.setSetting(WATCHING_SETTING_KEY, text);
  applyWatching(client, store);
  await replyEmbed(
    interaction,
    "👀 視聴中ステータスを設定しました",
    `文言を保存しました。適用される視聴中ステータス：${watchingPresenceText(client)}`,
    EMBED_COLOR_SUCCESS,
  );
}

// ===== 6. /vc =====

// 🎙️ /vc コマンド定義
export const vcCommand = new SlashCommandBuilder()
  .setName("vc")
  .setDescription("通話中のVCと経過時間を確認します")
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("通話中の全員と経過時間を表示します"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("time")
      .setDescription("指定したユーザーの通話経過時間を表示します")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("対象ユーザー").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription(
        "参加時刻を手動で設定します（Bot起動前からの通話時間の補正用・管理者限定）",
      )
      // 📌 Discord の仕様：必須オプションは任意オプションより先に置くため、
      //    `time`（必須）は `user` / `channel`（任意）より前に置く。
      .addStringOption((opt) =>
        opt
          .setName("time")
          .setDescription("時刻（例：2時間前 / 17:00 / 2026-11-14 17:00）")
          .setRequired(true),
      )
      .addUserOption((opt) =>
        opt
          .setName("user")
          .setDescription("参加時刻を設定するユーザー（通話中の人のみ）"),
      )
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription(
            "開始時刻を設定するVCチャンネル（通話中のチャンネルのみ）",
          )
          .addChannelTypes(ChannelType.GuildVoice),
      ),
  );

// 🎙️ /vc コマンドの処理
export async function handleVcCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  tracker: VoiceSessionTracker,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "このコマンドはサーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const now = Date.now();
  const sub = interaction.options.getSubcommand();
  if (sub === "set") {
    // 🛡️ 手動補正は通話時間を偽装できるためサーバー管理者限定
    if (!hasManageGuild(interaction)) {
      await replyEmbed(
        interaction,
        "🛡️ 権限がありません",
        "`/vc set` はサーバー管理者（サーバー管理権限）のみ使用できます。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    const user = interaction.options.getUser("user");
    const channel = interaction.options.getChannel("channel");
    if (!user && !channel) {
      await replyEmbed(
        interaction,
        "⚠️ 対象を指定してください",
        "ユーザーかチャンネルのどちらかを指定してください。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    const timeInput = interaction.options.getString("time", true);
    const atMs = parseManualTime(timeInput, now);
    if (atMs === null) {
      await replyEmbed(
        interaction,
        "⚠️ 時刻を読み取れませんでした",
        "例：`2時間前` / `90分前` / `17:00` / `2026-11-14 17:00`（日本時間・未来や30日より前は不可）",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    // ⚠️ 両方の対象を先に検証する。不正なチャンネルがあると、
    //    ユーザーへの補正だけが適用された半端な状態になってしまうため。
    if (user && !tracker.get(guildId, user.id)) {
      await replyEmbed(
        interaction,
        "🎙️ VCに参加していません",
        `<@${user.id}> は現在VCに参加していません。参加中の人のみ設定できます。`,
        EMBED_COLOR_ERROR,
      );
      return;
    }
    if (channel && !tracker.channelGet(guildId, channel.id)) {
      await replyEmbed(
        interaction,
        "📞 通話中ではありません",
        `<#${channel.id}> は現在通話中ではありません。通話中のチャンネルのみ設定できます。`,
        EMBED_COLOR_ERROR,
      );
      return;
    }
    const lines: string[] = [];
    if (user) {
      const corrected = tracker.setJoinTime(guildId, user.id, atMs)!;
      lines.push(
        `🎙️ <@${user.id}> の参加時刻を ${discordTimestamp(atMs)} に設定しました。\n⏱️ 経過時間：${formatDuration(tracker.elapsed(corrected, now))}`,
      );
    }
    if (channel) {
      const correctedChannel = tracker.setChannelStart(
        guildId,
        channel.id,
        atMs,
      )!;
      lines.push(
        `📞 <#${channel.id}> の通話開始時刻を ${discordTimestamp(atMs)} に設定しました。\n⏱️ チャンネル通話時間：${formatDuration(tracker.channelElapsed(correctedChannel, now))}`,
      );
    }
    await replyEmbed(
      interaction,
      "⏱️ 参加時刻を設定しました",
      lines.join("\n"),
      EMBED_COLOR_SUCCESS,
    );
    return;
  }
  if (sub === "time") {
    const user = interaction.options.getUser("user", true);
    const session = tracker.get(guildId, user.id);
    if (!session) {
      await replyEmbed(
        interaction,
        "🎙️ VCに参加していません",
        `<@${user.id}> は現在VCに参加していません。`,
        EMBED_COLOR_ERROR,
      );
      return;
    }
    const channelSession = tracker.channelGet(guildId, session.channelId);
    const lines = [
      `**ユーザー**　<@${user.id}>`,
      `**チャンネル**　<#${session.channelId}>`,
      `**経過時間**　⏱️ ${formatDuration(tracker.elapsed(session, now))}`,
      `**参加時刻**　${shortTimestamp(session.joinedAtMs)}（${discordTimestamp(session.joinedAtMs)}）`,
    ];
    if (channelSession) {
      lines.push(
        `**チャンネル通話時間**　📞 ${formatDuration(tracker.channelElapsed(channelSession, now))}${channelSession.estimated ? "（推定）" : ""}`,
      );
    }
    if (session.estimated) {
      lines.push(
        "\n※（推定）はBot起動後に計測を開始したため、実際の通話時間より短い可能性があります。`/vc set` で参加時刻を補正できます。",
      );
    }
    await replyEmbed(interaction, "🎙️ 通話中のVC", lines.join("\n"));
    return;
  }
  // 📋 list：VC チャンネルごとにまとめ、チャンネル自体の通話時間を先に表示する
  // 📝 他の返信と違い公開（ephemeral でない）で誰でも使えるため、
  //    チャンネル全体で見て話せる。
  const sessions = tracker.list(guildId);
  if (!sessions.length) {
    await replyEmbed(
      interaction,
      "🎙️ 通話中のVC",
      "現在VCに参加している人はいません。",
      EMBED_COLOR_INFO,
      false,
    );
    return;
  }
  const byChannel = new Map<string, typeof sessions>();
  for (const session of sessions) {
    const group = byChannel.get(session.channelId) ?? [];
    group.push(session);
    byChannel.set(session.channelId, group);
  }
  const lines: string[] = [];
  let anyEstimated = false;
  let longest: { userId: string; elapsedMs: number } | null = null;
  for (const session of sessions) {
    const elapsedMs = tracker.elapsed(session, now);
    if (!longest || elapsedMs > longest.elapsedMs)
      longest = { userId: session.userId, elapsedMs };
    if (session.estimated) anyEstimated = true;
  }
  for (const [channelId, group] of byChannel) {
    // 👑 セッションは参加順に並ぶため、グループの先頭が最も早く参加した人（このチャンネルで最長）
    const channelSession = tracker.channelGet(guildId, channelId);
    if (channelSession?.estimated) anyEstimated = true;
    const channelElapsed = channelSession
      ? `　📞 通話 ${formatDuration(tracker.channelElapsed(channelSession, now))}${channelSession.estimated ? "（推定）" : ""}`
      : "";
    // 🔗 チャンネルメンション（タップで VC へ移動できる）。単なる `#名前` ではない。
    lines.push(`📞 <#${channelId}>　${group.length}人${channelElapsed}`);
    for (const session of group) {
      const elapsedMs = tracker.elapsed(session, now);
      const crown = longest?.userId === session.userId ? " 👑最長" : "";
      lines.push(
        `　🎙️ <@${session.userId}>　⏱️ ${formatDuration(elapsedMs)}（${shortTimestamp(session.joinedAtMs)}〜）${session.estimated ? "（推定）" : ""}${crown}`,
      );
    }
  }
  lines.push(
    `\n合計 ${sessions.length}人・${byChannel.size}チャンネル${longest ? `　👑 最長は <@${longest.userId}>（${formatDuration(longest.elapsedMs)}）` : ""}`,
  );
  if (anyEstimated) {
    lines.push(
      "※（推定）はBot起動後に計測を開始したため、実際の通話時間より短い可能性があります。",
    );
  }
  await replyEmbed(
    interaction,
    "🎙️ 通話中のVC",
    lines.join("\n"),
    EMBED_COLOR_INFO,
    false,
  );
}

// ===== 7. /ping =====

// 🏓 /ping コマンド定義
export const pingCommand = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("ログボットの応答状態を確認します");

// 🏓 /ping コマンドの処理
export async function handlePing(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  await replyEmbed(
    interaction,
    "🏓 Pong!",
    `ログボットは正常に稼働しています。（ping: ${client.ws.ping}ms）`,
    EMBED_COLOR_SUCCESS,
  );
}
