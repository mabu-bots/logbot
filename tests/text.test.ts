import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelType } from "discord.js";
import { channelTypeLabel } from "../src/events.js";
import { truncate } from "../src/sendLog.js";
import { formatDuration, parseManualTime } from "../src/voiceSessions.js";

// ==========================================
// 🧪 テスト: テキスト整形・時刻パース
// ==========================================

// --- truncate -----------------------------------------------------------

test("truncate leaves short text unchanged", () => {
  assert.equal(truncate("hello", 1000), "hello");
  assert.equal(truncate("", 1000), "");
});

test("truncate caps ASCII text at max and appends ...", () => {
  const out = truncate("a".repeat(1500), 1000);
  assert.equal(out.length, 1000);
  assert.ok(out.endsWith("..."));
});

test("truncate never splits a surrogate pair (regression: emoji became �)", () => {
  const out = truncate("😀".repeat(600), 1000);
  assert.ok(out.length <= 1000);
  assert.ok(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      out,
    ),
    `lone surrogate in ${JSON.stringify(out.slice(-8))}`,
  );
  assert.ok(out.endsWith("..."));
});

test("truncate never splits a ZWJ grapheme cluster", () => {
  const family = "👨‍👩‍👧‍👦"; // 11 UTF-16 units, one grapheme
  const out = truncate(family.repeat(300), 100);
  assert.ok(out.endsWith("..."));
  const prefix = out.slice(0, -3);
  assert.equal(prefix.length % family.length, 0, "cluster was cut in half");
});

test("truncate with max <= 3 adds no suffix", () => {
  assert.equal(truncate("abcdef", 3), "abc");
});

// --- formatDuration -----------------------------------------------------

test("formatDuration formats per README examples", () => {
  assert.equal(formatDuration(0), "0秒");
  assert.equal(formatDuration(32_000), "32秒");
  assert.equal(formatDuration((45 * 60 + 12) * 1000), "45分12秒");
  assert.equal(formatDuration((3600 + 23 * 60 + 45) * 1000), "1時間23分45秒");
  assert.equal(formatDuration(3600_000), "1時間");
  assert.equal(formatDuration(25 * 3600_000), "1日1時間");
  assert.equal(formatDuration(-5000), "0秒");
});

// --- parseManualTime ----------------------------------------------------

// 2026-11-15 12:00 JST
const NOW = Date.UTC(2026, 10, 15, 3, 0, 0);

test("parseManualTime relative forms", () => {
  assert.equal(parseManualTime("2時間前", NOW), NOW - 2 * 3600_000);
  assert.equal(parseManualTime("90分前", NOW), NOW - 90 * 60_000);
  assert.equal(parseManualTime("1時間30分前", NOW), NOW - 90 * 60_000);
  assert.equal(parseManualTime("3日前", NOW), NOW - 3 * 86400_000);
  assert.equal(parseManualTime("２時間前", NOW), NOW - 2 * 3600_000); // full-width digits
  assert.equal(parseManualTime("31日前", NOW), null); // over 30 days
  assert.equal(parseManualTime("0分前", NOW), null);
});

test("parseManualTime rejects garbage instead of partially reading it (regression)", () => {
  assert.equal(parseManualTime("1時間xyz分前", NOW), null);
  assert.equal(parseManualTime("abc前", NOW), null);
  assert.equal(parseManualTime("前", NOW), null);
  assert.equal(parseManualTime("", NOW), null);
  assert.equal(parseManualTime("適当な文字列", NOW), null);
});

test("parseManualTime time-of-day forms (JST)", () => {
  // 11:00 today is in the past; 17:00 today is in the future -> yesterday.
  assert.equal(parseManualTime("11:00", NOW), Date.UTC(2026, 10, 15, 2, 0, 0));
  assert.equal(parseManualTime("17:00", NOW), Date.UTC(2026, 10, 14, 8, 0, 0));
  assert.equal(
    parseManualTime("2026-11-14 17:00", NOW),
    Date.UTC(2026, 10, 14, 8, 0, 0),
  );
  assert.equal(
    parseManualTime("11-14 17:00", NOW),
    Date.UTC(2026, 10, 14, 8, 0, 0),
  );
});

test("parseManualTime month/day rolls back a year around New Year (regression)", () => {
  const jan = Date.UTC(2026, 0, 15, 3, 0, 0); // 2026-01-15 12:00 JST
  assert.equal(
    parseManualTime("12-31 17:00", jan),
    Date.UTC(2025, 11, 31, 8, 0, 0),
  );
});

test("parseManualTime rejects invalid and future dates", () => {
  assert.equal(parseManualTime("2026-02-30 17:00", NOW), null);
  assert.equal(parseManualTime("2027-01-01 00:00", NOW), null);
  assert.equal(parseManualTime("25:00", NOW), null);
});

test("parseManualTime ISO 8601 requires an explicit offset (regression)", () => {
  assert.equal(
    parseManualTime("2026-11-14T17:00:00+09:00", NOW),
    Date.UTC(2026, 10, 14, 8, 0, 0),
  );
  assert.equal(
    parseManualTime("2026-11-14T08:00:00Z", NOW),
    Date.UTC(2026, 10, 14, 8, 0, 0),
  );
  // Date-only used to reach Date.parse and be read as UTC midnight.
  assert.equal(parseManualTime("2026-11-13", NOW), null);
});

// --- channelTypeLabel ---------------------------------------------------

test("channelTypeLabel names known types and falls back safely", () => {
  assert.equal(channelTypeLabel(ChannelType.GuildText), "テキストチャンネル");
  assert.equal(channelTypeLabel(ChannelType.GuildVoice), "ボイスチャンネル");
  assert.equal(channelTypeLabel(ChannelType.GuildForum), "フォーラム");
  assert.equal(channelTypeLabel(999 as ChannelType), "チャンネル");
});
