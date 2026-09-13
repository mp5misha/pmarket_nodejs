# Polymarket Tracker — React + Node

A local web app for browsing Polymarket's public market data: slug, current
price, resolution date, volume, liquidity, and (optionally) the all-time
min/max price, pulled from Polymarket's public Gamma and CLOB APIs — plus
on-demand AI analysis of a selected market via the DeepSeek API.

```
polymarket-app/
  api/      Vercel serverless functions — same endpoints as server/, backed
            by Postgres instead of a local file (for deploying on Vercel)
  lib/      Shared Gamma/CLOB client, DeepSeek client, and Postgres data
            layer, used by api/
  server/   Express API — same endpoints, backed by local SQLite (for
            Replit/Render/Railway/local use)
  client/   Vite + React UI — sync controls, a filterable market table, and a
            detail panel with an on-demand price-history chart and DeepSeek
            analysis
```

No Polymarket API key or wallet needed — both Gamma and CLOB endpoints are
public. You do need a (free) Postgres database if deploying to Vercel — see
below. AI analysis needs a DeepSeek API key — see **AI analysis (DeepSeek)**
below.

## Deploy natively to Vercel

This is now a first-class target: `api/` holds Vercel serverless functions
that mirror the Express server's endpoints, backed by a hosted Postgres
database instead of a local SQLite file (Vercel has no persistent disk).
The sync also works differently here — see **How sync works on Vercel**
below — because a single serverless function can't run for several minutes
the way the old click-and-wait sync did.

**This deploy has no login** — it's frozen at the pre-Phase-8 feature set,
so there are no accounts and every visitor shares one global dataset.
AI analysis with a persisted history and follow-up questions, and trade
tracking with profitability analytics, *are* implemented here (Postgres-
backed, mirroring `server/`'s tables minus per-user scoping and, for
trades, minus the bankroll ledger/auto-deduct, which stays Phase 7's
Express/SQLite-only territory). What's still missing here is Phase 4's
reusable prompt templates (Settings falls back to the old single-prompt
editor) and Phase 6's bet-sizing calculator — both Express/SQLite only. The
Market Discovery screen this paragraph used to mention here is gone from
*both* backends now — see **Using it** below. The shared client
detects a backend with no `/api/auth/*` routes and skips the login screen
entirely rather than showing one with nowhere for it to lead. For full
parity (accounts, bankroll, prompt templates), deploy `server/` instead
(see the two options below).

**Function count:** the Hobby plan caps a deployment at 12 serverless
functions; `api/**/*.js` is deliberately kept at exactly that limit. A
dynamic route file (e.g. `api/settings/[key].js`) counts once regardless of
how many values that segment matches, which is how a few logically-separate
endpoints share one physical file: `api/settings/[key].js` serves
`deepseek-key` and `deepseek-prompt`; `api/meta/[key].js` serves `stats` and
`tags`. **Only single dynamic segments are used for this** (`[key].js`, or
a `[slug]/` folder containing plain static filenames like
`api/markets/[slug]/analyze.js`) — never a catch-all (`[...x].js` or
`[[...x]].js`). An earlier version of this deploy tried consolidating
`api/markets/[slug]/*` into one `[[...action]].js` catch-all file to save
function budget; catch-all routing is unreliable in a plain (non-Next.js)
Vercel deployment like this one and it broke market details in production.
Don't reintroduce it.

`api/trades.js` uses a different trick: it's a single flat file with no
dynamic segment at all — GET/POST `/api/trades` handle list/create, and
delete/check-resolutions/analytics/export are dispatched via `?id=`/
`?action=` query params instead of `/trades/:id`-style sub-paths. Express
answers the same query-param requests (`server/src/index.js`) alongside its
own pre-existing path-based routes, so both deploy targets work off the
same `client/src/api.js` URLs. `api/markets/index.js` (a flat, ungrouped
market list) was deleted outright rather than merged — nothing in the
client ever called it, `groupedMarkets`/`refreshMarkets` being the only
consumers of `/api/markets/*`, so it was dead weight before the budget
ever came into it.

If you need more budget than these tricks free up, either drop a route/
feature or move to a Pro plan (100-function limit), and test any file-count
or routing change against a real Vercel deployment before relying on it,
not just locally.

**1. Provision a free Postgres database (Neon, via Vercel's own integration):**
- In your Vercel project → **Storage** tab → **Create Database** → **Neon**
  (Postgres). Follow the prompts; it's free at this scale.
- This should automatically add a `DATABASE_URL` (or `POSTGRES_URL`)
  environment variable to your project. Double-check under **Settings →
  Environment Variables** — if the variable has a different name, either
  rename it to `DATABASE_URL` or add `DATABASE_URL` yourself pointing at the
  same (pooled) connection string. `lib/db.js` reads `DATABASE_URL`,
  falling back to `POSTGRES_URL`.

**2. Deploy:**
- Import this repo into Vercel with **Root Directory left as the repo
  root** (not `client` — that was for the split-deploy option below).
  `vercel.json` at the root tells Vercel how to build just the client
  (`client/dist`) while auto-detecting everything under `api/` as functions.
- Deploy. Once it's up, open the URL — the React app and the API are served
  from the same domain, so no CORS setup or `VITE_API_BASE` needed here.

### How sync works on Vercel

Vercel's Hobby plan caps a function at ~10 seconds (configurable higher on
paid plans via `vercel.json`'s `functions.maxDuration`, already set to 30
here — Vercel silently clamps this to whatever your plan actually allows).
The original sync could run for minutes, so instead of one big request, the
**browser** now drives a loop: it calls `POST /api/sync/step` repeatedly,
each call handling one small batch (100 markets, or 20 if fetching price
history — one extra HTTP call per market), advancing an offset each time,
until the server reports no markets left or you've hit your requested
limit. The progress bar in the sidebar reflects this loop directly. This
same endpoint shape now also exists on the Express server
(`server/src/index.js`), so the client behaves identically either way.

### Split deploy instead: client on Vercel + API on Render/Railway

If you'd rather not manage a Postgres database, this is the alternative:
Vercel hosts only the static React build, and a persistent Express+SQLite
service on Render/Railway handles the API.

**1. Deploy the API to Render (or Railway):**
- On Render: **New → Web Service**, point it at the repo, **Root Directory:
  `server`**, build command `npm install`, start command `npm start`.
- Add a persistent disk mounted in `server/` if you want `polymarket.db` to
  survive redeploys.
- Set the `SMTP_*` and `APP_BASE_URL` environment variables (see
  `server/.env.example`) — required for account verification/2FA/reset
  emails to actually reach anyone once this isn't running on your machine.
  Since the client is on a different origin here, also set
  `COOKIE_SAMESITE=none` (requires HTTPS, which Render/Railway provide).
- Note the URL Render gives you, e.g. `https://polymarket-tracker-api.onrender.com`.

**2. Deploy the client to Vercel:**
- New Project → same repo → set **Root Directory: `client`** in Vercel's
  project settings (overrides the root `vercel.json`). Vercel auto-detects
  it as a Vite app — no extra config needed.
- Add an environment variable: `VITE_API_BASE` =
  `https://polymarket-tracker-api.onrender.com/api` (your Render URL + `/api`).
- Deploy. The client will call the Render-hosted API directly.

## Deploy it to test right away without any of the above

#### Replit (fastest — browser only, free, no card)

1. Go to replit.com → **Create Repl** → **Import from GitHub** (push this
   folder to a repo first) or **Upload folder** and pick this zip's contents.
2. Replit reads the included `.replit` file and runs
   `npm run build && npm start` automatically — click the big **Run** button.
3. It'll build the client, start the server, and open a public preview URL
   in-browser immediately. That URL is shareable and stays up while your
   Repl is open (free tier sleeps after inactivity — reopen it to wake it).
4. If Replit doesn't pick up `.replit` automatically (can happen on
   upload-only imports), just run the same two commands yourself in the
   Replit **Shell** tab:
   ```bash
   npm run build
   npm start
   ```

#### Render / Railway (still free tier, stays running longer)

1. Push this folder to a GitHub repo.
2. Create a new **Web Service** pointing at it, with:
   - Build command: `npm run build`
   - Start command: `npm start`
3. Both platforms auto-detect the port via the `PORT` env var, which the
   server already reads (`process.env.PORT`) — nothing to configure there.
4. Add a persistent disk/volume mounted at the server's working directory if
   you want `polymarket.db` to survive redeploys — otherwise each deploy
   starts from an empty database.

Either way, once it's up: open the URL, create an account (see "Accounts and
authentication" below), click **Run sync** in the sidebar, and you're
browsing live Polymarket data in the deployed app.

**On any real deploy**, set the `SMTP_*` environment variables (see
`server/.env.example`) in the platform's environment variable settings —
without them, verification/2FA/reset emails are only logged to the server's
own console, which you can't read once it's not your local machine. Also
set `APP_BASE_URL` to the deployed URL so email links point somewhere real.

## Local setup instead

Requires Node 18–22 (for built-in `fetch`; this was built and tested against
Node 22). **Avoid Node 23/24** — their prebuilt macOS binaries require
macOS 13.5+, so they won't run on older Macs (e.g. Big Sur / macOS 11).

On an older macOS version, install Node via `nvm` rather than Homebrew —
Homebrew only supports the last few macOS releases and may refuse to install
on an older one, while `nvm` pulls the official binary directly:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart your terminal, then:
nvm install 22
nvm use 22
```

**Terminal 1 — start the API server:**
```bash
cd server
npm install
cp .env.example .env   # then fill in real values — see "Accounts and authentication" below
npm start
```
This listens on `http://localhost:3001` and creates `server/polymarket.db`
(SQLite) on first run. `.env` is gitignored — never commit real secrets;
`.env.example` documents the variable names.

**Terminal 2 — start the UI:**
```bash
cd client
npm install
npm run dev
```
Open the URL it prints (typically `http://localhost:5173`). The dev server
proxies `/api/*` requests to the Express server, so both need to be running.

## Accounts and authentication (Express/SQLite only)

The app requires an account: on first load you'll see **Log in** / **Create
an account** instead of the market grid. This is Express/SQLite only — the
frozen Vercel deploy predates accounts and has no login screen (see
"Migrating existing single-tenant data" below for what that means if you're
moving from one to the other).

**Registration → verification → login:**
1. **Create an account** with an email and password (min. 8 characters,
   hashed with bcrypt — the plaintext password is never stored). You're
   sent a verification email; the account can't log in until it's clicked.
2. **Log in** with email + password. A correct password doesn't sign you in
   immediately — it triggers a **6-digit code emailed to you**, valid for
   10 minutes, capped at 5 incorrect attempts before you have to log in
   again. Check **Remember this device for 30 days** to skip this step on
   future logins from the same browser.
3. **Forgot your password?** sends a reset link (valid 1 hour) if that
   email is registered — the response is identical either way, so the flow
   can't be used to check which emails have accounts. Resetting logs you
   out everywhere (every session is invalidated), not just on your current
   device.

**Session management: an httpOnly cookie backed by a database table**,
chosen over JWT because this app is a single Express process backed by one
SQLite file — there's no second service that needs to verify a token
independently, which is JWT's main advantage. A cookie session can be
revoked instantly (logout, or a password reset invalidating every session)
by deleting its row; a bare JWT can't be revoked before it naturally expires
without adding a blocklist anyway, which gives up the "stateless" benefit
that's the usual reason to reach for JWT in the first place. The cookie
itself holds a random opaque token — only its SHA-256 hash is stored server-
side, the same pattern used for every other single-use token here (email
verification, password reset, 2FA codes).

**Email provider — pluggable via environment variables**, not hardcoded to
any service: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (any
SMTP-compatible provider works; `MAIL_FROM` defaults to `SMTP_USER`). See
`server/.env.example` for the full list, including `APP_BASE_URL` (used to
build the links inside verification/reset emails). Leave `SMTP_*` unset in
local dev to have emails logged to the server console instead of actually
sent, so you can develop the auth flow without setting up a real mail
provider — grab the link/code from the terminal output.

**Migrating existing single-tenant data:** every user-owned table (saved
searches, fetch runs, AI analyses, prompt templates, trades, the bankroll
ledger, and settings) now carries a `user_id` — the shared `markets` catalog
itself does not, since it mirrors Polymarket's public data and is the same
for everyone regardless of account. If this database had data in it from
before accounts existed, migration 008 attaches all of it to a placeholder
"legacy" account (`legacy@local.invalid`, an address on a TLD reserved by
RFC 2606 so it can never receive real mail or collide with a signup) with an
unusable random password hash — nobody can log into it. After creating your
own account, **⚙ Settings → Account → Claim legacy data** reassigns
everything that account owns to you; it's safe to click more than once
(a no-op once there's nothing left to claim).

## Using it

- **Sidebar** — set how many markets to fetch; a market status filter (active
  only, closed only, or both); a category/tag to scope the sync to (populated
  from whatever's already been synced); a resolution date range to only sync
  markets resolving in that window; and whether to also fetch price history
  (needed for the min/max columns and the chart — it's slower, one extra API
  call per market, with an editable delay between those calls to stay easy on
  Polymarket's API). Click **Run sync** and a progress bar tracks it live.
- **Market grid** — search by keyword, filter by status (**All statuses** /
  **Active** / **Resolved**, applied server-side via `GET /api/markets/
  grouped`'s `status` param rather than filtering only what's already on the
  page), filter by minimum volume, filter by price range (min/max current
  Yes price), and filter by category/tag (populated from whatever's been
  synced). Markets that share a
  Polymarket event (e.g. each candidate in an election) are grouped under one
  event header row instead of appearing as unrelated rows; a market with no
  event is its own single-row group. Each row shows Yes price, No price, and
  the implied probability (the stored price itself — Polymarket's per-share
  price already functions as the market's implied probability; this app
  doesn't currently fetch live order-book best bid/ask, only Gamma's last
  traded price). Sort by volume, liquidity, implied probability, event date,
  or resolved-first, and paginate (10/25/50/100 rows per page — a "page" is a
  page of event groups, not raw market rows). An auto-refresh interval
  (off/15s/30s/1m/5m) re-polls what's stored in the database — it does not
  itself hit Polymarket on a timer; use **Run sync** or **Update selected
  prices** to actually pull fresh data. A resolved market shows a "Resolved"
  badge instead of a last-updated time. A **Highlight ≥ N%** field (Express/
  SQLite only) tints any row whose implied Yes probability is at or above
  that percentage — the value is saved server-side and persists across
  restarts. Click any row to open its detail panel below.
- **Bulk price update** — check one or more rows, then click **Update
  selected prices** to re-fetch just those markets' current price, volume,
  and liquidity from Polymarket without re-running a full sync. Any
  previously-computed min/max and CLOB token id are left untouched.
- **Detail panel** — Yes/No price, volume, liquidity, resolution date, a
  **Related markets in this event** list (other markets sharing the same
  Polymarket event, e.g. other candidates in the same election — click one
  to jump straight to it), a **Load price history chart** button, a **Mark
  as traded** action (see below), and an **Analyze with DeepSeek** button
  (see below).
- **Export CSV** in the sidebar downloads everything currently stored.

## Trades and P&L

Click **Mark as traded** on a market's detail panel to record a manual
trade: side (Yes/No, pre-filling that side's current price as the entry
price — editable), stake, and an optional note. The **My Trades** tab lists
every recorded trade with tabs for All/Open/Won/Lost, a running net P&L
total, and a **Check resolutions now** button.

A trade's resolution check — refreshing the price/closed status of any
market with an open trade, and once that market is closed and its Yes price
has settled to (near) 0 or 1, matching how Polymarket represents a final
outcome, marking each open trade **Won** or **Lost** based on which side
actually won — is the same on both backends; the difference is what
triggers it. The Express/SQLite backend also runs it automatically every 60
seconds (an in-process check); the frozen Vercel deploy has no background
timer, so **Check resolutions now** (which runs the identical check
immediately, on both backends) is the only way to resolve a trade there.

P&L uses the same buy-side formula as the profitability tracking in a later
section: for a stake `s` at entry price `p`, `payout = s / p` if the trade's
side won, else `0`; `profit = payout - s`.

### Suggested stake (Express/SQLite only)

Inside **Mark as traded**, a **Suggested stake** calculator offers three
methods, all configured in ⚙ **Settings → Bet sizing**:

- **Fractional Kelly** — enter your own estimated probability that the side
  you're trading wins; the suggestion is `((estimate - price) / (1 - price))
  × kellyFraction × bankroll` (the standard binary-Kelly formula, simplified
  for a share bought at `price` with a $1 payout on a win). A negative edge
  (your estimate is below the market price) suggests $0 rather than betting
  against your own edge. `kellyFraction` defaults to 0.25 (quarter-Kelly, a
  common way to reduce variance from full Kelly's aggressive sizing). This
  estimate is saved on the trade itself and feeds the average-edge/Brier-
  score calibration metrics under **Profitability tracking** below.
- **Flat stake** — always the same configured dollar amount.
- **Fixed percentage** — a fixed percentage of the configured bankroll,
  regardless of edge.

Every suggestion shows its full breakdown (edge, full-Kelly fraction, the
fraction actually applied, and the resulting dollar amount) before you click
**Use this stake** to copy it into the Stake field — nothing is auto-filled
without that click. The "bankroll" used for every method is your live
current bankroll balance (see below), not a value you edit here.

### Bankroll (Express/SQLite only)

⚙ **Settings → Bankroll** configures:

- **Starting bankroll amount** and **currency** — the baseline your bankroll
  is tracked from.
- **Max % of bankroll per bet** — a hard cap; **Mark as traded** rejects a
  stake larger than this percentage of your *current* bankroll balance
  (not the starting amount), with the dollar cap spelled out in the error.
- **Auto-deduct** — when on, recording a trade immediately debits its stake
  from the bankroll ledger; a win later credits the full payout back. When
  off, trades are tracked for P&L as usual but never touch the ledger.

The **My Trades** tab shows a dashboard above the trades table: current
**Bankroll** balance, **Staked** (sum of all open trades' stakes, with how
many are open), **Realized P&L** (sum of profit across every resolved
trade), and **Exposure** (staked as a % of the current bankroll). **Show
ledger** reveals every ledger entry (starting amount aside, each trade's
auto-deduct debit/credit plus any manual entries) and a form to record a
manual **deposit** or **withdrawal** — for cash added or removed outside
the app's own trade tracking. Deleting a trade also removes its ledger
entries, keeping the balance consistent.

The bankroll balance is always `startingAmount + sum(all ledger entries)`,
computed fresh on every read rather than stored as its own number, so it
can never drift out of sync with the ledger.

### Profitability tracking

Once you have at least one resolved (won/lost) trade, **My Trades** shows a
**Profitability** section below the bankroll dashboard (on the frozen
Vercel deploy, which has no bankroll dashboard — see **Bankroll** above —
this section appears on its own instead):

- **ROI** — total profit ÷ total staked, across every resolved trade.
- **Win rate** — won ÷ (won + lost).
- **Average edge** — the mean of (your estimated probability − the market
  price you paid) across trades that have an estimate recorded. This only
  counts trades placed via the Kelly calculator with a probability typed
  in (see **Suggested stake** above) — a trade sized by flat stake or fixed
  percentage, with no estimate entered, simply doesn't factor in here
  rather than being treated as a zero edge.
- **Brier score** — mean squared error between your estimated probability
  and the actual outcome (1 if won, 0 if lost) for those same trades. 0 is
  perfect calibration, 0.25 is what a constant "coin flip" forecast scores,
  1 is maximally wrong — lower is better.

Three charts visualize the same data: **cumulative P&L over time** (summed
in resolution order), **P&L by category** (bucketed by each market's first
tag, or "Uncategorized" if it has none), and a **calibration plot**
comparing, for each 10-point probability bucket among trades with an
estimate, your average forecast in that bucket against the actual win rate
— the two lines should track each other closely if your probability
estimates are well-calibrated.

**Export CSV** downloads every trade (all statuses, not just resolved ones)
with entry price, stake, estimated probability, payout, profit, and
timestamps.

There used to be a separate **Market Discovery** tab next to **All
Markets** (filter-configuration presets you could name, save, and re-run,
plus an audit trail of past fetches) layered on top of the market grid's
own filters above. It's been removed from the client — the underlying
saved-search/fetch-run tables, routes, and the scheduled-rerun poller still
exist on `server/` (Express/SQLite), just with no UI in front of them;
`/api/saved-searches` and `/api/fetch-runs` still respond there for anyone
calling them directly. The sidebar's **Run sync** (ad hoc, unsaved) still
works exactly as before on both backends.

## AI analysis (DeepSeek)

Selecting a market and clicking **Analyze with DeepSeek** in its detail panel
sends a prompt to DeepSeek's chat completions API and displays the reply. The
default prompt:

> Could you please analyze the real probability and analyze all the
> background information available for the following event at Polymarket:
> `{slug}`
>
> Market data:
> - YES price: `{yes_price}`
> - NO price: `{no_price}`
> - Resolution date: `{end_date}`
> - Liquidity: `{liquidity}`

The prompt is fully editable from the ⚙ **Settings** window — write whatever
you want and use any of the `{slug}`, `{yes_price}`, `{no_price}`,
`{end_date}`, `{liquidity}` placeholders anywhere in it; each is filled in
from the selected market when you click **Analyze with DeepSeek**. Click
**Save prompt** to store your version, or **Reset to default** to go back.

This needs a DeepSeek API key (get one at
[platform.deepseek.com](https://platform.deepseek.com)). Set it up either way:

- **In the app** — open ⚙ **Settings** (it shows a red dot when no key is
  configured), paste the key, and click **Save**. It's stored in the app's
  own database (SQLite locally, Postgres on Vercel) — no redeploy or restart
  needed, and it survives them. Use **Clear saved key** to remove it.
- **As an environment variable** — `DEEPSEEK_API_KEY`, set wherever the API
  runs (`export DEEPSEEK_API_KEY=sk-...` locally before `npm start`; under
  the service's environment variables on Render/Railway; under **Settings →
  Environment Variables** on Vercel). Used as a fallback whenever no key is
  saved in the app itself.

Optional overrides (environment variables only): `DEEPSEEK_MODEL` (default
`deepseek-flash`) and `DEEPSEEK_BASE_URL` (default
`https://api.deepseek.com`, for a proxy or compatible endpoint). With no key
configured either way, the button returns a clear "not configured" error
(with a link straight to Settings) instead of failing silently. A full
analysis can take a while — the Vercel function's `maxDuration` is set to
60s to give it room (still clamped lower on the Hobby plan).

### Model selection (Express/SQLite only)

`deepseek-chat`/`deepseek-reasoner` were retired; the ⚙ **Settings** window
now has a **DeepSeek model** section to choose between the current models
and a reasoning depth:

- **Model** — `deepseek-flash` or `deepseek-v4-pro`.
- **Reasoning effort** — **Non-thinking**, **Thinking** (default), or
  **Thinking (max)**, sent as the API's `reasoning_effort` parameter
  (`none`/`high`/`max`). Higher effort means a more thorough analysis at
  higher token cost and slower response.

The choice is saved server-side (same settings store as the API key/prompt)
and applies to every analysis until changed.

### Analysis history

Every analysis is kept, not just the latest one. A market's detail panel
shows:

- **Analyze with DeepSeek** — on the Express/SQLite backend, if an analysis
  already exists for the exact same market, prompt, model, and reasoning
  effort, it's served instantly from history instead of billing DeepSeek
  again ("from history (not re-billed)"); otherwise it calls DeepSeek and
  saves a new record. The frozen Vercel deploy always calls DeepSeek fresh
  (no cache-or-rebill choice, model/reasoning-effort selection, or cost
  estimate there) but does persist the result.
- **Re-run** (shown once at least one analysis exists) — always calls
  DeepSeek again and saves a new record, even if the inputs are identical to
  a previous run. Use this to get a fresh take, or after DeepSeek's answer
  seems stale.
- A **History** dropdown (once there's more than one analysis) to switch
  between past runs, each showing its timestamp, model, reasoning effort,
  token usage, and an estimated cost (the last three: Express/SQLite only).

The estimated cost is a rough budgeting figure computed from DeepSeek's
published per-token list pricing (which varies by peak/off-peak time and
cache hits) — not an accounting-accurate number.

**On the frozen Vercel deploy, "past analyses" only means this browser
tab's current session** — there's no `/api/markets/:slug/analyses` route
there (no Hobby-plan function budget left for it — see **Function count**
above), so the History dropdown and follow-up threading only see analyses
run since the page was last loaded, not ones from a previous visit.

### Prompt templates and follow-ups

⚙ **Settings** has a **Prompt templates** manager (Express/SQLite only)
instead of Phase 3's single prompt textarea: create, edit, and delete named
templates, and mark one as the default. A market's detail panel gets a
template picker next to **Analyze with DeepSeek** to use a specific template
for that run instead of the default — each saved analysis remembers which
template produced it. The frozen Vercel deploy has no template picker
(Settings falls back to the old single-prompt editor) and always uses that
single saved prompt.

Once an analysis exists, an **Ask a follow-up** box appears below it, on
both backends (on Vercel, only for an analysis run in the current session —
see **Analysis history** above). A follow-up sends DeepSeek the *entire
reconstructed conversation* — every ancestor's original prompt and reply,
in order — plus the new question, so it can build on that context rather
than starting cold. Each follow-up is its own new analysis row (never
served from cache, since it's a new question) linked to its parent; the
History dropdown marks
these with a "↳", and selecting one renders the whole thread from the root
down, labeling each turn ("Follow-up: <question>").

## Tests

Both `server/` and `client/` have an automated suite using Node's built-in
test runner (`node:test` — no extra dependency):

```bash
cd server && npm test   # upsert idempotency, per-trade P&L math, 2FA flow
cd client && npm test   # Kelly/flat/fixed-percentage stake calculations
```

Each writes to a temporary SQLite file (not `server/polymarket.db`) and
cleans up after itself. These cover the specific areas most likely to
silently break in a way that costs real money or locks someone out — the
upsert path every sync depends on, the resolution math a trade's profit
comes from, the stake-sizing formulas, and the login gate itself — rather
than being a full coverage suite.

## Database migrations (`server/`)

The Express/SQLite backend now tracks schema changes as numbered files in
`server/migrations/`, applied in order on startup and recorded in a
`schema_migrations` table — instead of the old pattern of inline
`CREATE TABLE IF NOT EXISTS` / conditional `ALTER TABLE` logic re-run on
every boot. Two file types:
- `NNN_name.sql` — plain DDL, executed verbatim.
- `NNN_name.cjs` — for migrations needing JS logic (e.g. backfilling data),
  exporting `up(db)`. `.cjs` specifically: this project is `"type": "module"`,
  and a plain `.js` file can't be `require`'d synchronously there, which
  `better-sqlite3`'s API needs.

Add a new migration by dropping a new numbered file in that folder — nothing
else to wire up. The **Vercel/Postgres path (`api/`, `lib/`) is not on this
migration system** and still uses its own inline `CREATE TABLE IF NOT
EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS` schema string; Express/SQLite
is the actively-developed target going forward, with Postgres parity treated
as a later porting pass rather than kept in lockstep with every change.

## Notes

- `better-sqlite3` (used by `server/`) is a native module. `npm install`
  normally grabs a prebuilt binary for your platform with no extra setup; if
  it ever tries to compile from source, you'll need a C++ toolchain and
  Python 3 available (Node's `node-gyp` requirements — see
  https://github.com/nodejs/node-gyp#installation if that happens).
- Re-running a sync without history enabled updates price/volume/liquidity
  but keeps any previously-computed min/max and CLOB token id — it won't
  overwrite good data with nulls. True on both `server/` (SQLite) and
  `api/` (Postgres).
- The Vercel/Postgres path (`api/`, `lib/db.js`) and the Express/SQLite path
  (`server/`) are two independent, parallel implementations of the same
  endpoints — kept in sync by hand, not shared code, since one speaks SQLite
  and the other Postgres. If you change one, remember to mirror the change
  in the other if you want both deploy targets to keep behaving identically.
- `@neondatabase/serverless`'s `Pool` uses HTTP under the hood rather than a
  persistent TCP connection, which is what makes it safe to use from
  short-lived serverless functions without a separate connection pooler.
