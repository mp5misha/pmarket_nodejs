import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getDb,
  queryMarkets,
  queryMarketsGrouped,
  getMarket,
  getMarketsByEvent,
  getStats,
  getAllForExport,
  getTags,
  getSetting,
  setSetting,
  deleteSetting,
  listSavedSearches,
  getSavedSearch,
  createSavedSearch,
  updateSavedSearch,
  deleteSavedSearch,
  createFetchRun,
  completeFetchRun,
  listFetchRuns,
  listDueSavedSearches,
  markSavedSearchRun,
  computeInputHash,
  findCachedAnalysis,
  createAnalysis,
  getAnalysis,
  listAnalysesForMarket,
  getAnalysisThread,
  listPromptTemplates,
  getPromptTemplate,
  createPromptTemplate,
  updatePromptTemplate,
  deletePromptTemplate,
  createTrade,
  getProfitabilityAnalytics,
  getTrade,
  listTrades,
  listOpenTradeSlugs,
  deleteTrade,
  resolveTrade,
  createLedgerEntry,
  listLedgerEntries,
  getLedgerNetDelta,
  hasDebitForTrade,
  deleteLedgerEntriesForTrade,
  createUser,
  getUserById,
  getUserByEmail,
  markEmailVerified,
  updateUserPassword,
  createSession,
  getSessionByTokenHash,
  deleteSession,
  deleteAllSessionsForUser,
  createEmailVerificationToken,
  consumeEmailVerificationToken,
  createPasswordResetToken,
  consumePasswordResetToken,
  createTwoFactorCode,
  getActiveTwoFactorCode,
  incrementTwoFactorAttempts,
  markTwoFactorCodeUsed,
  createRememberedDevice,
  checkRememberedDevice,
  claimLegacyData,
  DEFAULT_DB_PATH,
} from "./db.js";
import { fetchPriceHistory } from "./polymarket.js";
import { runSyncStep, refreshMarketPrices, runFullSync } from "./sync.js";
import {
  analyzeMarket,
  askFollowUp,
  buildAnalysisPrompt,
  DEFAULT_PROMPT_TEMPLATE,
  AVAILABLE_MODELS,
  REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  estimateCost,
} from "./deepseek.js";
import { hashPassword, verifyPassword, generateToken, hashToken, generate2faCode } from "./auth.js";
import { sendMail } from "./mailer.js";
import { resolveTradeOutcome, winningSideFromPrice } from "./pnl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5173";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const COOKIE_SAMESITE = process.env.COOKIE_SAMESITE || "lax";

const SESSION_COOKIE = "session_token";
const REMEMBER_COOKIE = "remember_device";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TWO_FACTOR_TTL_MS = 10 * 60 * 1000;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const MAX_2FA_ATTEMPTS = 5;

const DEEPSEEK_KEY_SETTING = "deepseek_api_key";
const DEEPSEEK_PROMPT_SETTING = "deepseek_prompt_template";
const DEEPSEEK_MODEL_SETTING = "deepseek_model";
const DEEPSEEK_EFFORT_SETTING = "deepseek_reasoning_effort";
const DEFAULT_TEMPLATE_ID_SETTING = "default_prompt_template_id";
const HIGHLIGHT_THRESHOLD_SETTING = "highlight_threshold_pct";
const DEFAULT_HIGHLIGHT_THRESHOLD_PCT = 90;
const BANKROLL_SETTING = "bankroll_settings";
const DEFAULT_BANKROLL = { amount: 1000, currency: "USD", maxPctPerBet: 10, autoDeduct: true };
const BET_SIZING_SETTING = "bet_sizing";
const DEFAULT_BET_SIZING = { kellyFraction: 0.25, flatStakeAmount: 50, fixedPercentagePct: 2 };

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: COOKIE_SAMESITE,
    secure: IS_PRODUCTION || COOKIE_SAMESITE === "none",
    maxAge: maxAgeMs,
    path: "/",
  };
}

/** Attaches req.userId/req.userEmail from the session cookie, or 401s. Every
 * route touching user-owned data (saved searches, analyses, trades,
 * settings, etc.) uses this; the shared markets catalog and account
 * endpoints themselves stay public. */
function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const session = getSessionByTokenHash(getDb(DEFAULT_DB_PATH), hashToken(token));
  if (!session) return res.status(401).json({ error: "Session expired — please log in again" });
  req.userId = session.user_id;
  req.userEmail = session.email;
  next();
}

async function issueSession(res, userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  createSession(getDb(DEFAULT_DB_PATH), { userId, tokenHash: hashToken(token), expiresAt });
  res.cookie(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_MS));
}

function issueRememberedDevice(res, userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + REMEMBER_TTL_MS).toISOString();
  createRememberedDevice(getDb(DEFAULT_DB_PATH), { userId, tokenHash: hashToken(token), expiresAt });
  res.cookie(REMEMBER_COOKIE, token, cookieOptions(REMEMBER_TTL_MS));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Auth (Phase 8). Session management: a random opaque token in an httpOnly
// cookie, hashed before being stored server-side in `sessions` (SQLite) —
// chosen over JWT because this is a single Express process backed by one
// SQLite file (no need for a stateless token verifiable across services),
// and a DB-backed session can be revoked instantly (logout, password reset)
// without a blocklist, which a bare JWT can't do without one anyway.
// ---------------------------------------------------------------------------

app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "A valid email is required" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  const db = getDb(DEFAULT_DB_PATH);
  if (getUserByEmail(db, email)) {
    return res.status(409).json({ error: "That email is already registered" });
  }
  const passwordHash = await hashPassword(password);
  const user = createUser(db, { email, passwordHash });

  const token = generateToken();
  createEmailVerificationToken(db, {
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS).toISOString(),
  });
  const link = `${APP_BASE_URL}/verify-email?token=${token}`;
  sendMail({
    to: user.email,
    subject: "Verify your email — Polymarket Tracker",
    text: `Welcome! Verify your email to finish creating your account:\n\n${link}\n\nThis link expires in 24 hours.`,
  }).catch(() => {});

  res.status(201).json({ ok: true, message: "Check your email to verify your account before logging in." });
});

app.post("/api/auth/resend-verification", async (req, res) => {
  const { email } = req.body || {};
  const db = getDb(DEFAULT_DB_PATH);
  const user = typeof email === "string" ? getUserByEmail(db, email) : null;
  if (user && !user.email_verified) {
    const token = generateToken();
    createEmailVerificationToken(db, {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS).toISOString(),
    });
    const link = `${APP_BASE_URL}/verify-email?token=${token}`;
    sendMail({
      to: user.email,
      subject: "Verify your email — Polymarket Tracker",
      text: `Verify your email:\n\n${link}\n\nThis link expires in 24 hours.`,
    }).catch(() => {});
  }
  // Same response whether or not the email exists/is already verified —
  // avoids leaking which emails are registered.
  res.status(200).json({ ok: true });
});

app.post("/api/auth/verify-email", (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== "string" || !token) return res.status(400).json({ error: "token is required" });
  const db = getDb(DEFAULT_DB_PATH);
  const userId = consumeEmailVerificationToken(db, hashToken(token));
  if (!userId) return res.status(400).json({ error: "That verification link is invalid or has expired." });
  markEmailVerified(db, userId);
  res.status(200).json({ ok: true });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "email and password are required" });
  }
  const db = getDb(DEFAULT_DB_PATH);
  const user = getUserByEmail(db, email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  if (!user.email_verified) {
    return res.status(403).json({ error: "Please verify your email before logging in.", needsVerification: true });
  }

  const rememberToken = req.cookies?.[REMEMBER_COOKIE];
  if (rememberToken) {
    const rememberedUserId = checkRememberedDevice(db, hashToken(rememberToken));
    if (rememberedUserId === user.id) {
      await issueSession(res, user.id);
      return res.status(200).json({
        requiresTwoFactor: false,
        user: { id: user.id, email: user.email, emailVerified: true },
      });
    }
  }

  const pendingToken = generateToken();
  const code = generate2faCode();
  createTwoFactorCode(db, {
    userId: user.id,
    codeHash: hashToken(code),
    pendingTokenHash: hashToken(pendingToken),
    expiresAt: new Date(Date.now() + TWO_FACTOR_TTL_MS).toISOString(),
  });
  sendMail({
    to: user.email,
    subject: "Your login code — Polymarket Tracker",
    text: `Your login code is ${code}. It expires in 10 minutes. If you didn't try to log in, you can ignore this email.`,
  }).catch(() => {});

  res.status(200).json({ requiresTwoFactor: true, pendingToken });
});

app.post("/api/auth/2fa/verify", async (req, res) => {
  const { pendingToken, code, rememberDevice } = req.body || {};
  if (typeof pendingToken !== "string" || typeof code !== "string") {
    return res.status(400).json({ error: "pendingToken and code are required" });
  }
  const db = getDb(DEFAULT_DB_PATH);
  const record = getActiveTwoFactorCode(db, hashToken(pendingToken));
  if (!record || new Date(record.expires_at).getTime() <= Date.now()) {
    return res.status(400).json({ error: "That code has expired — please log in again." });
  }
  if (record.attempts >= MAX_2FA_ATTEMPTS) {
    return res.status(400).json({ error: "Too many incorrect attempts — please log in again." });
  }
  if (hashToken(code) !== record.code_hash) {
    incrementTwoFactorAttempts(db, record.id);
    return res.status(400).json({ error: "Incorrect code" });
  }

  markTwoFactorCodeUsed(db, record.id);
  const user = getUserById(db, record.user_id);
  await issueSession(res, user.id);
  if (rememberDevice) issueRememberedDevice(res, user.id);
  res.status(200).json({ user: { id: user.id, email: user.email, emailVerified: Boolean(user.email_verified) } });
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) deleteSession(getDb(DEFAULT_DB_PATH), hashToken(token));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.status(200).json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return res.json({ user: null });
  const session = getSessionByTokenHash(getDb(DEFAULT_DB_PATH), hashToken(token));
  if (!session) return res.json({ user: null });
  res.json({ user: { id: session.user_id, email: session.email, emailVerified: Boolean(session.email_verified) } });
});

app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body || {};
  const db = getDb(DEFAULT_DB_PATH);
  const user = typeof email === "string" ? getUserByEmail(db, email) : null;
  if (user) {
    const token = generateToken();
    createPasswordResetToken(db, {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString(),
    });
    const link = `${APP_BASE_URL}/reset-password?token=${token}`;
    sendMail({
      to: user.email,
      subject: "Reset your password — Polymarket Tracker",
      text: `Reset your password:\n\n${link}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
    }).catch(() => {});
  }
  // Always the same response — never reveal whether an email is registered.
  res.status(200).json({ ok: true });
});

app.post("/api/auth/reset-password", async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (typeof token !== "string" || !token) return res.status(400).json({ error: "token is required" });
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  const db = getDb(DEFAULT_DB_PATH);
  const userId = consumePasswordResetToken(db, hashToken(token));
  if (!userId) return res.status(400).json({ error: "That reset link is invalid or has expired." });
  await updateUserPassword(db, userId, await hashPassword(newPassword));
  deleteAllSessionsForUser(db, userId); // force re-login everywhere
  res.status(200).json({ ok: true });
});

// Migration path for pre-Phase-8 single-tenant data (see migration 008) —
// attaches everything owned by the placeholder legacy account to whoever
// calls this while logged in.
app.post("/api/auth/claim-legacy-data", requireAuth, (req, res) => {
  const claimed = claimLegacyData(getDb(DEFAULT_DB_PATH), req.userId);
  res.status(200).json({ claimed });
});

/** Reports whether a DeepSeek key is available and where it came from,
 * without ever sending the key itself back to the client. */
function deepseekKeyStatus(db, userId) {
  const stored = getSetting(db, userId, DEEPSEEK_KEY_SETTING);
  if (stored) return { configured: true, source: "database" };
  if (process.env.DEEPSEEK_API_KEY) return { configured: true, source: "env" };
  return { configured: false, source: "none" };
}

function deepseekPromptStatus(db, userId) {
  const stored = getSetting(db, userId, DEEPSEEK_PROMPT_SETTING);
  return { template: stored || DEFAULT_PROMPT_TEMPLATE, isDefault: !stored };
}

/** Currently selected DeepSeek model + reasoning effort (Phase 3), along
 * with the choices available so the settings UI doesn't hardcode them. */
function deepseekModelStatus(db, userId) {
  const model = getSetting(db, userId, DEEPSEEK_MODEL_SETTING) || DEFAULT_MODEL;
  const reasoningEffort = getSetting(db, userId, DEEPSEEK_EFFORT_SETTING) || DEFAULT_REASONING_EFFORT;
  return {
    model,
    reasoningEffort,
    availableModels: AVAILABLE_MODELS,
    reasoningEffortOptions: REASONING_EFFORT_OPTIONS,
  };
}

function bankrollStatus(db, userId) {
  const stored = getSetting(db, userId, BANKROLL_SETTING);
  if (!stored) return { ...DEFAULT_BANKROLL };
  try {
    return { ...DEFAULT_BANKROLL, ...JSON.parse(stored) };
  } catch {
    return { ...DEFAULT_BANKROLL };
  }
}

function currentBankrollBalance(db, userId) {
  return bankrollStatus(db, userId).amount + getLedgerNetDelta(db, userId);
}

function betSizingStatus(db, userId) {
  const stored = getSetting(db, userId, BET_SIZING_SETTING);
  let configured = { ...DEFAULT_BET_SIZING };
  if (stored) {
    try {
      configured = { ...DEFAULT_BET_SIZING, ...JSON.parse(stored) };
    } catch {
      /* fall back to defaults */
    }
  }
  return { ...configured, bankrollAmount: currentBankrollBalance(db, userId) };
}

app.get("/api/stats", (req, res) => {
  res.json(getStats(getDb(DEFAULT_DB_PATH)));
});

// Alias for /api/stats and /api/tags (below) — the client calls these under
// /api/meta/* because the Vercel deploy merges them into one function
// (api/meta/[key].js) to fit the Hobby plan's function-count budget. Express
// has no such constraint, so both old and new paths work here.
app.get("/api/meta/:key", (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  if (req.params.key === "stats") return res.json(getStats(db));
  if (req.params.key === "tags") return res.json(getTags(db));
  res.status(404).json({ error: "Not found" });
});

app.get("/api/markets", (req, res) => {
  const { search, status, sortBy, minVolume, minPrice, maxPrice, tag, page, pageSize } = req.query;
  const result = queryMarkets(getDb(DEFAULT_DB_PATH), {
    search,
    status,
    sortBy,
    minVolume: minVolume ? Number(minVolume) : 0,
    minPrice: minPrice !== undefined && minPrice !== "" ? Number(minPrice) : null,
    maxPrice: maxPrice !== undefined && maxPrice !== "" ? Number(maxPrice) : null,
    tag: tag || undefined,
    page: page ? Number(page) : 1,
    pageSize: pageSize ? Number(pageSize) : 50,
  });
  res.json(result);
});

// Event/market grid (Phase 1) — same filters as /api/markets, but grouped by
// Polymarket event and paginated over groups. /api/markets stays untouched
// (flat, ungrouped) since CSV export and the bulk price-refresh selection
// still depend on that shape.
app.get("/api/markets/grouped", (req, res) => {
  const { search, status, sortBy, minVolume, minPrice, maxPrice, tag, page, pageSize } = req.query;
  const result = queryMarketsGrouped(getDb(DEFAULT_DB_PATH), {
    search,
    status,
    sortBy,
    minVolume: minVolume ? Number(minVolume) : 0,
    minPrice: minPrice !== undefined && minPrice !== "" ? Number(minPrice) : null,
    maxPrice: maxPrice !== undefined && maxPrice !== "" ? Number(maxPrice) : null,
    tag: tag || undefined,
    page: page ? Number(page) : 1,
    pageSize: pageSize ? Number(pageSize) : 25,
  });
  res.json(result);
});

app.get("/api/tags", (req, res) => {
  res.json(getTags(getDb(DEFAULT_DB_PATH)));
});

app.get("/api/markets/:slug", (req, res) => {
  const row = getMarket(getDb(DEFAULT_DB_PATH), req.params.slug);
  if (!row) return res.status(404).json({ error: "Market not found" });
  res.json(row);
});

app.get("/api/markets/:slug/history", async (req, res) => {
  const row = getMarket(getDb(DEFAULT_DB_PATH), req.params.slug);
  if (!row) return res.status(404).json({ error: "Market not found" });
  if (!row.yes_token_id) {
    return res
      .status(400)
      .json({ error: "No CLOB token id stored for this market yet — sync with history enabled." });
  }
  try {
    const history = await fetchPriceHistory(row.yes_token_id, req.query.interval || "max");
    res.json(history);
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
});

app.get("/api/markets/:slug/related", (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const row = getMarket(db, req.params.slug);
  if (!row) return res.status(404).json({ error: "Market not found" });
  if (!row.event_id) return res.json([]);
  res.json(getMarketsByEvent(db, row.event_id, row.slug));
});

/** Resolves which prompt template text to use for a fresh analysis: an
 * explicit templateId from the request, else the saved default template,
 * else the built-in constant (e.g. before any template has been created,
 * or on the Vercel deploy where prompt_templates doesn't exist). */
function resolvePromptTemplate(db, userId, templateId) {
  if (templateId) {
    const template = getPromptTemplate(db, userId, templateId);
    if (!template) throw Object.assign(new Error("Unknown prompt template"), { status: 400 });
    return template;
  }
  const defaultId = getSetting(db, userId, DEFAULT_TEMPLATE_ID_SETTING);
  if (defaultId) {
    const template = getPromptTemplate(db, userId, defaultId);
    if (template) return template;
  }
  return null;
}

// Phase 3: persisted analysis history with caching by input_hash (market +
// prompt + model + reasoning effort). A plain "Analyze" reuses a completed
// result for the same inputs instead of re-billing DeepSeek; "Re-run"
// (force: true) always calls DeepSeek again and stores a new row, even if
// the inputs are identical to a previous one.
// Phase 4: a reusable, named prompt template (see resolvePromptTemplate)
// replaces Phase 3's single settings-stored prompt string.
app.post("/api/markets/:slug/analyze", requireAuth, async (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const row = getMarket(db, req.params.slug);
  if (!row) return res.status(404).json({ error: "Market not found" });
  const { force = false, templateId } = req.body || {};
  try {
    const apiKey = getSetting(db, req.userId, DEEPSEEK_KEY_SETTING);
    const template = resolvePromptTemplate(db, req.userId, templateId);
    const promptTemplateText = template?.template || DEFAULT_PROMPT_TEMPLATE;
    const { model, reasoningEffort } = deepseekModelStatus(db, req.userId);
    const promptText = buildAnalysisPrompt(row, promptTemplateText);
    const inputHash = computeInputHash({ marketSlug: row.slug, promptText, modelName: model, reasoningEffort });

    if (!force) {
      const cached = findCachedAnalysis(db, req.userId, inputHash);
      if (cached) return res.status(200).json({ analysis: cached, cached: true });
    }

    const result = await analyzeMarket(row, { apiKey, promptTemplate: promptTemplateText, model, reasoningEffort });
    const costEstimate = estimateCost(model, result.promptTokens, result.completionTokens);
    const saved = createAnalysis(db, req.userId, {
      marketSlug: row.slug,
      promptTemplateId: template?.id ?? null,
      promptText,
      inputHash,
      modelName: model,
      reasoningEffort,
      resultText: result.content,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      tokensUsed: result.tokensUsed,
      costEstimate,
      status: "completed",
    });
    res.status(200).json({ analysis: saved, cached: false });
  } catch (err) {
    res.status(err.status || 502).json({ error: String(err.message ?? err) });
  }
});

// Phase 4: a follow-up question layered on a prior analysis — DeepSeek gets
// the full reconstructed thread (every ancestor's prompt+reply) plus the
// new question, so it can build on that context. Always creates a new row
// (parent_analysis_id set), never served from cache.
app.post("/api/analyses/:id/follow-up", requireAuth, async (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const parent = getAnalysis(db, req.userId, req.params.id);
  if (!parent) return res.status(404).json({ error: "Analysis not found" });
  const { text } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }
  try {
    const apiKey = getSetting(db, req.userId, DEEPSEEK_KEY_SETTING);
    const { model, reasoningEffort } = deepseekModelStatus(db, req.userId);
    const thread = getAnalysisThread(db, req.userId, parent.id);
    const threadMessages = thread.flatMap((a) => [
      { role: "user", content: a.prompt_text },
      { role: "assistant", content: a.result_text },
    ]);
    const followUpText = text.trim();
    const result = await askFollowUp(threadMessages, followUpText, { apiKey, model, reasoningEffort });
    const costEstimate = estimateCost(model, result.promptTokens, result.completionTokens);
    const inputHash = computeInputHash({
      marketSlug: parent.market_slug,
      promptText: followUpText,
      modelName: model,
      reasoningEffort,
    });
    const saved = createAnalysis(db, req.userId, {
      marketSlug: parent.market_slug,
      promptTemplateId: parent.prompt_template_id,
      promptText: followUpText,
      inputHash,
      modelName: model,
      reasoningEffort,
      resultText: result.content,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      tokensUsed: result.tokensUsed,
      costEstimate,
      status: "completed",
      parentAnalysisId: parent.id,
    });
    res.status(200).json({ analysis: saved });
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
});

app.get("/api/markets/:slug/analyses", requireAuth, (req, res) => {
  res.json(listAnalysesForMarket(getDb(DEFAULT_DB_PATH), req.userId, req.params.slug));
});

app.get("/api/analyses/:id", requireAuth, (req, res) => {
  const row = getAnalysis(getDb(DEFAULT_DB_PATH), req.userId, req.params.id);
  if (!row) return res.status(404).json({ error: "Analysis not found" });
  res.json(row);
});

// Phase 4: reusable prompt template CRUD, plus which one is the default
// used when an analysis request doesn't specify a templateId.
app.get("/api/prompt-templates", requireAuth, (req, res) => {
  res.json(listPromptTemplates(getDb(DEFAULT_DB_PATH), req.userId));
});

app.post("/api/prompt-templates", requireAuth, (req, res) => {
  const { name, template } = req.body || {};
  if (typeof name !== "string" || !name.trim() || typeof template !== "string" || !template.trim()) {
    return res.status(400).json({ error: "name and template are required" });
  }
  res.status(201).json(createPromptTemplate(getDb(DEFAULT_DB_PATH), req.userId, { name: name.trim(), template }));
});

app.put("/api/prompt-templates/:id", requireAuth, (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const existing = getPromptTemplate(db, req.userId, req.params.id);
  if (!existing) return res.status(404).json({ error: "Prompt template not found" });
  const { name = existing.name, template = existing.template } = req.body || {};
  if (!name.trim() || !template.trim()) {
    return res.status(400).json({ error: "name and template cannot be empty" });
  }
  res.status(200).json(updatePromptTemplate(db, req.userId, req.params.id, { name, template }));
});

app.delete("/api/prompt-templates/:id", requireAuth, (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  deletePromptTemplate(db, req.userId, req.params.id);
  const defaultId = getSetting(db, req.userId, DEFAULT_TEMPLATE_ID_SETTING);
  if (String(defaultId) === String(req.params.id)) deleteSetting(db, req.userId, DEFAULT_TEMPLATE_ID_SETTING);
  res.status(204).end();
});

app.get("/api/settings/default-prompt-template", requireAuth, (req, res) => {
  const id = getSetting(getDb(DEFAULT_DB_PATH), req.userId, DEFAULT_TEMPLATE_ID_SETTING);
  res.json({ templateId: id ? Number(id) : null });
});

app.post("/api/settings/default-prompt-template", requireAuth, (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const { templateId } = req.body || {};
  if (templateId == null) {
    deleteSetting(db, req.userId, DEFAULT_TEMPLATE_ID_SETTING);
    return res.status(200).json({ templateId: null });
  }
  if (!getPromptTemplate(db, req.userId, templateId)) {
    return res.status(400).json({ error: "Unknown prompt template" });
  }
  setSetting(db, req.userId, DEFAULT_TEMPLATE_ID_SETTING, String(templateId));
  res.status(200).json({ templateId: Number(templateId) });
});

// Phase 5: highlight markets whose implied probability (Yes price) is at or
// above a configurable threshold — used by <MarketGrid>'s highlightThreshold
// prop. Stored per-user so it survives restarts without affecting others.
app.get("/api/settings/highlight-threshold", requireAuth, (req, res) => {
  const stored = getSetting(getDb(DEFAULT_DB_PATH), req.userId, HIGHLIGHT_THRESHOLD_SETTING);
  res.json({ thresholdPct: stored != null ? Number(stored) : DEFAULT_HIGHLIGHT_THRESHOLD_PCT });
});

app.post("/api/settings/highlight-threshold", requireAuth, (req, res) => {
  const { thresholdPct } = req.body || {};
  const n = Number(thresholdPct);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return res.status(400).json({ error: "thresholdPct must be a number between 0 and 100" });
  }
  setSetting(getDb(DEFAULT_DB_PATH), req.userId, HIGHLIGHT_THRESHOLD_SETTING, String(n));
  res.status(200).json({ thresholdPct: n });
});

// Phase 7: bankroll settings and ledger, all per-user.
app.get("/api/settings/bankroll", requireAuth, (req, res) => {
  res.json(bankrollStatus(getDb(DEFAULT_DB_PATH), req.userId));
});

app.post("/api/settings/bankroll", requireAuth, (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const { amount, currency, maxPctPerBet, autoDeduct } = req.body || {};
  const current = bankrollStatus(db, req.userId);
  const next = {
    amount: amount != null ? Number(amount) : current.amount,
    currency: currency != null ? String(currency).toUpperCase().slice(0, 8) : current.currency,
    maxPctPerBet: maxPctPerBet != null ? Number(maxPctPerBet) : current.maxPctPerBet,
    autoDeduct: autoDeduct != null ? Boolean(autoDeduct) : current.autoDeduct,
  };
  if (!Number.isFinite(next.amount) || next.amount < 0) {
    return res.status(400).json({ error: "amount must be a non-negative number" });
  }
  if (!Number.isFinite(next.maxPctPerBet) || next.maxPctPerBet <= 0 || next.maxPctPerBet > 100) {
    return res.status(400).json({ error: "maxPctPerBet must be between 0 and 100" });
  }
  setSetting(db, req.userId, BANKROLL_SETTING, JSON.stringify(next));
  res.status(200).json(next);
});

// Dashboard: current bankroll, amount staked in open trades, realized P&L,
// and exposure (staked as a % of current bankroll) — this user's own only.
app.get("/api/bankroll/dashboard", requireAuth, (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const settings = bankrollStatus(db, req.userId);
  const balance = currentBankrollBalance(db, req.userId);
  const openTrades = listTrades(db, { status: "open", userId: req.userId });
  const staked = openTrades.reduce((sum, t) => sum + t.stake, 0);
  const resolvedTrades = [
    ...listTrades(db, { status: "won", userId: req.userId }),
    ...listTrades(db, { status: "lost", userId: req.userId }),
  ];
  const realizedPnl = resolvedTrades.reduce((sum, t) => sum + (t.profit ?? 0), 0);
  res.json({
    balance,
    currency: settings.currency,
    startingAmount: settings.amount,
    staked,
    openTradeCount: openTrades.length,
    realizedPnl,
    exposurePct: balance > 0 ? (staked / balance) * 100 : 0,
  });
});

app.get("/api/bankroll/ledger", requireAuth, (req, res) => {
  const { limit } = req.query;
  res.json(listLedgerEntries(getDb(DEFAULT_DB_PATH), req.userId, { limit: limit ? Number(limit) : 100 }));
});

// Manual ledger entries (deposit/withdrawal) — debit/credit entries are
// created automatically by trade creation/resolution below.
app.post("/api/bankroll/ledger", requireAuth, (req, res) => {
  const { entryType, amount, note } = req.body || {};
  if (!["deposit", "withdrawal"].includes(entryType)) {
    return res.status(400).json({ error: "entryType must be 'deposit' or 'withdrawal'" });
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: "amount must be a positive number" });
  }
  const entry = createLedgerEntry(getDb(DEFAULT_DB_PATH), req.userId, { entryType, amount: amt, note: note || null });
  res.status(201).json(entry);
});

// Phase 6: bet-sizing configuration shared by all three staking methods the
// suggestion calculator offers. `bankrollAmount` in the response is the
// live current bankroll balance (Phase 7's ledger-backed figure), not a
// value stored/edited here — set the starting amount under Bankroll
// settings instead.
app.get("/api/settings/bet-sizing", requireAuth, (req, res) => {
  res.json(betSizingStatus(getDb(DEFAULT_DB_PATH), req.userId));
});

app.post("/api/settings/bet-sizing", requireAuth, (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const { kellyFraction, flatStakeAmount, fixedPercentagePct } = req.body || {};
  const current = betSizingStatus(db, req.userId);
  const next = {
    kellyFraction: kellyFraction != null ? Number(kellyFraction) : current.kellyFraction,
    flatStakeAmount: flatStakeAmount != null ? Number(flatStakeAmount) : current.flatStakeAmount,
    fixedPercentagePct: fixedPercentagePct != null ? Number(fixedPercentagePct) : current.fixedPercentagePct,
  };
  for (const [key, val] of Object.entries(next)) {
    if (!Number.isFinite(val) || val < 0) {
      return res.status(400).json({ error: `${key} must be a non-negative number` });
    }
  }
  if (next.kellyFraction > 1) {
    return res.status(400).json({ error: "kellyFraction must be between 0 and 1" });
  }
  setSetting(db, req.userId, BET_SIZING_SETTING, JSON.stringify(next));
  res.status(200).json({ ...next, bankrollAmount: currentBankrollBalance(db, req.userId) });
});

// Phase 5: manually-recorded trades and their automatic resolution.
app.get("/api/trades", requireAuth, (req, res) => {
  const { status, marketSlug } = req.query;
  res.json(listTrades(getDb(DEFAULT_DB_PATH), { status, marketSlug, userId: req.userId }));
});

app.post("/api/trades", requireAuth, (req, res) => {
  const { marketSlug, side, entryPrice, stake, placedAt, note, estimatedProb } = req.body || {};
  if (!marketSlug || !["yes", "no"].includes(side)) {
    return res.status(400).json({ error: "marketSlug and side ('yes' or 'no') are required" });
  }
  const price = Number(entryPrice);
  const stakeAmount = Number(stake);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return res.status(400).json({ error: "entryPrice must be a number between 0 and 1" });
  }
  if (!Number.isFinite(stakeAmount) || stakeAmount <= 0) {
    return res.status(400).json({ error: "stake must be a positive number" });
  }
  let estimatedProbValue = null;
  if (estimatedProb !== undefined && estimatedProb !== null && estimatedProb !== "") {
    estimatedProbValue = Number(estimatedProb);
    if (!Number.isFinite(estimatedProbValue) || estimatedProbValue < 0 || estimatedProbValue > 1) {
      return res.status(400).json({ error: "estimatedProb must be a number between 0 and 1" });
    }
  }
  const db = getDb(DEFAULT_DB_PATH);
  if (!getMarket(db, marketSlug)) return res.status(404).json({ error: "Market not found" });

  // Phase 7: enforce the bankroll's configured max % per bet.
  const bankroll = bankrollStatus(db, req.userId);
  const balance = currentBankrollBalance(db, req.userId);
  const maxStake = (bankroll.maxPctPerBet / 100) * balance;
  if (stakeAmount > maxStake) {
    return res.status(400).json({
      error: `Stake exceeds the ${bankroll.maxPctPerBet}% max-per-bet cap (max $${maxStake.toFixed(2)} of your $${balance.toFixed(2)} bankroll)`,
    });
  }

  const trade = createTrade(db, req.userId, {
    marketSlug,
    side,
    entryPrice: price,
    stake: stakeAmount,
    placedAt: placedAt || undefined,
    note: note || null,
    estimatedProb: estimatedProbValue,
  });

  // Auto-deduct: debit the stake from the bankroll ledger immediately.
  if (bankroll.autoDeduct) {
    createLedgerEntry(db, req.userId, {
      entryType: "debit",
      amount: stakeAmount,
      tradeId: trade.id,
      note: `Trade entry: ${marketSlug} (${side.toUpperCase()})`,
    });
  }

  res.status(201).json(trade);
});

app.delete("/api/trades/:id", requireAuth, (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const existing = getTrade(db, req.userId, req.params.id);
  if (!existing) return res.status(404).json({ error: "Trade not found" });
  deleteLedgerEntriesForTrade(db, req.params.id);
  deleteTrade(db, req.userId, req.params.id);
  res.status(204).end();
});

// Manually kicks the same resolution check the in-process scheduler runs
// every SCHEDULE_POLL_MS — lets the UI get an immediate answer instead of
// waiting for the next tick. Runs across every account, same as the
// scheduled version, since it's one shared job over shared market data.
app.post("/api/trades/check-resolutions", requireAuth, async (req, res) => {
  try {
    const result = await checkTradeResolutions();
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// Phase 9: aggregate profitability metrics (ROI, win rate, average edge,
// Brier score) and chart data (P&L over time, P&L by category, calibration)
// across every resolved trade.
app.get("/api/trades/analytics", requireAuth, (req, res) => {
  res.json(getProfitabilityAnalytics(getDb(DEFAULT_DB_PATH), req.userId));
});

app.get("/api/trades/export", requireAuth, (req, res) => {
  const rows = listTrades(getDb(DEFAULT_DB_PATH), { userId: req.userId });
  if (!rows.length) return res.status(404).send("No trades to export yet");
  const cols = Object.keys(rows[0]).filter((c) => c !== "user_id");
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => escape(r[c])).join(","));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=trades.csv");
  res.send(lines.join("\n"));
});

app.get("/api/settings/deepseek-key", requireAuth, (req, res) => {
  res.json(deepseekKeyStatus(getDb(DEFAULT_DB_PATH), req.userId));
});

app.post("/api/settings/deepseek-key", requireAuth, (req, res) => {
  const { apiKey } = req.body || {};
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return res.status(400).json({ error: "apiKey is required" });
  }
  const db = getDb(DEFAULT_DB_PATH);
  setSetting(db, req.userId, DEEPSEEK_KEY_SETTING, apiKey.trim());
  res.status(200).json(deepseekKeyStatus(db, req.userId));
});

app.delete("/api/settings/deepseek-key", requireAuth, (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  deleteSetting(db, req.userId, DEEPSEEK_KEY_SETTING);
  res.status(200).json(deepseekKeyStatus(db, req.userId));
});

app.get("/api/settings/deepseek-prompt", requireAuth, (req, res) => {
  res.json(deepseekPromptStatus(getDb(DEFAULT_DB_PATH), req.userId));
});

app.post("/api/settings/deepseek-prompt", requireAuth, (req, res) => {
  const { template } = req.body || {};
  if (typeof template !== "string" || !template.trim()) {
    return res.status(400).json({ error: "template is required" });
  }
  const db = getDb(DEFAULT_DB_PATH);
  setSetting(db, req.userId, DEEPSEEK_PROMPT_SETTING, template);
  res.status(200).json(deepseekPromptStatus(db, req.userId));
});

app.delete("/api/settings/deepseek-prompt", requireAuth, (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  deleteSetting(db, req.userId, DEEPSEEK_PROMPT_SETTING);
  res.status(200).json(deepseekPromptStatus(db, req.userId));
});

app.get("/api/settings/deepseek-model", requireAuth, (req, res) => {
  res.json(deepseekModelStatus(getDb(DEFAULT_DB_PATH), req.userId));
});

app.post("/api/settings/deepseek-model", requireAuth, (req, res) => {
  const { model, reasoningEffort } = req.body || {};
  const db = getDb(DEFAULT_DB_PATH);
  if (model !== undefined) {
    if (!AVAILABLE_MODELS.includes(model)) {
      return res.status(400).json({ error: `Unknown model. Choose one of: ${AVAILABLE_MODELS.join(", ")}` });
    }
    setSetting(db, req.userId, DEEPSEEK_MODEL_SETTING, model);
  }
  if (reasoningEffort !== undefined) {
    if (!REASONING_EFFORT_OPTIONS.some((o) => o.value === reasoningEffort)) {
      return res.status(400).json({
        error: `Unknown reasoning effort. Choose one of: ${REASONING_EFFORT_OPTIONS.map((o) => o.value).join(", ")}`,
      });
    }
    setSetting(db, req.userId, DEEPSEEK_EFFORT_SETTING, reasoningEffort);
  }
  res.status(200).json(deepseekModelStatus(db, req.userId));
});

app.get("/api/export", (req, res) => {
  const rows = getAllForExport(getDb(DEFAULT_DB_PATH));
  if (!rows.length) return res.status(404).send("No data to export yet");
  const cols = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => escape(r[c])).join(","));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=markets.csv");
  res.send(lines.join("\n"));
});

app.post("/api/markets/refresh", requireAuth, async (req, res) => {
  const { slugs } = req.body || {};
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return res.status(400).json({ error: "slugs must be a non-empty array" });
  }
  try {
    const result = await refreshMarketPrices({ dbPath: DEFAULT_DB_PATH, slugs });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.post("/api/sync/step", requireAuth, async (req, res) => {
  try {
    const {
      offset = 0,
      batchSize = 50,
      status = "active",
      history = false,
      interval = "max",
      tag = "",
      resolutionFrom = "",
      resolutionTo = "",
      minVolume = 0,
      minLiquidity = 0,
      keyword = "",
    } = req.body || {};
    const result = await runSyncStep({
      dbPath: DEFAULT_DB_PATH,
      offset,
      batchSize,
      status,
      history,
      interval,
      tag,
      resolutionFrom,
      resolutionTo,
      minVolume,
      minLiquidity,
      keyword,
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

// Market Discovery (Phase 2) — saved search configurations.
app.get("/api/saved-searches", requireAuth, (req, res) => {
  res.json(listSavedSearches(getDb(DEFAULT_DB_PATH), req.userId));
});

app.post("/api/saved-searches", requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  const created = createSavedSearch(getDb(DEFAULT_DB_PATH), req.userId, req.body);
  res.status(201).json(created);
});

app.put("/api/saved-searches/:id", requireAuth, (req, res) => {
  const db = getDb(DEFAULT_DB_PATH);
  const existing = getSavedSearch(db, req.userId, req.params.id);
  if (!existing) return res.status(404).json({ error: "Saved search not found" });
  const merged = {
    name: existing.name,
    status: existing.status,
    tag: existing.tag,
    resolutionFrom: existing.resolution_from,
    resolutionTo: existing.resolution_to,
    minVolume: existing.min_volume,
    minLiquidity: existing.min_liquidity,
    keyword: existing.keyword,
    scheduleMinutes: existing.schedule_minutes,
    ...req.body,
  };
  const updated = updateSavedSearch(db, req.userId, req.params.id, merged);
  res.status(200).json(updated);
});

app.delete("/api/saved-searches/:id", requireAuth, (req, res) => {
  deleteSavedSearch(getDb(DEFAULT_DB_PATH), req.userId, req.params.id);
  res.status(204).end();
});

// Market Discovery (Phase 2) — audit trail of catalog fetches, either ad hoc
// or tied to a saved search. The client creates a run before starting its
// sync-step loop, then marks it complete/failed once the loop finishes.
app.get("/api/fetch-runs", requireAuth, (req, res) => {
  const { savedSearchId, limit } = req.query;
  res.json(
    listFetchRuns(getDb(DEFAULT_DB_PATH), req.userId, {
      savedSearchId: savedSearchId ? Number(savedSearchId) : undefined,
      limit: limit ? Number(limit) : 50,
    })
  );
});

app.post("/api/fetch-runs", requireAuth, (req, res) => {
  const { savedSearchId, filters } = req.body || {};
  const id = createFetchRun(getDb(DEFAULT_DB_PATH), req.userId, { savedSearchId: savedSearchId ?? null, filters });
  res.status(201).json({ id });
});

app.post("/api/fetch-runs/:id/complete", requireAuth, (req, res) => {
  const { marketsAdded = 0, marketsUpdated = 0, status = "completed", error = null } = req.body || {};
  completeFetchRun(getDb(DEFAULT_DB_PATH), req.params.id, { marketsAdded, marketsUpdated, status, error });
  res.status(200).json({ ok: true });
});

// In production, serve the built client (client/dist) from this same
// process/port — lets the whole app run as one deployable service instead
// of two separate dev servers. No-op locally until you run `npm run build`.
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
  console.log("Serving built client from", clientDist);
}

// Phase 2's "optional scheduled reruns" — a saved search with
// schedule_minutes set is re-fetched automatically. In-process interval
// rather than a separate job queue/cron dependency, per the agreed job
// scheduling approach; only meaningful while this server process stays up.
// Runs across every account's saved searches (listDueSavedSearches is
// intentionally unscoped — see db.js).
const SCHEDULE_POLL_MS = 60_000;

async function runDueScheduledSearches() {
  const db = getDb(DEFAULT_DB_PATH);
  const due = listDueSavedSearches(db);
  for (const s of due) {
    const filters = {
      status: s.status,
      tag: s.tag || "",
      resolutionFrom: s.resolution_from || "",
      resolutionTo: s.resolution_to || "",
      minVolume: s.min_volume || 0,
      minLiquidity: s.min_liquidity || 0,
      keyword: s.keyword || "",
    };
    const runId = createFetchRun(db, s.user_id, { savedSearchId: s.id, filters });
    try {
      const result = await runFullSync({ dbPath: DEFAULT_DB_PATH, ...filters });
      completeFetchRun(db, runId, {
        marketsAdded: result.added,
        marketsUpdated: result.updated,
        status: "completed",
      });
    } catch (err) {
      completeFetchRun(db, runId, { status: "failed", error: String(err.message ?? err) });
    }
    markSavedSearchRun(db, s.id);
  }
}

setInterval(() => {
  runDueScheduledSearches().catch((err) => console.error("Scheduled saved-search run failed:", err));
}, SCHEDULE_POLL_MS);

// Phase 5: automatic resolution-checking for open trades, across every
// account (listOpenTradeSlugs/the unscoped listTrades below are
// intentionally global — see db.js). A market is treated as resolved once
// it's closed and its Yes price has snapped to (near) 0 or 1, per how
// Polymarket's Gamma API represents a settled outcome.
async function checkTradeResolutions() {
  const db = getDb(DEFAULT_DB_PATH);
  const slugs = listOpenTradeSlugs(db);
  if (slugs.length === 0) return { checked: 0, resolved: 0 };

  try {
    await refreshMarketPrices({ dbPath: DEFAULT_DB_PATH, slugs });
  } catch {
    // Best-effort refresh — fall back to whatever prices are already stored.
  }

  let resolved = 0;
  for (const slug of slugs) {
    const market = getMarket(db, slug);
    if (!market || !market.closed || market.current_price == null) continue;

    const winningSide = winningSideFromPrice(market.current_price);
    if (!winningSide) continue; // closed but not cleanly settled to 0/1 yet

    for (const trade of listTrades(db, { status: "open", marketSlug: slug })) {
      const { status: outcome, payout, profit } = resolveTradeOutcome({
        side: trade.side,
        entryPrice: trade.entry_price,
        stake: trade.stake,
        winningSide,
      });
      resolveTrade(db, trade.id, { status: outcome, payout, profit });
      // Credit the ledger on a win, but only for trades whose stake was
      // actually auto-deducted at entry — a trade placed with autoDeduct
      // off never touched the ledger, so it shouldn't credit one either.
      if (outcome === "won" && hasDebitForTrade(db, trade.id)) {
        createLedgerEntry(db, trade.user_id, {
          entryType: "credit",
          amount: payout,
          tradeId: trade.id,
          note: `Trade won: ${slug}`,
        });
      }
      resolved += 1;
    }
  }
  return { checked: slugs.length, resolved };
}

setInterval(() => {
  checkTradeResolutions().catch((err) => console.error("Trade resolution check failed:", err));
}, SCHEDULE_POLL_MS);

app.listen(PORT, () => {
  console.log(`Polymarket tracker listening on http://localhost:${PORT}`);
});
