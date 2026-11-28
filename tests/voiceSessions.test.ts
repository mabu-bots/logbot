import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Guild } from "discord.js";
import { LogConfigStore } from "../src/config.js";
import { VoiceSessionTracker } from "../src/voiceSessions.js";

// ==========================================
// 🧪 テスト: VC セッション記録
// ==========================================

function setup(t: { after: (fn: () => void) => void }): {
  store: LogConfigStore;
  tracker: VoiceSessionTracker;
} {
  const dir = mkdtempSync(join(tmpdir(), "logbot-vc-test-"));
  const store = new LogConfigStore(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, tracker: new VoiceSessionTracker(store) };
}

function fakeGuild(id: string, members: Array<[string, string]>): Guild {
  const cache = new Map(
    members.map(([userId, channelId]) => [
      userId,
      { channelId, member: { id: userId, user: { bot: false } } },
    ]),
  );
  return { id, voiceStates: { cache } } as unknown as Guild;
}

test("personal session: start keeps join time across a move, end measures the whole call", (t) => {
  const { tracker } = setup(t);
  const started = tracker.start("g1", "u1", "vc1", 1_000_000);
  assert.equal(started.joinedAtMs, 1_000_000);
  const moved = tracker.move("g1", "u1", "vc2", 1_600_000);
  assert.equal(moved?.channelId, "vc2");
  assert.equal(
    moved?.joinedAtMs,
    1_000_000,
    "move must not reset the join time",
  );
  const ended = tracker.end("g1", "u1", 4_600_000);
  assert.equal(ended?.durationMs, 3_600_000);
  assert.equal(tracker.end("g1", "u1", 4_700_000), null);
  assert.equal(tracker.get("g1", "u1"), null);
});

test("move without a recorded join starts an estimated session", (t) => {
  const { tracker } = setup(t);
  const moved = tracker.move("g1", "u1", "vc1", 2_000_000);
  assert.equal(moved?.estimated, true);
  assert.equal(moved?.joinedAtMs, 2_000_000);
});

test("channel session: first join starts, last leave ends with total duration", (t) => {
  const { tracker } = setup(t);
  const first = tracker.channelJoin("g1", "vc1", "u1", 1_000_000);
  assert.equal(first.isNew, true);
  const second = tracker.channelJoin("g1", "vc1", "u2", 1_100_000);
  assert.equal(second.isNew, false);
  assert.equal(second.session.startedAtMs, 1_000_000);

  const notLast = tracker.channelLeave("g1", "vc1", "u1", 2_000_000);
  assert.equal(notLast.ended, null);
  assert.equal(notLast.elapsedMs, 1_000_000);

  const last = tracker.channelLeave("g1", "vc1", "u2", 4_000_000);
  assert.equal(last.ended?.durationMs, 3_000_000);
  assert.equal(tracker.channelGet("g1", "vc1"), null);
});

test("manual correction clears the estimated flag and persists", (t) => {
  const { tracker } = setup(t);
  tracker.start("g1", "u1", "vc1", 5_000_000, true);
  const corrected = tracker.setJoinTime("g1", "u1", 2_000_000);
  assert.equal(corrected?.joinedAtMs, 2_000_000);
  assert.equal(corrected?.estimated, false);
  assert.equal(tracker.setJoinTime("g1", "nobody", 1), null);

  tracker.channelJoin("g1", "vc1", "u1", 5_000_000, true);
  const correctedChannel = tracker.setChannelStart("g1", "vc1", 3_000_000);
  assert.equal(correctedChannel?.startedAtMs, 3_000_000);
  assert.equal(correctedChannel?.estimated, false);
});

test("seedGuild seeds present users as estimated and drops stale sessions", (t) => {
  const { tracker } = setup(t);
  tracker.seedGuild(
    fakeGuild("g1", [
      ["u1", "vc1"],
      ["u2", "vc1"],
    ]),
    1_000_000,
  );
  assert.equal(tracker.get("g1", "u1")?.estimated, true);
  assert.equal(tracker.channelGet("g1", "vc1")?.startedAtMs, 1_000_000);

  // Bot 停止中に全員退出した場合：空のサーバーで再照合すると
  // 個人・チャンネル両方のセッションが捨てられる
  tracker.seedGuild(fakeGuild("g1", []), 2_000_000);
  assert.equal(tracker.get("g1", "u1"), null);
  assert.equal(tracker.channelGet("g1", "vc1"), null);
});

test("seedGuild re-seed forgets members who left meanwhile (regression: channel call never ended)", (t) => {
  const { tracker } = setup(t);
  tracker.seedGuild(
    fakeGuild("g1", [
      ["u1", "vc1"],
      ["u2", "vc1"],
    ]),
    1_000_000,
  );
  // u2 が退出した後に guildCreate が再発火する（サーバー再利用可能化）
  tracker.seedGuild(fakeGuild("g1", [["u1", "vc1"]]), 2_000_000);
  // u1 が本当の最後の1人になったため、この退出でチャンネル通話が終わる。
  // 修正前は u2 がメモリ上の在室集合に残り続け、チャンネルセッション
  // （とそのタイマー）が漏れ続けていた。
  const left = tracker.channelLeave("g1", "vc1", "u1", 3_000_000);
  assert.ok(
    left.ended,
    "channel call should end when the last present member leaves",
  );
  assert.equal(left.ended?.durationMs, 2_000_000);
});

test("seedGuild keeps a persisted channel start time across a restart", (t) => {
  const { store, tracker } = setup(t);
  tracker.start("g1", "u1", "vc1", 1_000_000);
  tracker.channelJoin("g1", "vc1", "u1", 1_000_000);
  // 再起動を模擬する：同じストアに対する新しいトラッカーはメモリ上の
  // 在室状況が空だが、保存済みのチャンネルセッションは残らなければならない。
  const restarted = new VoiceSessionTracker(store);
  restarted.seedGuild(
    fakeGuild("g1", [
      ["u1", "vc1"],
      ["u2", "vc1"],
    ]),
    9_000_000,
  );
  assert.equal(restarted.channelGet("g1", "vc1")?.startedAtMs, 1_000_000);
  // 再起動前からの u1 の個人セッションは維持され（同じチャンネル）、
  // u2（再起動後に初めて見た人）は再起動時刻で推定開始になる。
  assert.equal(restarted.get("g1", "u1")?.joinedAtMs, 1_000_000);
  assert.equal(restarted.get("g1", "u2")?.joinedAtMs, 9_000_000);
});
