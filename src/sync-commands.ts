import { REST, Routes } from "discord.js";
import {
  logCommand,
  pingCommand,
  vcCommand,
  watchingCommand,
} from "./commands.js";

// ==========================================
// 🔄 アプリケーションコマンドの上書き同期
// ==========================================
//
// 📝 `npm run sync:commands` がコマンド登録の唯一の場所。
//    Bot 自身は起動時に同期しない（index.ts 参照）ため、
//    同期で削除したコマンドが再起動で復活することはない。
//
// 📝 上書きの手順：
//    1. 現在のグローバルコマンドを GET する（削除対象を報告するため）。
//    2. 目的のセットで PUT する。Discord の PUT は全置換で、
//       本文に無いコマンドは全て削除され、あるものは作成・更新される。マージはされない。
//    3. 再度 GET して、実際のセットが目的のセットと完全一致することを検証する。
//       一致しなければ成功と言わず非ゼロ終了する。
//
// 📝 環境変数（DISCORD_TOKEN / DISCORD_APPLICATION_ID）はシェルで export
//    するか systemd の EnvironmentFile で渡す。このファイルは .env を
//    読まない（dotenv 依存なし）。
const token = process.env.DISCORD_TOKEN?.trim();
const applicationId = process.env.DISCORD_APPLICATION_ID?.trim();
if (!token || !applicationId) {
  console.error("DISCORD_TOKEN and DISCORD_APPLICATION_ID are required.");
  process.exit(1);
}

const desired = [
  logCommand.toJSON(),
  watchingCommand.toJSON(),
  vcCommand.toJSON(),
  pingCommand.toJSON(),
];
const desiredNames = desired.map((c) => c.name).sort();
const rest = new REST({ version: "10" }).setToken(token);

const before = (await rest.get(
  Routes.applicationCommands(applicationId),
)) as Array<{ name: string }>;
const beforeNames = before.map((c) => c.name).sort();
const removed = beforeNames.filter((name) => !desiredNames.includes(name));
const added = desiredNames.filter((name) => !beforeNames.includes(name));

await rest.put(Routes.applicationCommands(applicationId), { body: desired });

const after = (await rest.get(
  Routes.applicationCommands(applicationId),
)) as Array<{ name: string }>;
const afterNames = after.map((c) => c.name).sort();
if (JSON.stringify(afterNames) !== JSON.stringify(desiredNames)) {
  console.error(
    `Overwrite sync verification failed. Expected: ${desiredNames.join(", ")}. Live: ${afterNames.join(", ")}.`,
  );
  process.exit(1);
}

console.log(
  `Application commands overwrite-synced (${before.length} -> ${after.length}).`,
);
if (added.length) console.log(`Added: ${added.join(", ")}`);
if (removed.length) console.log(`Removed: ${removed.join(", ")}`);
console.log(`Live commands: ${afterNames.join(", ")}`);
