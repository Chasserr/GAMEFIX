# GameFix Hub

PC repair and custom-build site with customer accounts, backed by Supabase.

The whole website is one self-contained file, `index.html`: no build step, no
framework, no dependency to install. Supabase supplies the accounts and the
database.

```
index.html                   the entire website, admin panel included
supabase/migrations/         database schema, policies and validation
supabase/verify-*.mjs        live checks for accounts and admin access
worker/                      optional Cloudflare notifier (not required)
.github/workflows/pages.yml  publishes the site on every push
```

## What a visitor can do

- Plan a compatible build within a budget, and check parts for compatibility.
- Send a request as a guest, or create an account first.
- With an account: sign up, sign in, reset a forgotten password, see every
  request they have sent, and change their password.

## What the owner can do

A full-screen admin panel, opened from the account panel and visible only to an
account listed in `public.admins` (see below):

- Every customer request in one list, newest first, with a live summary strip
  (total, unread, urgent, won, last seven days, how many came from accounts).
- Search across name, email, reference and the message itself, and filter by
  status, urgency and age. Archived requests are hidden until asked for.
- A detail pane with the full message, the attached build plan, contact links
  (email, `tel:`, WhatsApp) and whether the sender had an account.
- A status workflow - new, read, replied, won, archived - plus private notes,
  and "mark shown as read" to clear a batch in one go.
- Export the current filter to a spreadsheet.
- Delete a request, behind a confirmation.

## Setup

### 1. Point the site at your project

The project URL and the **publishable** key live at the top of the module at
the bottom of `index.html`:

```js
const SUPABASE_URL = "https://<your-project>.supabase.co";
const SUPABASE_KEY = "sb_publishable_...";
```

Both of these are designed to be public and are safe to ship in a web page -
they are protected by row level security (see below). What must **never** be in
this repository or in the page: the database password, and the `service_role`
key, which bypasses every security rule.

### 2. Create the database objects

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

That applies both files in `supabase/migrations/`: `..._init.sql` (the enquiries
table, its policies and `submit_enquiry()`) and `..._admin.sql` (the admins
table, `is_admin()`, and the wider rules they unlock). Paste them into the SQL
editor in that order if you prefer. Both are additive and idempotent, so running
them twice is harmless.

### 3. Allow your own URL (do not skip this)

**Authentication → URL Configuration.** Without this, confirmation and password
reset links send people to the wrong place.

- **Site URL**: where the site really lives, e.g.
  `https://<user>.github.io/GAMEFIX/`
- **Redirect URLs**: add the same address. A link is only honoured if the exact
  URL is listed here.

### 4. Turn on real email delivery (do not skip this either)

**Authentication → Emails → SMTP Settings.**

Supabase's built-in mail service is for testing only: it is capped at a couple
of messages per hour and, by default, only delivers to addresses on your own
project team. Until you connect your own SMTP provider, **new sign-ups and
password reset emails will fail** for real customers, and Supabase returns
"email rate limit exceeded" once the hourly cap is reached. The site turns that
into a plain-English message rather than a raw error, but the fix is to connect
SMTP.

## Becoming an admin

Membership is a row in `public.admins`, and only you can add one - the table
has no policies and no privileges for the browser, so the panel cannot promote
anyone, not even itself. Sign up normally first, confirm your email, then run
this once in the Supabase SQL editor (replace the address):

```sql
insert into public.admins (user_id, label)
select id, 'Mesha' from auth.users where email = 'you@example.com'
on conflict (user_id) do nothing;
```

To remove someone, or yourself: `delete from public.admins where user_id =
(select id from auth.users where email = 'you@example.com');`

Access is read per query, so removing a row takes effect on the next click -
there is no session to wait out and nothing to sign out of. Sign out and back
in after adding yourself, and **Open admin panel** appears in your account
panel.

## Security model

Everything the browser can do is decided by the database, not by the page. It
is worth knowing exactly what is exposed:

| Who | Can do |
| --- | --- |
| Anyone (no account) | Submit a request through `submit_enquiry()`. Nothing else. |
| Signed-in customer | The above, plus read **their own** requests. Cannot edit or delete anything - not even their own rows. |
| Admin | Read every request, move it through the workflow, leave a note, delete it. Still cannot rewrite what a customer wrote. |
| Nobody with the publishable key | Read anyone else's request, alter the content of a request, or add themselves to `admins`. |
| You, with the `service_role` key | Everything, including the Supabase Table Editor. |

The specifics:

- `enquiries` has row level security enabled and exactly one policy - read your
  own rows. There is no insert, update or delete policy, so those are refused
  outright.
- The table privileges are revoked from `anon` entirely and cut down to `select`
  for `authenticated`, so this does not depend on policies alone. Attempting a
  direct write returns `401 permission denied`.
- Requests are created only by `submit_enquiry()`, a `security definer` function
  with a pinned `search_path`. It validates everything on the server - name
  length, email shape, message length, urgency, reply method - and normalises
  what it stores. A caller cannot attach a request to somebody else's account:
  `user_id` comes from `auth.uid()`, never from the request.
- `admins` holds one row per admin account, has RLS enabled with **no
  policies at all**, and no table privileges for `anon` or `authenticated`.
  The only way to read it is `is_admin()`, which answers solely about the caller.
- Admin writes are checked twice: the `UPDATE` privilege is granted on the
  `status` and `notes` columns only, so the message, email, phone and budget a
  customer supplied cannot be edited from a browser; and the update policy
  requires `is_admin()`. A customer calling the same endpoint updates zero rows.
- `enquiry_stats` is a view, and a Postgres view normally runs with the
  privileges of its owner - which would leak every customer's totals to anyone
  signed in. It is set to `security_invoker = true` so the row level security
  above decides what each person counts.
- The function also throttles: at most 5 requests per email address per hour.
- The site never stores a password, token or key in `localStorage`. Supabase
  manages the session; only the site's own draft, saved list and request history
  are kept locally.

## The request pipeline

The form tries, in order:

1. **Supabase** - validated and stored, and the visitor gets a reference number.
2. **The optional Worker** - only if it is deployed, and only if Supabase is
   unreachable. See `worker/README.md`.
3. **Email or WhatsApp** - if neither is available, the request is prepared in
   the browser for the visitor to send themselves. Nothing is ever lost.

A hidden field catches simple bots: it is filled in, the submission is quietly
accepted and nothing is stored.

## Deploying the site

Push to `main` and `.github/workflows/pages.yml` publishes `index.html` to
GitHub Pages. Turn it on once under **Settings → Pages → Source: GitHub
Actions**, then add the resulting URL to the Supabase redirect list (step 3).

## Monitoring

Nothing watched the site, so a failure would have been noticed by a customer
first. Three layers cover different failures.

### 1. The built-in check - already on

`.github/workflows/monitor.yml` runs every 30 minutes and checks the published
page, the Supabase auth endpoint, and a read-only database call. It re-reads the
publishable key out of `index.html` and uses that exact key, so a rotated or
mistyped key is caught here rather than by a customer.

A failure opens an issue labelled `monitor-alert`, which GitHub emails to you.
When everything passes again the issue is closed, so **the open or closed state
of that issue is the current health of the site**. Run it by hand from
**Actions → Monitor site and backend → Run workflow**.

Two limits worth knowing:

- It runs on GitHub, so it cannot tell you that GitHub itself is unreachable.
- GitHub disables a scheduled workflow after 60 days with no push to the
  repository. It emails you when it does; press **Enable workflow** on the
  Actions tab to bring it back.

### 2. An outside check - recommended, about five minutes

Because the check above lives on GitHub, add one that lives somewhere else.
[UptimeRobot](https://uptimerobot.com) has a free tier of 50 monitors on
5-minute checks with email alerts:

| Monitor | Type | URL |
| --- | --- | --- |
| GameFix Hub | HTTP(s) | `https://chasserr.github.io/GAMEFIX/` |
| GameFix Hub API | HTTP(s) | `https://mggokcssqghstlypdoub.supabase.co/auth/v1/settings` |

For the second, add a custom request header `apikey` holding the publishable key
from `index.html`. Without it Supabase answers `401`, which would look like an
outage.

### 3. Browser errors - inert until you add a DSN

Neither check above can see a feature that silently breaks for some visitors.
The `errors` block near the top of `index.html` reports JavaScript errors from
real browsers, and does nothing at all until it is given a DSN: while the value
is empty, no script is loaded and nothing is sent.

To switch it on, create a free project at [sentry.io](https://sentry.io), then
**Settings → Projects → your project → Client Keys**, and paste the DSN into
`window.gfhSentryDsn` at the top of that block. That is the only change needed.

A DSN is a public key - it can submit events to your project, not read them - so
it is safe in page source. The block opts out of the identity data the SDK
collects by default, because this site handles names, emails and phone numbers.

## Tests

Verification here runs against the live project rather than mocks.

### Admin access (30 checks)

```bash
cd supabase
SUPABASE_DB_URL="postgresql://postgres:<your-database-password>@db.<project-ref>.supabase.co:5432/postgres" npm run verify:admin
```

`supabase/verify-admin.mjs` tests the rules as the attacker rather than as the
intended user: an anonymous visitor, then a signed-in customer who tries to read
somebody else's request, change its status, delete it, rewrite its message, and
promote themselves to admin - and finally the same account after being added to
`public.admins`, then after being removed again. It confirms each refusal
against the database rather than trusting the HTTP status, because a request
blocked by row level security still answers `204`.

### Accounts, sign-in and data isolation (26 checks)

```bash
cd supabase
npm install
SUPABASE_DB_URL="postgresql://postgres:<your-database-password>@db.<project-ref>.supabase.co:5432/postgres" npm run verify
```

`supabase/verify-auth.mjs` signs in, rejects wrong passwords and unknown
accounts, submits a request as a signed-in customer, proves a second account
cannot see the first account's requests, requests a password reset, sets a new
password and signs out. It creates its own test accounts, removes them again,
and refuses to touch anything outside `@gfh-verify.dev`.

> The connection string is a secret. Pass it in the environment only. Getting
> it: Supabase dashboard → Settings → Database → Connection string (URI).

The one step it cannot do is click the confirmation link in an email, so it
creates its confirmed account directly in the database. That is test-only code -
application code must use the sign-up endpoint.

If the suite reports `NOT SENT - over_email_send_limit`, SMTP is not connected
yet (step 4 above).

### The optional notifier

- `worker/test-api.mjs` exercises the optional Cloudflare notifier (42 checks).

### The site

The page itself was driven in a real browser against a plain static server (the
shape GitHub Pages serves): creating an account, signing in, the forgot-password
form, submitting a request end to end and seeing it appear under **Your
requests**, and signing out - with a clean console apart from the deliberate
rejections.

## If a key is ever exposed

Rotate it. Removing a file does not remove it from git history.

- Database password: Supabase → Settings → Database → Reset password.
- API keys: Settings → API → rotate. `service_role` must never be in the browser.
