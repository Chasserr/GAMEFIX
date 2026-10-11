/**
 * End-to-end API test. Run against a live local Worker:
 *
 *   npm run dev            (in one terminal)
 *   npm run test:api       (in another)
 *
 * Override the target with BASE=https://your-worker.workers.dev
 */

import fs from 'node:fs';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN;

let passed = 0;
let failed = 0;
let cookie = '';

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  \u2713 ' + name);
  } else {
    failed += 1;
    console.log('  \u2717 ' + name + (detail ? '  -> ' + detail : ''));
  }
}

async function call(path, options = {}) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, body, headers: res.headers };
}

const sample = (over = {}) => ({
  name: 'Marta Ruiz',
  email: 'marta@example.com',
  phone: '+34 600 111 222',
  service: 'PC Building',
  budget: 'EUR 1,200',
  urgency: 'soon',
  contactBy: 'whatsapp',
  message: 'I would like a 1440p gaming build with a quiet case please.',
  buildSummary: 'Ryzen 5 + RTX 4060 Ti, 32GB DDR5',
  parts: [{ category: 'GPU', name: 'RTX 4060 Ti', price: 399 }],
  ...over,
});

console.log('\nGameFix Hub API tests  ->  ' + BASE + '\n');

/* ---------------------------------------------------------------- public */

console.log('Public endpoints');

const unauth = await call('/api/enquiries');
check('list is rejected without a session', unauth.status === 401, 'got ' + unauth.status);

const bad = await call('/api/stats');
check('stats is rejected without a session', bad.status === 401, 'got ' + bad.status);

const crossOrigin = await call('/api/enquiry', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  body: JSON.stringify(sample()),
});
check('cross-origin submit is blocked', crossOrigin.status === 403, 'got ' + crossOrigin.status);

// The auth gate deliberately runs before route matching, so an anonymous
// caller cannot map the API by diffing status codes.
const noSuchRoute = await call('/api/nope');
check('unknown api route is hidden behind the auth gate', noSuchRoute.status === 401, 'got ' + noSuchRoute.status);

const honeypot = await call('/api/enquiry', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(sample({ website: 'http://spam.example' })),
});
check('honeypot is silently accepted', honeypot.status === 200 && honeypot.body?.id === 'ignored', JSON.stringify(honeypot.body));

const invalid = await call('/api/enquiry', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'x', email: 'not-an-email', service: 'Nope', message: 'hi' }),
});
check('invalid submission is 422', invalid.status === 422, 'got ' + invalid.status);
check(
  'validation names the bad fields',
  /name/.test(invalid.body?.error || '') && /email/.test(invalid.body?.error || ''),
  invalid.body?.error,
);

const malformed = await call('/api/enquiry', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{not json',
});
check('malformed body is 400', malformed.status === 400, 'got ' + malformed.status);

const missingBits = await call('/api/enquiry', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(sample({ phone: '', contactBy: 'whatsapp' })),
});
check('whatsapp without a phone number is rejected', missingBits.status === 422, 'got ' + missingBits.status);

/* ------------------------------------------------------------ submission */

console.log('\nSubmission');

if (!TOKEN) {
  console.log('  ! ADMIN_TOKEN not set in the environment - skipping the signed-in tests.');
  console.log('    Re-run with ADMIN_TOKEN="<your .dev.vars token>" npm run test:api\n');
} else {
  const login = await call('/dashboard/session', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'definitely-wrong' }).toString(),
  });
  check('wrong admin token is refused', login.status === 401, 'got ' + login.status);

  const good = await call('/dashboard/session', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TOKEN }).toString(),
  });
  const setCookie = good.headers.get('set-cookie') || '';
  cookie = setCookie.split(';')[0];
  check('correct token signs in', good.status === 303 && cookie.includes('gfh_admin'), 'got ' + good.status);
  check('session cookie is HttpOnly', /HttpOnly/i.test(setCookie), setCookie);
  check('session cookie is SameSite=Strict', /SameSite=Strict/i.test(setCookie), setCookie);

  // Start from a clean throttle window so the suite is repeatable.
  const reset = await call('/api/rate-limits', { method: 'DELETE' });
  check('admin can clear the throttle table', reset.status === 200, 'got ' + reset.status);

  const submit = await call('/api/enquiry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sample()),
  });
  check('valid submission is stored', submit.status === 200 && String(submit.body?.id || '').startsWith('GFH-'), JSON.stringify(submit.body));
  const ref = submit.body?.id;

  const list = await call('/api/enquiries?limit=50');
  const found = (list.body?.enquiries || []).find((r) => r.id === ref);
  check('it appears in the inbox', Boolean(found), 'ref ' + ref);
  check('the attached build plan survived', found?.build_summary === sample().buildSummary, found?.build_summary);
  check('the attached parts survived', String(found?.parts_json || '').includes('RTX 4060 Ti'), found?.parts_json);
  check('phone number is preserved', found?.phone === '+34600111222', found?.phone);
  check('status starts as new', found?.status === 'new', found?.status);

  const search = await call('/api/enquiries?q=Marta');
  check('search by name finds it', (search.body?.enquiries || []).some((r) => r.id === ref));

  const noMatch = await call('/api/enquiries?q=zzzznobody');
  check('search with no match returns nothing', (noMatch.body?.enquiries || []).length === 0);

  const patched = await call('/api/enquiry/' + ref, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'replied', notes: 'Quoted EUR 1,180' }),
  });
  check('status can be updated', patched.status === 200, 'got ' + patched.status);

  const reread = await call('/api/enquiries?status=replied');
  check('the inbox filter reflects it', (reread.body?.enquiries || []).some((r) => r.id === ref));

  const badStatus = await call('/api/enquiry/' + ref, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'banana' }),
  });
  check('an unknown status is refused', badStatus.status === 422, 'got ' + badStatus.status);

  const authedMissing = await call('/api/nope');
  check('an unknown api route is 404 once signed in', authedMissing.status === 404, 'got ' + authedMissing.status);

  const stats = await call('/api/stats');
  check('stats report a total', (stats.body?.totals?.total || 0) >= 1, JSON.stringify(stats.body?.totals));

  const csv = await call('/api/export.csv');
  check('csv export returns rows', csv.status === 200 && String(csv.body).includes('contact_by'), 'status ' + csv.status);
  check('csv export is an attachment', /attachment/.test(csv.headers.get('content-disposition') || ''));

  const dashboard = await call('/dashboard');
  check('dashboard renders for a signed-in admin', dashboard.status === 200 && String(dashboard.body).includes('Request inbox'), 'got ' + dashboard.status);

  const anonymousDashboard = await fetch(BASE + '/dashboard', { redirect: 'manual' });
  const anonHtml = await anonymousDashboard.text();
  check('dashboard asks for the token when signed out', /Admin token/.test(anonHtml));

  const removed = await call('/api/enquiry/' + ref, { method: 'DELETE' });
  check('a request can be deleted', removed.status === 200, 'got ' + removed.status);

  const gone = await call('/api/enquiries?limit=50');
  check('the deleted request is gone', !(gone.body?.enquiries || []).some((r) => r.id === ref));

  /* ------------------------------------------------ form <-> API contract */
  // The form's service <select> and the Worker's allow-list are separate
  // sources of truth, and when they drift every submission is rejected. Post
  // each label the form can actually send.

  console.log('\nForm options the API must accept');

  let html = '';
  try {
    html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  } catch (err) {
    check('index.html is readable', false, String(err.message));
  }

  const serviceBlock = /<select id="service"[\s\S]*?<\/select>/.exec(html);
  const formServices = serviceBlock
    ? [...serviceBlock[0].matchAll(/<option([^>]*)>([^<]*)<\/option>/g)]
        .map((m) => {
          const attr = /value="([^"]*)"/.exec(m[1]);
          return (attr ? attr[1] : m[2]).trim();
        })
        .filter(Boolean) // drops the empty "Choose a service" placeholder
    : [];

  check('the service list was found in index.html', formServices.length >= 5, 'found ' + formServices.length);

  if (formServices.length) {
    const rejected = [];
    for (const service of formServices) {
      // The limiter allows 6 an hour per IP and this loop is longer than that,
      // so clear the window between posts. Testing the allow-list, not the limit.
      await call('/api/rate-limits', { method: 'DELETE' });
      const res = await call('/api/enquiry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sample({ service, email: 'contract@example.com' })),
      });
      if (res.status !== 200) rejected.push(service + ' (' + res.status + ' ' + (res.body?.error || '') + ')');
      else await call('/api/enquiry/' + res.body.id, { method: 'DELETE' });
    }
    check(
      'every service the form offers is accepted (' + formServices.length + ' options)',
      rejected.length === 0,
      rejected.join('; '),
    );
  }
}

/* ------------------------------------------------------------ rate limit */

console.log('\nAbuse protection');

// Clear the window first so this section measures the limiter, not the last run.
if (cookie) await call('/api/rate-limits', { method: 'DELETE' });

const codes = [];
for (let i = 0; i < 9; i += 1) {
  const res = await fetch(BASE + '/api/enquiry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sample({ email: 'flood' + i + '@example.com', name: 'Flood ' + i })),
  });
  codes.push(res.status);
}
check('the first few submissions get through', codes.slice(0, 3).every((c) => c === 200), codes.join(','));
check('flooding is throttled with 429', codes.includes(429), codes.join(','));

if (TOKEN) {
  // Clean up the flood rows and the throttle window so the local database does
  // not grow forever and the next run starts fresh.
  const login = await fetch(BASE + '/dashboard/session', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TOKEN }).toString(),
  });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  // Remove everything this suite creates. Only demo addresses are touched, so
  // running against a real database cannot delete a genuine enquiry.
  const all = await call('/api/enquiries?limit=500');
  let cleaned = 0;
  let kept = 0;
  for (const row of all.body?.enquiries || []) {
    if (row.email.endsWith('@example.com')) {
      await call('/api/enquiry/' + row.id, { method: 'DELETE' });
      cleaned += 1;
    } else {
      kept += 1;
    }
  }

  const afterCleanup = await call('/api/enquiries?limit=500');
  check('the test submissions got stored', cleaned >= 3, 'removed ' + cleaned);
  check('no test rows are left behind', (afterCleanup.body?.enquiries || []).length === 0, afterCleanup.body?.count + ' left');
  if (kept) console.log('  \u00b7 left ' + kept + ' non-test row(s) untouched');

  await call('/api/rate-limits', { method: 'DELETE' });
  const cleared = await call('/api/stats');
  check('stats zero out cleanly rather than returning null', cleared.body?.totals?.new_count === 0, JSON.stringify(cleared.body?.totals));

  const signOut = await call('/dashboard/session', { method: 'DELETE' });
  check('sign out succeeds', signOut.status === 200, 'got ' + signOut.status);
  cookie = '';

  const afterSignOut = await call('/api/enquiries');
  check('the session is really gone after sign out', afterSignOut.status === 401, 'got ' + afterSignOut.status);

  console.log('  \u00b7 cleaned up test rows');
}

/* ------------------------------------------------------------------ done */

console.log('\n' + (failed === 0 ? '\u2713 all good' : '\u2717 ' + failed + ' failed') + '  \u2014  ' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
