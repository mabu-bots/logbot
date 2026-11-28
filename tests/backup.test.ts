import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LogConfigStore,
  backupDatabaseFile,
  integrityCheckDatabaseFile,
  pruneDatabaseBackups,
} from "../src/config.js";

// ==========================================
// 🧪 テスト: DB バックアップと整合性チェック
// ==========================================

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "logbot-backup-test-"));
}

test("integrityCheckDatabaseFile: missing file is a new database", (t) => {
  const dir = makeDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(integrityCheckDatabaseFile(join(dir, "logbot.db")), {
    exists: false,
    ok: true,
    result: "new database",
  });
});

test("integrityCheckDatabaseFile: healthy database passes, garbage fails", (t) => {
  const dir = makeDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = new LogConfigStore(dir);
  store.set("g1", "voice", "ch1");
  store.close();
  const healthy = integrityCheckDatabaseFile(join(dir, "logbot.db"));
  assert.equal(healthy.exists, true);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.result, "ok");

  const garbagePath = join(dir, "garbage.db");
  writeFileSync(garbagePath, "this is not a sqlite database at all");
  const garbage = integrityCheckDatabaseFile(garbagePath);
  assert.equal(garbage.exists, true);
  assert.equal(garbage.ok, false);
});

test("backupDatabaseFile: null without a database, copy with one", (t) => {
  const dir = makeDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backupDir = join(dir, "backups");

  assert.equal(
    backupDatabaseFile(join(dir, "logbot.db"), backupDir, "20260101T000000Z"),
    null,
  );
  assert.equal(existsSync(backupDir), false);

  const store = new LogConfigStore(dir);
  store.set("g1", "member_join", "chX");
  store.close();

  const saved = backupDatabaseFile(
    join(dir, "logbot.db"),
    backupDir,
    "20260101T000000Z",
  );
  assert.equal(saved, join(backupDir, "20260101T000000Z", "logbot.db"));
  assert.equal(existsSync(saved as string), true);

  // コピーは保存済み設定を持つ読み取り可能な DB である
  const copyDir = makeDir();
  t.after(() => rmSync(copyDir, { recursive: true, force: true }));
  copyFileSync(saved as string, join(copyDir, "logbot.db"));
  const restored = new LogConfigStore(copyDir);
  assert.equal(restored.get("g1", "member_join"), "chX");
  restored.close();
});

test("pruneDatabaseBackups keeps only the newest generations", (t) => {
  const dir = makeDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backupDir = join(dir, "backups");
  const names = [
    "20260101T000000Z",
    "20260102T000000Z",
    "20260103T000000Z",
    "20260104T000000Z",
    "20260105T000000Z",
  ];
  for (const name of names) {
    mkdirSync(join(backupDir, name), { recursive: true });
    writeFileSync(join(backupDir, name, "logbot.db"), "x");
  }
  pruneDatabaseBackups(backupDir, 3);
  assert.deepEqual(readdirSync(backupDir).sort(), names.slice(2));
});

test("store startup saves a backup of the previous database", (t) => {
  const dir = makeDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = new LogConfigStore(dir);
  first.set("g1", "voice", "ch1");
  first.close();
  assert.equal(existsSync(join(dir, "backups")), false);

  const second = new LogConfigStore(dir);
  second.close();
  const generations = readdirSync(join(dir, "backups"));
  assert.equal(generations.length, 1);
  assert.equal(
    existsSync(join(dir, "backups", generations[0], "logbot.db")),
    true,
  );
});
