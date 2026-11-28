import assert from "node:assert/strict";
import { test } from "node:test";
import { formatExecLog } from "../src/execLog.js";

// ==========================================
// 🧪 テスト: コマンド実行ログの整形
// ==========================================

const NOW = new Date("2026-11-23T00:00:00.000Z");

test("formatExecLog: success line follows the shared [exec] format", () => {
  assert.equal(
    formatExecLog(
      {
        cmd: "ping",
        route: "slash",
        guildId: "g1",
        channelId: "c1",
        userId: "u1",
        result: "ok",
      },
      NOW,
    ),
    "[exec] 2026-11-23T00:00:00.000Z cmd=ping route=slash guild=g1 channel=c1 user=u1 result=ok",
  );
});

test("formatExecLog: error appends the first line of the message only", () => {
  assert.equal(
    formatExecLog(
      {
        cmd: "log",
        route: "slash",
        guildId: "g1",
        channelId: "c1",
        userId: "u1",
        result: "error",
        error: new Error('権限がありません "x"\n詳細は2行目'),
      },
      NOW,
    ),
    "[exec] 2026-11-23T00:00:00.000Z cmd=log route=slash guild=g1 channel=c1 user=u1 result=error error=\"権限がありません 'x'\"",
  );
});

test("formatExecLog: missing guild/channel become '-'", () => {
  assert.equal(
    formatExecLog(
      {
        cmd: "vc",
        route: "slash",
        guildId: null,
        channelId: null,
        userId: "u1",
        result: "ok",
      },
      NOW,
    ),
    "[exec] 2026-11-23T00:00:00.000Z cmd=vc route=slash guild=- channel=- user=u1 result=ok",
  );
});
