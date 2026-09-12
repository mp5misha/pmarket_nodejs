import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getDb,
  createUser,
  markEmailVerified,
  createTwoFactorCode,
  getActiveTwoFactorCode,
  incrementTwoFactorAttempts,
  markTwoFactorCodeUsed,
} from "../src/db.js";
import { hashPassword, generateToken, hashToken, generate2faCode } from "../src/auth.js";

const dbPath = path.join(os.tmpdir(), `twofactor-test-${Date.now()}-${process.pid}.db`);
let db;
let user;

before(async () => {
  db = getDb(dbPath);
  user = createUser(db, { email: "twofa@example.com", passwordHash: await hashPassword("password123") });
  markEmailVerified(db, user.id);
});

after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
});

test("generate2faCode always produces a 6-digit numeric code", () => {
  for (let i = 0; i < 25; i++) {
    assert.match(generate2faCode(), /^\d{6}$/);
  }
});

test("the correct code verifies, and becomes inactive once used (single-use)", () => {
  const pendingToken = generateToken();
  const code = generate2faCode();
  createTwoFactorCode(db, {
    userId: user.id,
    codeHash: hashToken(code),
    pendingTokenHash: hashToken(pendingToken),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });

  const record = getActiveTwoFactorCode(db, hashToken(pendingToken));
  assert.ok(record, "expected an active code for this pending token");
  assert.equal(hashToken(code), record.code_hash);

  markTwoFactorCodeUsed(db, record.id);
  const again = getActiveTwoFactorCode(db, hashToken(pendingToken));
  assert.equal(again, undefined, "a used code must no longer be returned as active");
});

test("an incorrect code doesn't hash-match, and attempts increments as the route would apply", () => {
  const pendingToken = generateToken();
  const code = generate2faCode();
  createTwoFactorCode(db, {
    userId: user.id,
    codeHash: hashToken(code),
    pendingTokenHash: hashToken(pendingToken),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });

  const record = getActiveTwoFactorCode(db, hashToken(pendingToken));
  const wrongCode = code === "000000" ? "111111" : "000000";
  assert.notEqual(hashToken(wrongCode), record.code_hash);

  incrementTwoFactorAttempts(db, record.id);
  incrementTwoFactorAttempts(db, record.id);
  const updated = getActiveTwoFactorCode(db, hashToken(pendingToken));
  assert.equal(updated.attempts, 2);
});

test("a code past its expiry is flagged expired by the same check the route performs", () => {
  const pendingToken = generateToken();
  const code = generate2faCode();
  createTwoFactorCode(db, {
    userId: user.id,
    codeHash: hashToken(code),
    pendingTokenHash: hashToken(pendingToken),
    expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
  });

  const record = getActiveTwoFactorCode(db, hashToken(pendingToken));
  assert.ok(record); // "active" here only means unused — expiry is checked separately
  assert.ok(new Date(record.expires_at).getTime() <= Date.now());
});

test("a pending token from a different login attempt never matches another attempt's code", () => {
  const pendingTokenA = generateToken();
  createTwoFactorCode(db, {
    userId: user.id,
    codeHash: hashToken(generate2faCode()),
    pendingTokenHash: hashToken(pendingTokenA),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });

  const pendingTokenB = generateToken();
  const lookupWithWrongPendingToken = getActiveTwoFactorCode(db, hashToken(pendingTokenB));
  assert.equal(lookupWithWrongPendingToken, undefined);
});
