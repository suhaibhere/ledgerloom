# LedgerLoom

LedgerLoom is a full-stack personal expense application with account registration, authenticated sessions, user-scoped SQLite or PostgreSQL records, UPI statement imports, and deterministic spending analysis. It does not connect to banks or UPI accounts.

## Run locally

1. Install Node.js 24 or later.
2. Run `npm install` and `npm start` in this folder (or open **Open LedgerLoom.bat**).
3. Visit the URL printed in the terminal (normally http://127.0.0.1:4173) and create an account. If that port is occupied, LedgerLoom automatically tries the next available port.

Without `DATABASE_URL`, the server creates `data/ledgerloom.sqlite` and applies local migrations on first startup. Set `DATABASE_URL` to use PostgreSQL. Each user's transactions and receipt records are scoped to their authenticated account. Passwords use scrypt hashes; session cookies are HttpOnly, SameSite Strict, and backed by hashed expiring session tokens. New accounts contain no transactions.

## Free public hosting (Render + Supabase)

The app can use Render for the Node web service and Supabase PostgreSQL for durable database storage. Render's free web service has an ephemeral filesystem, so do not deploy the SQLite database there. Receipt bytes are stored in PostgreSQL when `DATABASE_URL` is configured.

1. Create a Supabase project and copy its **Session pooler** PostgreSQL connection string from **Project Settings → Database → Connection string**. Keep it private.
2. In Render, create a Web Service for this GitHub repository. Use build command `npm install` and start command `npm start`.
3. Add these Render environment variables: `NODE_ENV=production`, `SESSION_SECRET` (a random secret of at least 32 characters), and `DATABASE_URL` (the Supabase connection string). Render supplies `PORT`; leave `DATABASE_PATH` unset.
4. To enable Money Coach chat, create a Gemini API key in Google AI Studio and add `GEMINI_API_KEY` as a private Render environment variable. Optionally set `GEMINI_MODEL` (default `gemini-3.5-flash-lite`). Never put the key in frontend code or commit it.
5. Deploy. On first start, LedgerLoom creates its PostgreSQL tables and indexes. Open the Render URL and register an account.
6. Check `/api/health`; it should report `database: postgres`. Import the sample statement and confirm the dashboard updates before sharing the link.

The Render free service sleeps after inactivity, so its first request may take about a minute. Supabase may pause free projects after a week of low activity. Free tiers have limits and are suitable for a student/portfolio launch, not a guaranteed-uptime production finance service. Existing local SQLite records are not automatically copied to PostgreSQL.

## Features

- Account registration with full name, email, password confirmation, login, logout, and persisted sessions.
- User-scoped transaction CRUD, filtering, searching, sorting, and pagination.
- CSV and XLSX UPI/bank statement import with date and amount normalization, merchant recognition, income/refund/transfer classification, categorization, and duplicate skipping.
- Dashboard totals, category and merchant breakdowns, daily/monthly charts, recurring-pattern detection, and evidence-backed deterministic observations calculated from saved records.
- Money Coach offers general-purpose Gemini chat with a user-selectable Gemini 3.5 Flash-Lite or Gemini 3.8 Flash model. Messages and recent chat history are sent to Google; the chat visibly discloses this. LedgerLoom transaction data is not included in the request. Google may use free-tier content to improve its products.
- Category corrections saved per user and reused during later imports.
- Receipt image/PDF upload validation and private storage. OCR is not configured; uploaded receipts are marked for manual review.

## Data and configuration

Copy `.env.example` to `.env` to set the host, port, database path, optional PostgreSQL URL, session secret, or optional Gemini server key. Never publish `.env` or the SQLite data directory. Local mode binds to `127.0.0.1`; hosted deployment needs HTTPS and a strong `SESSION_SECRET`.

## Limits

PDF statement parsing and receipt OCR are not implemented. Gemini chat requires an owner-provided API key and may be subject to Google rate limits and data-use terms. Without a Gemini API key, chat is unavailable. AI responses may be inaccurate and do not provide professional financial advice. The app can be deployed as a small web service but is not hardened for large-scale financial-data hosting.

## Tests

Run `npm test` for parser, categorization, recurrence and analytics tests plus isolated API integration tests. Run `npm run build` for syntax and required-file checks.
