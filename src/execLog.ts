// ==========================================
// 📋 コマンド実行ログ（1行形式）
// ==========================================
//
// 📝 標準出力へ出すコマンド実行記録の形式：
//    [exec] <ISO 時刻> cmd=<名前> route=<slash|context|prefix>
//           guild=<id> channel=<id> user=<id> result=<ok|error>
//           [error="<エラーメッセージの1行目>"]
// 📝 コマンド名・ID・成否だけを記録し、ユーザーの入力文は記録しない。
//    サーバーへ投稿するログとは別物で、Bot のコマンド実行記録として使う。

// ===== 1. 記録の型 =====
export interface ExecLogEntry {
  cmd: string;
  route: "slash" | "context" | "prefix";
  guildId: string | null;
  channelId: string | null;
  userId: string;
  result: "ok" | "error";
  error?: unknown;
}

// ===== 2. 整形と出力 =====

// ➖ 空の ID はハイフンで表示する
function idOrDash(value: string | null | undefined): string {
  return value ? value : "-";
}

// 📋 実行ログを1行の文字列に整形する
export function formatExecLog(entry: ExecLogEntry, now = new Date()): string {
  let line =
    `[exec] ${now.toISOString()} cmd=${entry.cmd} route=${entry.route}` +
    ` guild=${idOrDash(entry.guildId)} channel=${idOrDash(entry.channelId)}` +
    ` user=${entry.userId} result=${entry.result}`;
  if (entry.result === "error") {
    const message =
      entry.error instanceof Error
        ? entry.error.message
        : String(entry.error ?? "");
    const summary = message.split("\n")[0].replace(/"/g, "'").slice(0, 120); // エラー要約は先頭120文字まで
    line += ` error="${summary}"`;
  }
  return line;
}

// 📋 実行ログを標準出力へ出す
export function logExec(entry: ExecLogEntry): void {
  console.log(formatExecLog(entry));
}
