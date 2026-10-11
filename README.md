# GameFix Hub

PC repair and custom-build site with customer accounts, backed by Supabase.

The whole website is one self-contained file, `index.html`: no build step, no
framework, no dependency to install. Supabase supplies the accounts and the
database.

```
index.html                   the entire website
supabase/migrations/         database schema, policies and validation
worker/                      optional Cloudflare notifier (not required)
.github/workflows/pages.yml  publishes the site on every push
```

## What a visitor can do

- Plan a compatible build within a budget, and check parts for compatibility.
- Send a request as a guest, or create an account first.
- With an account: sign up, sign in, reset a forgotten password, see every
  request they have sent, and change their password.

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

Or paste `supabase/migrations/20261011090000_init.sql` into the SQL editor. It
is additive and idempotent, so running it twice is harmless.

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

## Security model

Everything the browser can do is decided by the database, not by the page. It
is worth knowing exactly what is exposed:

| Who | Can do |
| --- | --- |
| Anyone (no account) | Submit a request through `submit_enquiry()`. Nothing else. |
| Signed-in customer | The above, plus read **their own** requests. |
| Nobody with the publishable key | Read anyone else's request, change or delete anything, or write to `enquiries` directly. |
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

## Tests

There is no test runner to install. Verification here is done against the live
project:

- `worker/test-api.mjs` exercises the optional Cloudflare notifier (42 checks).
- The website itself was verified in a browser: signing up, signing in, wrong
  passwords, the forgot-password request, submitting a request end to end
  through the database function, and confirming that a second account cannot
  see the first account's requests.

## If a key is ever exposed

Rotate it. Removing a file does not remove it from git history.

- Database password: Supabase → Settings → Database → Reset password.
- API keys: Settings → API → rotate. `service_role` must never be in the browser.
