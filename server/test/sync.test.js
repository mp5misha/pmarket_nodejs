import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb, createUser, getSyncCursor, setSyncCursor } from "../src/db.js";
import { syncFilterSignature } from "../src/polymarket.js";

const dbPath = path.join(os.tmpdir(), `sync-test-${Date.now()}-${process.pid}.db`);
let db;
let userId;

before(() => {
  db = getDb(dbPath);
  userId = createUser(db, { email: "sync-cursor@example.com", passwordHash: "x" }).id;
});

after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
});

test("syncFilterSignature is stable for identical filters and distinct for different ones", () => {
  const a = syncFilterSignature({ status: "active", tag: "politics" });
  const b = syncFilterSignature({ status: "active", tag: "politics" });
  const c = syncFilterSignature({ status: "closed", tag: "politics" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("getSyncCursor defaults to 0 when nothing has been persisted yet", () => {
  const sig = syncFilterSignature({ status: "active" });
  assert.equal(getSyncCursor(db, userId, sig), 0);
});

test("setSyncCursor persists an offset that getSyncCursor then returns", () => {
  const sig = syncFilterSignature({ status: "active", tag: "sports" });
  setSyncCursor(db, userId, sig, 250);
  assert.equal(getSyncCursor(db, userId, sig), 250);
});

test("setSyncCursor with offset 0 clears a previously-stored cursor (full sweep completed)", () => {
  const sig = syncFilterSignature({ status: "closed" });
  setSyncCursor(db, userId, sig, 400);
  assert.equal(getSyncCursor(db, userId, sig), 400);
  setSyncCursor(db, userId, sig, 0);
  assert.equal(getSyncCursor(db, userId, sig), 0);
});

test("cursors for different filter signatures don't clobber each other", () => {
  const sigA = syncFilterSignature({ status: "active", keyword: "election" });
  const sigB = syncFilterSignature({ status: "active", keyword: "sports" });
  setSyncCursor(db, userId, sigA, 100);
  setSyncCursor(db, userId, sigB, 300);
  assert.equal(getSyncCursor(db, userId, sigA), 100);
  assert.equal(getSyncCursor(db, userId, sigB), 300);
});

test("cursors are scoped per user", () => {
  const otherUserId = createUser(db, { email: "sync-cursor-other@example.com", passwordHash: "x" }).id;
  const sig = syncFilterSignature({ status: "active", tag: "shared-signature" });
  setSyncCursor(db, userId, sig, 500);
  assert.equal(getSyncCursor(db, otherUserId, sig), 0);
});
