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

Either way, once it's up: open the URL, click **Run sync** in the sidebar,
and you're browsing live Polymarket data in the deployed app.

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
npm start
```
This listens on `http://localhost:3001` and creates `server/polymarket.db`
(SQLite) on first run.

**Terminal 2 — start the UI:**
```bash
cd client
npm install
npm run dev
```
Open the URL it prints (typically `http://localhost:5173`). The dev server
proxies `/api/*` requests to the Express server, so both need to be running.

## Using it

- **Sidebar** — set how many markets to fetch; a market status filter (active
  only, closed only, or both); a category/tag to scope the sync to (populated
  from whatever's already been synced); a resolution date range to only sync
  markets resolving in that window; and whether to also fetch price history
  (needed for the min/max columns and the chart — it's slower, one extra API
  call per market, with an editable delay between those calls to stay easy on
  Polymarket's API). Click **Run sync** and a progress bar tracks it live.
- **Market grid** — search by keyword, filter by status, filter by minimum
  volume, filter by price range (min/max current Yes price), and filter by
  category/tag (populated from whatever's been synced). Markets that share a
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

## Trades and P&L (Express/SQLite only)

Click **Mark as traded** on a market's detail panel to record a manual
trade: side (Yes/No, pre-filling that side's current price as the entry
price — editable), stake, and an optional note. The **My Trades** tab lists
every recorded trade with tabs for All/Open/Won/Lost, a running net P&L
total, and a **Check resolutions now** button.

Trades resolve automatically: an in-process check (same interval approach
as Market Discovery's scheduled reruns) runs every 60 seconds, refreshes
the price/closed status of any market with an open trade, and — once that
market is closed and its Yes price has settled to (near) 0 or 1, matching
how Polymarket represents a final outcome — marks each open trade **Won**
or **Lost** based on which side actually won. **Check resolutions now**
runs the same check immediately instead of waiting for the next tick.

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
  common way to reduce variance from full Kelly's aggressive sizing).
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

## Market Discovery (Express/SQLite only)

The **Market Discovery** tab (next to **All Markets**) is a configurable
screen for building and reusing catalog-fetch filters, separate from the
sidebar's quick "Run sync":

- **Filters** — status (active/resolved/all), category/tag, a resolution
  date range, minimum volume, minimum liquidity, and a keyword match against
  the market question. These apply at fetch time (skipping non-matching
  markets before they're upserted), not as a display-only filter.
- **Save search** — name the current filter combination and click **Save
  search** to keep it for reuse; it appears in the **Saved searches** table
  below with **Run** (fetch now, using that search's filters) and **Delete**.
- **Fetch now** — runs the current filters immediately without saving them,
  the same idempotent upsert used everywhere else (existing markets are
  updated in place by slug; new ones are inserted — nothing is duplicated on
  a rerun).
- **Scheduled reruns (optional)** — set "Auto re-run every N minutes" when
  saving a search to have the server itself rerun it on that interval, via
  an in-process scheduler (checked once a minute) — no separate job queue.
  Leave it blank for manual-only. This only runs while the server process
  stays up; there's no persistent external cron.
- **Fetch run history** — every fetch (ad hoc, saved-search, or scheduled)
  is recorded with its start time, status, filters, and how many markets
  were added vs. updated, shown in the **Recent fetch runs** table.

This tab, saved searches, and fetch-run auditing are **only implemented on
the Express/SQLite backend** — they call `/api/saved-searches` and
`/api/fetch-runs`, which don't exist on the frozen Vercel/Postgres deploy.
The screen degrades gracefully there (shows "not available on this deploy
target" instead of breaking) rather than erroring out.

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

### Analysis history (Express/SQLite only)

Every analysis is now kept, not just the latest one. A market's detail panel
shows:

- **Analyze with DeepSeek** — if an analysis already exists for the exact
  same market, prompt, model, and reasoning effort, it's served instantly
  from history instead of billing DeepSeek again ("from history (not
  re-billed)"). Otherwise it calls DeepSeek and saves a new record.
- **Re-run** (shown once at least one analysis exists) — always calls
  DeepSeek again and saves a new record, even if the inputs are identical to
  a previous run. Use this to get a fresh take, or after DeepSeek's answer
  seems stale.
- A **History** dropdown (once there's more than one analysis) to switch
  between past runs, each showing its timestamp, model, reasoning effort,
  token usage, and an estimated cost.

The estimated cost is a rough budgeting figure computed from DeepSeek's
published per-token list pricing (which varies by peak/off-peak time and
cache hits) — not an accounting-accurate number. This history and caching
behavior is **Express/SQLite only**; the frozen Vercel deploy still returns
a single uncached analysis per click.

### Prompt templates and follow-ups (Express/SQLite only)

⚙ **Settings** has a **Prompt templates** manager instead of Phase 3's
single prompt textarea: create, edit, and delete named templates, and mark
one as the default. A market's detail panel gets a template picker next to
**Analyze with DeepSeek** to use a specific template for that run instead of
the default — each saved analysis remembers which template produced it.

Once an analysis exists, an **Ask a follow-up** box appears below it. A
follow-up sends DeepSeek the *entire reconstructed conversation* — every
ancestor's original prompt and reply, in order — plus the new question, so
it can build on that context rather than starting cold. Each follow-up is
its own new `ai_analysis` row (never served from cache, since it's a new
question) linked to its parent; the History dropdown marks these with a
"↳", and selecting one renders the whole thread from the root down,
labeling each turn ("Follow-up: <question>").

Both features are **Express/SQLite only** — on the frozen Vercel deploy,
the template picker and follow-up box simply don't appear (Settings falls
back to the old single-prompt editor), and "Analyze" behaves as it did in
Phase 3.

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
