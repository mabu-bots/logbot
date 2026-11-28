import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { LogConfigStore } from "../src/config.js";
import {
  handleLogCommand,
  handleWatchingCommand,
  replyEmbed,
  resolveWatchingText,
} from "../src/commands.js";

// ==========================================
// 🧪 テスト: コマンドハンドラと権限ゲート
// ==========================================

interface ReplyPayload {
  embeds: Array<{ data: { title?: string; description?: string } }>;
  flags?: number;
}

function fakeInteraction(options: {
  guildId: string | null;
  canManage: boolean;
  sub: string;
  strings?: Record<string, string>;
}) {
  const replies: ReplyPayload[] = [];
  const interaction = {
    guildId: options.guildId,
    guild: options.guildId ? { members: { me: null } } : null,
    memberPermissions: { has: () => options.canManage },
    options: {
      getSubcommand: () => options.sub,
      getString: (name: string) => options.strings?.[name] ?? "",
      getChannel: () => ({ id: "ch1" }),
      getUser: () => null,
    },
    reply: async (payload: ReplyPayload) => {
      replies.push(payload);
    },
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    replies,
  };
}

function makeStore(t: { after: (fn: () => void) => void }): LogConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "logbot-cmd-test-"));
  const store = new LogConfigStore(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

// --- replyEmbed -----------------------------------------------------------

test("replyEmbed clamps an over-long description instead of failing the reply (regression: /vc list)", async () => {
  const { interaction, replies } = fakeInteraction({
    guildId: "g1",
    canManage: true,
    sub: "list",
  });
  await replyEmbed(interaction, "🎙️ 通話中のVC", "x".repeat(6000));
  const description = replies[0].embeds[0].data.description ?? "";
  assert.ok(description.length <= 4096, `description is ${description.length}`);
  assert.ok(description.includes("省略しました"));
});

test("replyEmbed uses the Ephemeral flag and survives an empty description", async () => {
  const a = fakeInteraction({ guildId: "g1", canManage: true, sub: "list" });
  await replyEmbed(a.interaction, "t", "");
  assert.equal(a.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(a.replies[0].embeds[0].data.description, "—");

  const b = fakeInteraction({ guildId: "g1", canManage: true, sub: "list" });
  await replyEmbed(b.interaction, "t", "public", 0x5865f2, false);
  assert.equal(b.replies[0].flags, undefined);
});

// --- /log permission gate (regression: only the builder default was checked) ---

test("/log disable without ManageGuild changes nothing", async (t) => {
  const store = makeStore(t);
  store.set("g1", "message_edit", "ch1");
  const { interaction, replies } = fakeInteraction({
    guildId: "g1",
    canManage: false,
    sub: "disable",
    strings: { event: "message_edit" },
  });
  await handleLogCommand(interaction, store);
  assert.equal(
    store.get("g1", "message_edit"),
    "ch1",
    "setting must survive an unauthorized call",
  );
  assert.ok(replies[0].embeds[0].data.title?.includes("権限"));
});

test("/log disable with ManageGuild works", async (t) => {
  const store = makeStore(t);
  store.set("g1", "message_edit", "ch1");
  const { interaction } = fakeInteraction({
    guildId: "g1",
    canManage: true,
    sub: "disable",
    strings: { event: "message_edit" },
  });
  await handleLogCommand(interaction, store);
  assert.equal(store.get("g1", "message_edit"), null);
});

// --- /watching permission + guild gate (regression: no checks at all) ---

function fakeClient() {
  const activities: string[] = [];
  const client = {
    ws: { ping: 42 },
    user: {
      username: "ログボット",
      setActivity: (text: string) => {
        activities.push(text);
      },
    },
  };
  return { client: client as unknown as Client, activities };
}

test("/watching set in a DM cannot change the bot-wide status (regression)", async (t) => {
  const store = makeStore(t);
  const { client, activities } = fakeClient();
  const { interaction } = fakeInteraction({
    guildId: null,
    canManage: false,
    sub: "set",
    strings: { text: "乗っ取り" },
  });
  await handleWatchingCommand(interaction, client, store);
  assert.equal(store.getSetting("watching_text"), null);
  assert.equal(activities.length, 0);
});

test("/watching set without ManageGuild in a guild changes nothing", async (t) => {
  const store = makeStore(t);
  const { client } = fakeClient();
  const { interaction, replies } = fakeInteraction({
    guildId: "g1",
    canManage: false,
    sub: "set",
    strings: { text: "新しい文言" },
  });
  await handleWatchingCommand(interaction, client, store);
  assert.equal(store.getSetting("watching_text"), null);
  assert.ok(replies[0].embeds[0].data.title?.includes("権限"));
});

test("/watching set with ManageGuild applies and persists", async (t) => {
  const store = makeStore(t);
  const { client, activities } = fakeClient();
  const { interaction } = fakeInteraction({
    guildId: "g1",
    canManage: true,
    sub: "set",
    strings: { text: "  新しい文言  " },
  });
  await handleWatchingCommand(interaction, client, store);
  assert.equal(resolveWatchingText(store), "新しい文言");
  // 保存テキストは互換のため保持されるが、適用されるプレゼンスは
  // 全Bot統一のプレゼンス・サイクル形式（経過時間／現在時刻の交互表示）。
  // 旧テストは統一前の「/help | 42ms」形式を期待していたため、
  // 本番コード（サイクル形式）に合わせて期待値を修正した。
  assert.equal(activities.length, 1);
  assert.match(
    activities[0],
    /^ログボット \| (起動して \d+分|現在時刻 \d{2}:\d{2} JST)$/,
  );
});

test("/watching set rejects a whitespace-only text instead of storing an empty setting (regression)", async (t) => {
  const store = makeStore(t);
  store.setSetting("watching_text", "既存の文言");
  const { client } = fakeClient();
  const { interaction, replies } = fakeInteraction({
    guildId: "g1",
    canManage: true,
    sub: "set",
    strings: { text: "   " },
  });
  await handleWatchingCommand(interaction, client, store);
  assert.equal(resolveWatchingText(store), "既存の文言");
  assert.ok(replies[0].embeds[0].data.title?.includes("空"));
});
