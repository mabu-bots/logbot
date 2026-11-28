import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LogConfigStore } from "../src/config.js";

// ==========================================
// 🧪 テスト: 設定ストア（SQLite）
// ==========================================

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "logbot-store-test-"));
}

test("log channel settings: set / get / getAll / delete", (t) => {
  const dir = makeDir();
  const store = new LogConfigStore(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(store.get("g1", "voice"), null);
  store.set("g1", "voice", "ch1");
  store.set("g1", "message_edit", "ch2");
  store.set("g2", "voice", "ch9");
  assert.equal(store.get("g1", "voice"), "ch1");
  assert.deepEqual([...store.getAll("g1").entries()].sort(), [
    ["message_edit", "ch2"],
    ["voice", "ch1"],
  ]);
  store.set("g1", "voice", "ch3"); // overwrite
  assert.equal(store.get("g1", "voice"), "ch3");
  store.delete("g1", "voice");
  assert.equal(store.get("g1", "voice"), null);
});

test("settings and voice session rows round-trip", (t) => {
  const dir = makeDir();
  const store = new LogConfigStore(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  store.setSetting("watching_text", "見守り中テスト");
  assert.equal(store.getSetting("watching_text"), "見守り中テスト");
  store.deleteSetting("watching_text");
  assert.equal(store.getSetting("watching_text"), null);

  store.setVoiceSession({
    guild_id: "g1",
    user_id: "u1",
    channel_id: "vc1",
    joined_at_ms: 123,
    estimated: 1,
  });
  // node:sqlite の行は null プロトタイプのため、deepEqual の前に展開する
  assert.deepEqual(
    { ...store.getVoiceSession("g1", "u1") },
    {
      guild_id: "g1",
      user_id: "u1",
      channel_id: "vc1",
      joined_at_ms: 123,
      estimated: 1,
    },
  );
  assert.equal(store.listVoiceSessions("g1").length, 1);
  store.deleteVoiceSession("g1", "u1");
  assert.equal(store.getVoiceSession("g1", "u1"), null);

  store.setVoiceChannelSession({
    guild_id: "g1",
    channel_id: "vc1",
    started_at_ms: 456,
    estimated: 0,
  });
  assert.equal(store.getVoiceChannelSession("g1", "vc1")?.started_at_ms, 456);
  store.deleteVoiceChannelSession("g1", "vc1");
  assert.equal(store.getVoiceChannelSession("g1", "vc1"), null);
});

test("data persists across close and reopen", (t) => {
  const dir = makeDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new LogConfigStore(dir);
  first.set("g1", "member_join", "chX");
  first.setVoiceSession({
    guild_id: "g1",
    user_id: "u1",
    channel_id: "vc1",
    joined_at_ms: 999,
    estimated: 0,
  });
  first.close();

  const second = new LogConfigStore(dir);
  assert.equal(second.get("g1", "member_join"), "chX");
  assert.equal(second.getVoiceSession("g1", "u1")?.joined_at_ms, 999);
  second.close();
});

test("close is idempotent (regression: second close threw ERR_INVALID_STATE)", (t) => {
  const dir = makeDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new LogConfigStore(dir);
  store.close();
  assert.doesNotThrow(() => store.close());
});

test("transaction commits on success and rolls back on throw", (t) => {
  const dir = makeDir();
  const store = new LogConfigStore(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  store.transaction(() => store.set("g1", "voice", "ch1"));
  assert.equal(store.get("g1", "voice"), "ch1");

  assert.throws(
    () =>
      store.transaction(() => {
        store.set("g1", "voice", "ch2");
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(
    store.get("g1", "voice"),
    "ch1",
    "failed transaction must not commit",
  );
});
