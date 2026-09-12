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
  badge instead of a last-updated time. Click any row to open its detail
  panel below.
- **Bulk price update** — check one or more rows, then click **Update
  selected prices** to re-fetch just those markets' current price, volume,
  and liquidity from Polymarket without re-running a full sync. Any
  previously-computed min/max and CLOB token id are left untouched.
- **Detail panel** — Yes/No price, volume, liquidity, resolution date, a
  **Related markets in this event** list (other markets sharing the same
  Polymarket event, e.g. other candidates in the same election — click one
  to jump straight to it), a **Load price history chart** button, and an
  **Analyze with DeepSeek** button (see below).
- **Export CSV** in the sidebar downloads everything currently stored.

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
`deepseek-chat`) and `DEEPSEEK_BASE_URL` (default
`https://api.deepseek.com`, for a proxy or compatible endpoint). With no key
configured either way, the button returns a clear "not configured" error
(with a link straight to Settings) instead of failing silently. A full
analysis can take a while — the Vercel function's `maxDuration` is set to
60s to give it room (still clamped lower on the Hobby plan).

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
