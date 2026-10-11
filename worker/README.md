# GameFix Hub backend

A single Cloudflare Worker that serves the website, accepts the request form,
stores every enquiry in a database and emails you when one arrives. It also
gives you a private page to read and triage them.

There is no framework and no runtime dependency — one Worker file, plain
`fetch`, plain SQL. Everything the site already did (build planner,
compatibility checker, email/WhatsApp hand-off) still works exactly as before,
and still works if you host only `index.html` somewhere else with no server at
all: the form then falls back to preparing the message in the browser.

```
worker/
  src/worker.js     the whole backend (API + dashboard)
  build.mjs         copies ../index.html into ./public
  test-api.mjs      42 end-to-end checks
  wrangler.jsonc    bindings and public settings
  .dev.vars.example copy to .dev.vars and fill in your secrets
```

## Run it locally

```bash
cd worker
npm install
npm run dev          # builds ./public, then serves http://127.0.0.1:8787
```

Then open <http://127.0.0.1:8787>. The site is live, and the form really
submits. Your inbox is at <http://127.0.0.1:8787/dashboard>.

On the first run, `npm run dev` needs a token. Copy the example file and set
one:

```bash
cp .dev.vars.example .dev.vars
```

```ini
ADMIN_TOKEN=some-long-random-string-you-invent
RESEND_API_KEY=
```

`ADMIN_TOKEN` is the password for `/dashboard`. Make it long and random, and
keep it out of chat, screenshots and version control — `.dev.vars` is already
gitignored. Leaving `RESEND_API_KEY` empty is fine: requests are still stored
and shown in the dashboard, they just do not send email.

## Email notifications

[Resend](https://resend.com) is used because it needs a single API key and its
free tier covers a small business comfortably.

1. Create an account and an API key at <https://resend.com/api-keys>.
2. Put it in `.dev.vars` as `RESEND_API_KEY` (local) — the form then notifies
   you on every submission.
3. Until you own a domain, the shared sender `onboarding@resend.dev` only
   delivers to the address you signed up with, which is exactly what you want
   while testing. `MAIL_TO` is already set to your inbox.

## Deploying

You need two Cloudflare secrets and a real database. Nothing here is stored in
the repository.

```bash
cd worker
npx wrangler login                 # once
npx wrangler d1 create gamefix-hub # prints a database_id
# paste that id into wrangler.jsonc, then:
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RESEND_API_KEY
npm run deploy
```

The database tables are created automatically on the first request, so there is
no migration step to forget. `npm run deploy` copies `../index.html` into
`./public` first, so the site you see locally is the site you ship.

## Tests

With `npm run dev` running in another terminal:

```bash
ADMIN_TOKEN=<your .dev.vars token> npm run test:api
```

42 checks cover validation, storage, the dashboard session, CSV export, the
throttle and the request form's own service list. The suite cleans up after
itself and is safe to re-run. It only ever deletes rows at `@example.com`.
Point it at a deployment with `BASE=https://…`.

## API

| Method | Path | Who | What |
| --- | --- | --- | --- |
| `POST` | `/api/enquiry` | public | Submit a request. Rate-limited, honeypot-protected, same-origin only. |
| `POST` | `/dashboard/session` | public | Sign in with the admin token. |
| `DELETE` | `/dashboard/session` | signed in | Sign out. |
| `GET` | `/dashboard` | signed in | The request inbox. |
| `GET` | `/api/enquiries` | signed in | List and search requests. `?status=` `?q=` `?limit=` |
| `GET` | `/api/stats` | signed in | Totals, unread, urgent, won. |
| `GET` | `/api/export.csv` | signed in | Download everything as CSV. |
| `PATCH` | `/api/enquiry/:id` | signed in | Change status or notes. |
| `DELETE` | `/api/enquiry/:id` | signed in | Delete a request. |
| `DELETE` | `/api/rate-limits` | signed in | Clear the throttle, e.g. to unblock a customer who clicked send too often. |

## How it is protected

- The dashboard is a signed, `HttpOnly`, `SameSite=Strict` session cookie —
  12 hours, no token in the page, nothing in `localStorage`.
- Every read and write of enquiry data requires that session; an anonymous
  caller gets `401` for any `/api/*` path, including ones that do not exist, so
  the API cannot be mapped from outside.
- Cross-origin writes are refused with `403`; the form must come from the site.
- Submissions are rate-limited per IP (6 an hour) and a hidden honeypot field
  catches simple bots.
- IP addresses are stored only as a salted SHA-256 hash, never in the clear.
- Sign-in failures are slowed down, and the token is compared in constant time.
