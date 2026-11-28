import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Client } from "discord.js";
import { LogConfigStore } from "../src/config.js";
import { registerEvents } from "../src/events.js";

// ==========================================
// 🧪 テスト: イベントハンドラのガード条件
// ==========================================

type Handler = (...args: never[]) => Promise<void>;

interface SentPayload {
  embeds: Array<{
    data: {
      description?: string;
      fields?: Array<{ name: string; value: string }>;
    };
  }>;
}

function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "logbot-events-test-"));
  const store = new LogConfigStore(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.set("g1", "message_edit", "logch");
  store.set("g1", "role_update", "logch");
  store.set("g1", "member_ban", "logch");

  const sent: SentPayload[] = [];
  const logChannel = {
    isTextBased: () => true,
    send: async (payload: SentPayload) => {
      sent.push(payload);
    },
  };
  const handlers = new Map<string, Handler>();
  const fakeClient = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    channels: {
      cache: new Map([["logch", logChannel]]),
      fetch: async () => logChannel,
    },
    guilds: {
      cache: new Map([["g1", { name: "テストサーバー" }]]),
      fetch: async () => ({ name: "テストサーバー" }),
    },
  };
  registerEvents(fakeClient as unknown as Client, store);
  return { handlers, sent };
}

function fieldValue(sent: SentPayload[], namePart: string): string | undefined {
  return sent[0]?.embeds[0]?.data.fields?.find((f) => f.name.includes(namePart))
    ?.value;
}

test("messageUpdate with an uncached (partial) old message is skipped, not logged as an edit from empty", async (t) => {
  const { handlers, sent } = setup(t);
  const handler = handlers.get("messageUpdate")!;
  await handler(
    { partial: true, content: null } as never,
    {
      partial: false,
      guildId: "g1",
      author: { id: "u1", username: "taro", bot: false },
      channelId: "c1",
      id: "m1",
      content: "こんにちは",
    } as never,
  );
  assert.equal(sent.length, 0);
});

test("messageUpdate logs a real edit and ignores embed-only updates", async (t) => {
  const { handlers, sent } = setup(t);
  const handler = handlers.get("messageUpdate")!;
  const base = {
    partial: false,
    guildId: "g1",
    author: { id: "u1", username: "taro", bot: false },
    channelId: "c1",
    id: "m1",
  };
  await handler(
    { ...base, content: "同じ内容" } as never,
    { ...base, content: "同じ内容" } as never,
  );
  assert.equal(
    sent.length,
    0,
    "same content (embed unfurl etc.) must not be logged",
  );
  await handler(
    { ...base, content: "編集前テキスト" } as never,
    { ...base, content: "編集後テキスト" } as never,
  );
  assert.equal(sent.length, 1);
  assert.equal(fieldValue(sent, "編集前"), "編集前テキスト");
  assert.equal(fieldValue(sent, "編集後"), "編集後テキスト");
});

test("guildMemberUpdate with a partial old member does not invent added roles (regression)", async (t) => {
  const { handlers, sent } = setup(t);
  const handler = handlers.get("guildMemberUpdate")!;
  const newMember = {
    user: { id: "u2", username: "jiro", bot: false },
    roles: {
      cache: new Map([
        ["r1", {}],
        ["r2", {}],
      ]),
    },
    nickname: null,
    guild: { id: "g1" },
  };
  await handler(
    { partial: true, roles: { cache: new Map() }, nickname: null } as never,
    newMember as never,
  );
  assert.equal(sent.length, 0, "partial old member must be skipped");

  // キャッシュ済みの旧メンバーで実際にロールが追加された場合は記録する
  await handler(
    { partial: false, roles: { cache: new Map() }, nickname: null } as never,
    newMember as never,
  );
  assert.equal(sent.length, 1);
  assert.equal(fieldValue(sent, "追加ロール"), "<@&r1>, <@&r2>");
});

test("guildBanAdd takes the reason only from the audit entry for THIS user (regression)", async (t) => {
  const { handlers, sent } = setup(t);
  const handler = handlers.get("guildBanAdd")!;
  const ban = {
    user: { id: "u9", username: "bad", bot: false },
    guild: {
      id: "g1",
      fetchAuditLogs: async () => ({
        entries: [
          { target: { id: "someone-else" }, reason: "別人のBAN理由" },
          { target: { id: "u9" }, reason: "スパム" },
        ],
      }),
    },
  };
  await handler(ban as never);
  assert.equal(sent.length, 1);
  assert.equal(fieldValue(sent, "理由"), "スパム");
});

test("guildBanAdd reports no reason when the newest audit entries are for other users", async (t) => {
  const { handlers, sent } = setup(t);
  const handler = handlers.get("guildBanAdd")!;
  const ban = {
    user: { id: "u9", username: "bad", bot: false },
    guild: {
      id: "g1",
      fetchAuditLogs: async () => ({
        entries: [{ target: { id: "someone-else" }, reason: "別人のBAN理由" }],
      }),
    },
  };
  await handler(ban as never);
  assert.equal(sent.length, 1);
  assert.equal(
    fieldValue(sent, "理由"),
    "—",
    "another user's reason must not be attributed",
  );
});
