import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRESENCE_SEND_LEAD_MS,
  formatElapsedMinutes,
  nextPresenceSend,
  presenceCycleText,
} from "../src/presence-cycle.js";

// ==========================================
// 🧪 テスト: プレゼンス・サイクル
// ==========================================

test("formatElapsedMinutes formats minutes and hours", () => {
  assert.equal(formatElapsedMinutes(0), "0分");
  assert.equal(formatElapsedMinutes(59_999), "0分");
  assert.equal(formatElapsedMinutes(26 * 60_000), "26分");
  assert.equal(formatElapsedMinutes((60 + 26) * 60_000), "1時間26分");
  assert.equal(formatElapsedMinutes(60 * 60_000), "1時間00分");
  assert.equal(formatElapsedMinutes(-1), "0分");
});

test("presenceCycleText alternates by unix-minute parity", () => {
  const startedAt = Date.UTC(2026, 0, 1, 0, 0, 0);
  // 偶数分フェーズ: 経過時間
  const evenMinute = new Date(startedAt + 26 * 60_000);
  assert.equal(Math.floor(evenMinute.getTime() / 60_000) % 2, 0);
  assert.equal(
    presenceCycleText("ログボット", startedAt, evenMinute),
    "ログボット | 起動して 26分",
  );
  // 奇数分フェーズ: 現在時刻（JST）
  const oddMinute = new Date(startedAt + 27 * 60_000);
  assert.equal(Math.floor(oddMinute.getTime() / 60_000) % 2, 1);
  assert.equal(
    presenceCycleText("ログボット", startedAt, oddMinute),
    "ログボット | 現在時刻 09:27 JST",
  );
});

test("presenceCycleText shows JST clock across the UTC day boundary", () => {
  const startedAt = Date.UTC(2026, 0, 1, 15, 0, 0); // 2026-01-02 00:00 JST
  const at = new Date(startedAt + 61 * 60_000); // 奇数分フェーズ
  assert.equal(Math.floor(at.getTime() / 60_000) % 2, 1);
  assert.equal(
    presenceCycleText("ログボット", startedAt, at),
    "ログボット | 現在時刻 01:01 JST",
  );
});

test("nextPresenceSend targets the next minute boundary minus the lead", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 30, 0); // 分の途中
  const { sendAt, boundary } = nextPresenceSend(now);
  assert.equal(boundary, Date.UTC(2026, 0, 1, 0, 1, 0, 0));
  assert.equal(sendAt, boundary - PRESENCE_SEND_LEAD_MS);
  assert.ok(sendAt > now);
});

test("nextPresenceSend skips to the following boundary when the lead has passed", () => {
  const boundary = Date.UTC(2026, 0, 1, 0, 1, 0, 0);
  const now = boundary - PRESENCE_SEND_LEAD_MS + 1; // 先行送信時刻を過ぎている
  const next = nextPresenceSend(now);
  assert.equal(next.boundary, boundary + 60_000);
  assert.equal(next.sendAt, next.boundary - PRESENCE_SEND_LEAD_MS);
  assert.ok(next.sendAt > now);
});

test("nextPresenceSend exactly at a boundary targets the next one", () => {
  const boundary = Date.UTC(2026, 0, 1, 0, 1, 0, 0);
  const next = nextPresenceSend(boundary);
  assert.equal(next.boundary, boundary + 60_000);
});
