import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from "discord.js";
import { LogConfigStore } from "./config.js";
import {
  applyWatching,
  handleLogCommand,
  handlePing,
  handleVcCommand,
  handleWatchingCommand,
} from "./commands.js";
import { registerEvents } from "./events.js";
import { logExec } from "./execLog.js";
import { VoiceSessionTracker } from "./voiceSessions.js";
import { attachReadyWatchdog } from "./watchdog.js";

// ==========================================
// 🤖 Bot 起動・ゲートウェイ接続
// ==========================================
//
// 📝 環境変数は pm2 の ecosystem が .env を読み込んで渡す
//    （この Bot 自身は dotenv を読み込まない）。

// ===== 1. 設定確認と保存の初期化 =====
const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error(
    "DISCORD_TOKEN is required. Copy .env.example to .env and set it.",
  );
  process.exit(1);
}
const dataDir = process.env.DATA_DIR?.trim() || "./data";
const store = new LogConfigStore(dataDir);
const voiceTracker = new VoiceSessionTracker(store);

// ===== 2. クライアント構築 =====
// 📩 Partial が無いと、キャッシュに無いメッセージの削除ログに内容・作成者が載らない
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // 🔑 特権：参加・退出・ロールログ用
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 🔑 特権：編集・削除の内容取得用
    GatewayIntentBits.GuildVoiceStates, // 🎙️ VC ログ用
    GatewayIntentBits.GuildModeration, // 🔨 BAN・BAN 解除ログ用
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.GuildMember,
    Partials.User,
  ],
});

// 🛡️ Gateway 安全構造：READY が来ないサイレント停滞を検知して終了する（watchdog.ts）
attachReadyWatchdog(client);

// 🛡️ ゲートウェイ・シャードのエラーで Bot 全体を落とさない
// 📝 EventEmitter の 'error' はリスナー無しだと例外になるうえ、
//    イベントハンドラ内の未処理の reject も同様。1つの悪いイベントは
//    ログ1件分の損失に留め、ログ記録プロセス全体を道連れにしない。
//    どちらもログに残し、失敗を見える状態にする。
client.on("error", (error) => {
  console.error("client error", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection", reason);
});

// ===== 3. READY 処理 =====
// 📝 Events.ClientReady は discord.js 14.22 での 'ready' の非推奨でない名前
//    （v15 では 'ready' に改名される）。
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user?.tag}`);
  // 👀 全Bot統一プレゼンス（プレゼンス・サイクル）を適用する
  applyWatching(client, store);
  // 🌱 進行中の VC セッションを照合する：既に VC にいる人には今から始まる推定タイマーを付け、
  //    Bot 停止中に退出した人の古いセッションは捨てる。
  voiceTracker.seedAll(client);
  // 📝 コマンドはここでは同期しない。`npm run sync:commands` で
  //    グローバルコマンドを上書き同期する（src/sync-commands.ts 参照）。
  //    起動時に同期すると、同期で削除したコマンドが復活してしまうため。
});

// ===== 4. コマンド受付 =====
// 💬 スラッシュコマンドの受付
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const execBase = {
    cmd: interaction.commandName,
    route: "slash" as const,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
  };
  try {
    if (interaction.commandName === "log")
      await handleLogCommand(interaction, store);
    else if (interaction.commandName === "watching")
      await handleWatchingCommand(interaction, client, store);
    else if (interaction.commandName === "vc")
      await handleVcCommand(interaction, client, voiceTracker);
    else if (interaction.commandName === "ping")
      await handlePing(interaction, client);
    logExec({ ...execBase, result: "ok" });
  } catch (error) {
    console.error("interaction failed", error);
    logExec({ ...execBase, result: "error", error });
    const embed = new EmbedBuilder()
      .setTitle("⚠️ 処理に失敗しました")
      .setDescription("処理に失敗しました。")
      .setColor(0xed4245)
      .setFooter({ text: "🔍 ログボット" })
      .setTimestamp(new Date());
    // ⚠️ reply() は最初の応答の前だけ使える。ハンドラが既に応答済み
    //    （または defer 済み）なら、エラー通知は followUp / editReply 経由にする。
    //    旧コードは `replied` だけを見て、失敗を黙って飲み込んでいたため
    //    ユーザーには何も届かなかった。
    try {
      if (interaction.replied)
        await interaction.followUp({
          embeds: [embed],
          flags: MessageFlags.Ephemeral,
        });
      else if (interaction.deferred)
        await interaction.editReply({ embeds: [embed] });
      else
        await interaction.reply({
          embeds: [embed],
          flags: MessageFlags.Ephemeral,
        });
    } catch {
      // ⏱️ インタラクションのトークンは期限切れの可能性がある。その場合はユーザーへ表示できるものはもう無い。
    }
  }
});

// 📡 ログ対象のゲートウェイイベントを登録する
registerEvents(client, store, voiceTracker);

// ===== 5. 終了処理とログイン =====
// 🚪 終了処理：ゲートウェイ切断と DB クローズを行い、両シグナルが来ても1回だけ実行する
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down.`);
  try {
    client.destroy();
  } finally {
    store.close();
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await client.login(token);
