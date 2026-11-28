// ==========================================
// 🚀 pm2 ecosystem（logbot）
// ==========================================
//
// 📝 起動: pm2 start ecosystem.config.cjs
//    再起動後も残すには pm2 startup（表示されたコマンドを実行）と pm2 save。
//
// 📝 このファイルが .env を自前で読む理由：pm2 は .env を読み込まず、
//    この Bot 自身も読み込まない（dotenv 依存なし）。そのため
//    DISCORD_TOKEN / DISCORD_APPLICATION_ID が渡らなくなってしまう。
//    ここでリポジトリ直下の .env を解析し、環境変数としてアプリへ渡す。
//    秘密情報は .env（gitignore 対象）にだけ置き、このファイルには書かない。
//
// 📝 Node バージョン：Bot は Node 組み込みの node:sqlite を使う。
//    Node 22 では --experimental-sqlite フラグが必要なため、
//    Node < 24 のときだけ自動で付ける（Node 24+ では不要）。
const fs = require("node:fs");
const path = require("node:path");

// 📄 .env ファイルを解析して環境変数のオブジェクトにする
function loadEnvFile(file) {
  const env = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return env;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

const envFromFile = loadEnvFile(path.join(__dirname, ".env"));
if (!envFromFile.DISCORD_TOKEN || !envFromFile.DISCORD_APPLICATION_ID) {
  console.error(
    "[logbot] .env に DISCORD_TOKEN / DISCORD_APPLICATION_ID がありません。先に .env を用意してください。",
  );
}

const nodeMajor = Number(process.versions.node.split(".")[0]);

module.exports = {
  apps: [
    {
      name: "logbot",
      script: "dist/src/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      kill_timeout: 5000,
      // Node < 24 では node:sqlite にこのフラグが必要
      ...(nodeMajor < 24 ? { node_args: "--experimental-sqlite" } : {}),
      env: {
        NODE_ENV: "production",
        ...envFromFile,
      },
    },
  ],
};
