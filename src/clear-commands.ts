import { REST, Routes } from "discord.js";

// ==========================================
// 🗑️ アプリケーションコマンド全削除
// ==========================================
//
// 📝 `npm run sync:commands` の後も古いコマンドが残るときに使う削除用スクリプト
// 📝 上書き同期は「このアプリのグローバルコマンド」だけを置き換えるため、
//    次の2つは削除できない：
//    ・サーバー単位のコマンド（サーバーごとに登録される別エンドポイント）
//    ・別アプリ（旧プログラム）のコマンド
//
// 📝 使い方：
//    # logbot 自身のグローバル＋1サーバー分のコマンド：
//    DISCORD_GUILD_ID=<guild id> npm run clear:commands
//
//    # 旧プログラムのコマンド（別アプリ）：
//    # 旧アプリのトークン／アプリ ID で実行する。
//    # logbot の .env を旧認証情報で上書きしないこと。今回だけシェルで渡す。
//
// 📝 環境変数はシェルで export するか systemd の EnvironmentFile で渡す。
//    このファイルは .env を読まない（dotenv 依存なし）。
//    DISCORD_GUILD_ID / DISCORD_GUILD_IDS（カンマ区切り）は任意。
const token = process.env.DISCORD_TOKEN?.trim();
const applicationId = process.env.DISCORD_APPLICATION_ID?.trim();
if (!token || !applicationId) {
  console.error("DISCORD_TOKEN and DISCORD_APPLICATION_ID are required.");
  process.exit(1);
}
const guildIds = [
  ...new Set(
    (process.env.DISCORD_GUILD_IDS ?? process.env.DISCORD_GUILD_ID ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  ),
];

const rest = new REST({ version: "10" }).setToken(token);

// 🗑️ 指定スコープのコマンドを全削除する（削除前後を確認して検証する）
async function clearScope(label: string, route: `/${string}`): Promise<void> {
  const before = (await rest.get(route)) as Array<{ name: string }>;
  const beforeNames = before.map((c) => c.name).sort();
  if (!before.length) {
    console.log(`${label}: no commands to delete.`);
    return;
  }
  // 🗑️ 空配列の PUT は全置換：全コマンドが削除される
  await rest.put(route, { body: [] });
  const after = (await rest.get(route)) as Array<{ name: string }>;
  if (after.length) {
    console.error(
      `${label}: verification failed, ${after.length} command(s) remain: ${after.map((c) => c.name).join(", ")}.`,
    );
    process.exit(1);
  }
  console.log(
    `${label}: deleted ${before.length} command(s): ${beforeNames.join(", ")}`,
  );
}

await clearScope("Global commands", Routes.applicationCommands(applicationId));
for (const guildId of guildIds) {
  await clearScope(
    `Guild commands (${guildId})`,
    Routes.applicationGuildCommands(applicationId, guildId),
  );
}
console.log("All commands cleared for this application.");
if (!guildIds.length) {
  console.log(
    "Note: guild-scoped commands were not checked. Set DISCORD_GUILD_ID to clear them too.",
  );
}
