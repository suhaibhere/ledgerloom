# LedgerLoom

LedgerLoom is a local full-stack personal expense application with account registration, authenticated sessions, private SQLite records, UPI statement imports, and deterministic spending analysis. It does not connect to banks or UPI accounts.

## Run locally

1. Install Node.js 24 or later.
2. Run `npm install` and `npm start` in this folder (or open **Open LedgerLoom.bat**).
3. Visit the URL printed in the terminal (normally http://127.0.0.1:4173) and create an account. If that port is occupied, LedgerLoom automatically tries the next available port.

The server creates `data/ledgerloom.sqlite` and applies migrations on first startup. Each user's transactions and receipt records are scoped to their authenticated account. Passwords use scrypt hashes; session cookies are HttpOnly, SameSite Strict, and backed by hashed expiring session tokens. New accounts contain no transactions.

## Make it available online

To let other people use LedgerLoom, deploy it as a Node web service with persistent storage. For example, on Render:

1. Put the `ledgerloom` project folder in a GitHub repository and push it to your account.
2. In Render, create a Web Service connected to that repository. Set the build command to `npm install` and start command to `npm start`.
3. Set these environment variables in the hosting dashboard: `NODE_ENV=production`, `HOST=0.0.0.0`, `DATABASE_PATH=/var/data/ledgerloom.sqlite`, and `SESSION_SECRET` to a randomly generated value of at least 32 characters. The host supplies `PORT`.
4. Attach persistent storage mounted at `/var/data`. The SQLite database and uploaded receipt files live there. Without persistent storage, host files may be erased during deploy or restart. Check the host's current plan and disk costs before creating the service.
5. Deploy, open the provided HTTPS address, register a new account, and test imports and account isolation before sharing the link.

LedgerLoom binds to `127.0.0.1` for local use and can bind to `0.0.0.0` when configured for hosting. One SQLite-backed service suits a small project or portfolio launch. A larger public service should move to managed PostgreSQL and add monitoring, backups, abuse controls, and a privacy policy. Review these requirements before accepting real financial data from the public.

## Features

- Account registration with full name, email, password confirmation, login, logout, and persisted sessions.
- User-scoped transaction CRUD, filtering, searching, sorting, and pagination.
- CSV and XLSX UPI/bank statement import with date and amount normalization, merchant recognition, income/refund/transfer classification, categorization, and duplicate skipping.
- Dashboard totals, category and merchant breakdowns, daily/monthly charts, recurring-pattern detection, and evidence-backed deterministic observations calculated from saved records.
- Category corrections saved per user and reused during later imports.
- Receipt image/PDF upload validation and private storage. OCR is not configured; uploaded receipts are marked for manual review.

## Data and configuration

Copy `.env.example` to `.env` to set the host, port, database path, or session secret. Never publish `.env` or the SQLite data directory. Local mode binds to `127.0.0.1`; online deployment needs HTTPS, persistent storage, a strong `SESSION_SECRET`, backups, and a separate security review.

## Limits

PDF statement parsing and receipt OCR are not implemented. The app uses deterministic rules and does not require an AI API. It can be deployed as a small web service but is not hardened for large-scale financial-data hosting.

## Tests

Run `npm test` for parser, categorization, recurrence and analytics tests plus isolated API integration tests. Run `npm run build` for syntax and required-file checks.
