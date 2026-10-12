/**
 * Live check of the admin rules, from the outside in.
 *
 *   npm run verify:admin      (set SUPABASE_DB_URL first, see README)
 *
 * The point of this suite is that every rule is tested as the attacker, not as
 * the intended user: an anonymous visitor, and a signed-in customer who tries
 * to read, edit and delete somebody else's request. The panel in the browser is
 * only allowed to work because the database refuses everything else.
 *
 * Requires the database connection string to create its own accounts and to
 * confirm what actually happened. Test-only: it works exclusively inside
 * @gfh-verify.dev and deletes everything it made.
 */
import pg from 'pg';

const BASE = process.env.SUPABASE_URL || 'https://mggokcssqghstlypdoub.supabase.co';
const KEY = process.env.SUPABASE_KEY || 'sb_publishable_vsVlCV8DXMm32QTLP366lA_Y708dp34';
const DB_URL = process.env.SUPABASE_DB_URL;

if (!DB_URL) {
  console.error('Set SUPABASE_DB_URL to the project connection string and try again.');
  process.exit(2);
}

const DOMAIN = '@gfh-verify.dev';
const PASSWORD = 'TestPassw0rd!23';

const db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log('  \u2713 ' + name); }
  else { failed += 1; console.log('  \u2717 ' + name + (detail ? '  -> ' + detail : '')); }
};

const api = (p, { method = 'GET', body, token, headers = {} } = {}) =>
  fetch(BASE + p, {
    method,
    headers: {
      apikey: KEY,
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

const stamp = Date.now();
const adminEmail = 'admin.' + stamp + DOMAIN;
const custEmail = 'cust.' + stamp + DOMAIN;
const otherEmail = 'other.' + stamp + DOMAIN;

async function seedUser(email, password) {
  const ins = await db.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       email_change_token_current, phone_change, phone_change_token,
       reauthentication_token, is_sso_user, is_anonymous
     ) values (
       '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
       'authenticated', $1, crypt($2, gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}', '{}', now(), now(),
       '', '', '', '', '', '', '', '', false, false
     ) returning id`,
    [email, password]
  );
  const id = ins.rows[0].id;
  await db.query(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values ($1, $2, jsonb_build_object('sub', $1::text, 'email', $3::text, 'email_verified', true, 'phone_verified', false), 'email', now(), now(), now())`,
    [id, id, email]
  );
  return id;
}

const signIn = async (email) => {
  const res = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: PASSWORD } });
  const body = await json(res);
  return body && body.access_token;
};

/* ------------------------------------------------------------------- setup */

const adminId = await seedUser(adminEmail, PASSWORD);
const custId = await seedUser(custEmail, PASSWORD);
const otherId = await seedUser(otherEmail, PASSWORD);

const custToken = await signIn(custEmail);
const otherToken = await signIn(otherEmail);
let adminToken = await signIn(adminEmail);

// Two requests that belong to somebody else, from the admin's point of view.
const submit = async (token, email, label) => {
  const res = await api('/rest/v1/rpc/submit_enquiry', {
    method: 'POST', token,
    body: {
      p_name: label, p_email: email, p_service: 'PC Repair',
      p_message: 'Body of the request owned by ' + label + '.',
      p_urgency: 'soon', p_contact_by: 'email',
    },
  });
  const ref = await json(res);
  return res.ok ? String(ref).replace(/"/g, '') : '';
};
const refCust = await submit(custToken, custEmail, 'Customer One');
const refOther = await submit(otherToken, otherEmail, 'Customer Two');

const rows = await db.query(
  `select id, reference, user_id from public.enquiries where reference = any($1)`, [[refCust, refOther]]);
const idCust = (rows.rows.find((r) => r.reference === refCust) || {}).id;
const idOther = (rows.rows.find((r) => r.reference === refOther) || {}).id;

console.log('\nAdmin rules against ' + BASE + '\n');
console.log('Setup: 3 accounts (one to be made an admin), 2 requests owned by the two customers');

check('no account is an admin until the database says so',
  Boolean(idCust) && Boolean(idOther) && (await db.query('select count(*)::int n from public.admins')).rows[0].n === 0);

/* ------------------------------------------------------- anonymous visitor */

console.log('\nAnonymous visitor (no account, holding only the publishable key)');
{
  let res = await api('/rest/v1/enquiries?select=reference,message');
  let body = await json(res);
  check('cannot read any request', res.status === 401 || (Array.isArray(body) && body.length === 0), res.status + ' ' + JSON.stringify(body).slice(0, 120));

  res = await api('/rest/v1/rpc/is_admin', { method: 'POST', body: {} });
  body = await json(res);
  check('is never reported as an admin', res.ok && body === false, res.status + ' ' + JSON.stringify(body).slice(0, 80));

  res = await api('/rest/v1/admins?select=user_id');
  check('cannot read the admins table', !res.ok || (await json(res)).length === 0, res.status);

  res = await api('/rest/v1/enquiry_stats?select=total');
  check('cannot read the statistics view', !res.ok || (await json(res)).length === 0, res.status);
}

/* --------------------------------------------------------- signed-in customer */

console.log('\nSigned-in customer (a normal account, not an admin)');
{
  check('is not an admin', (await json(await api('/rest/v1/rpc/is_admin', { method: 'POST', token: custToken, body: {} }))) === false);

  let res = await api('/rest/v1/enquiries?select=reference', { token: custToken });
  let body = await json(res);
  check('reads exactly one request - their own', Array.isArray(body) && body.length === 1 && body[0].reference === refCust,
    JSON.stringify(body).slice(0, 160));

  res = await api('/rest/v1/enquiries?select=reference&reference=eq.' + refOther, { token: custToken });
  body = await json(res);
  check("cannot read another customer's request even by asking for it directly",
    Array.isArray(body) && body.length === 0, JSON.stringify(body).slice(0, 160));

  res = await api('/rest/v1/enquiry_stats?select=total,from_accounts', { token: custToken });
  body = await json(res);
  const custTotal = Array.isArray(body) && body[0] ? Number(body[0].total) : -1;
  check('the statistics view counts only their own rows, not everyone else\'s', custTotal === 1, 'saw total=' + custTotal);

  res = await api('/rest/v1/enquiries?id=eq.' + idOther, {
    method: 'PATCH', token: custToken, headers: { Prefer: 'return=representation' },
    body: { status: 'won' },
  });
  body = await json(res);
  check("cannot change the status of another customer's request",
    !res.ok || (Array.isArray(body) && body.length === 0), res.status + ' ' + JSON.stringify(body).slice(0, 140));

  res = await api('/rest/v1/enquiries?id=eq.' + idCust, {
    method: 'PATCH', token: custToken, headers: { Prefer: 'return=representation' },
    body: { status: 'won' },
  });
  body = await json(res);
  check('cannot even change the status of their own request', !res.ok || (Array.isArray(body) && body.length === 0),
    res.status + ' ' + JSON.stringify(body).slice(0, 140));

  // A row-level-security-protected DELETE matches nothing and still answers 204,
  // so the status code proves nothing. What matters is whether the row survived.
  res = await api('/rest/v1/enquiries?id=eq.' + idOther, { method: 'DELETE', token: custToken });
  const stillThere = (await db.query('select count(*)::int n from public.enquiries where id = $1', [idOther])).rows[0].n;
  check("cannot delete another customer's request", stillThere === 1, 'HTTP ' + res.status + ', rows remaining ' + stillThere);

  res = await api('/rest/v1/admins', { method: 'POST', token: custToken, body: { user_id: custId } });
  check('cannot promote themselves to admin', !res.ok, res.status + ' ' + JSON.stringify(await json(res)).slice(0, 120));

  const still = (await db.query('select status from public.enquiries where id = $1', [idOther])).rows[0];
  check('the other request is genuinely untouched in the database', still && still.status === 'new', still && still.status);
}

/* ------------------------------------------------------------------- admin */

console.log('\nThe same account, after being added to public.admins');
{
  await db.query('insert into public.admins (user_id, label) values ($1, $2)', [adminId, 'Test admin']);
  // The token is unchanged; the privileges come from the table, re-read per query.
  adminToken = await signIn(adminEmail);

  check('is now an admin', (await json(await api('/rest/v1/rpc/is_admin', { method: 'POST', token: adminToken, body: {} }))) === true);

  let res = await api('/rest/v1/enquiries?select=reference', { token: adminToken });
  let body = await json(res);
  const refs = Array.isArray(body) ? body.map((r) => r.reference) : [];
  check('reads every customer\'s request', refs.includes(refCust) && refs.includes(refOther), JSON.stringify(refs).slice(0, 160));

  res = await api('/rest/v1/enquiry_stats?select=total,from_accounts', { token: adminToken });
  body = await json(res);
  const adminTotal = Array.isArray(body) && body[0] ? Number(body[0].total) : -1;
  check('the statistics view shows the real totals', adminTotal === 2, 'saw total=' + adminTotal);

  res = await api('/rest/v1/enquiries?id=eq.' + idOther, {
    method: 'PATCH', token: adminToken, headers: { Prefer: 'return=representation' },
    body: { status: 'replied', notes: 'Quoted by phone.' },
  });
  body = await json(res);
  check('can move another customer\'s request through the workflow',
    res.ok && Array.isArray(body) && body[0] && body[0].status === 'replied', res.status + ' ' + JSON.stringify(body).slice(0, 140));

  const after = (await db.query('select status, notes from public.enquiries where id = $1', [idOther])).rows[0];
  check('and the change is really in the database', after && after.status === 'replied' && after.notes === 'Quoted by phone.');

  res = await api('/rest/v1/enquiries?id=eq.' + idOther, {
    method: 'PATCH', token: adminToken, body: { message: 'Rewritten by an admin.' },
  });
  body = await json(res);
  check('cannot rewrite what the customer actually wrote',
    !res.ok, res.status + ' ' + JSON.stringify(body).slice(0, 120));
  const msg = (await db.query('select message from public.enquiries where id = $1', [idOther])).rows[0].message;
  check('the original wording is intact', msg === 'Body of the request owned by Customer Two.', msg);

  res = await api('/rest/v1/enquiries?id=eq.' + idOther, {
    method: 'PATCH', token: adminToken, body: { email: 'attacker@evil.test' },
  });
  check('cannot change the contact address either', !res.ok, res.status);

  res = await api('/rest/v1/enquiries', {
    method: 'POST', token: adminToken,
    body: { reference: 'GFH-000000-ADMIN1', name: 'Injected', email: 'x' + DOMAIN, service: 'PC Repair', message: 'written straight into the table' },
  });
  check('cannot write rows into the table directly, only through the function', !res.ok, res.status + ' ' + JSON.stringify(await json(res)).slice(0, 120));

  res = await api('/rest/v1/admins', { method: 'POST', token: adminToken, body: { user_id: otherId } });
  check('cannot promote somebody else from the browser either', !res.ok, res.status);

  res = await api('/rest/v1/enquiries?id=eq.' + idCust, { method: 'DELETE', token: adminToken });
  check('can delete a request', res.ok, res.status);
  const gone = (await db.query('select count(*)::int n from public.enquiries where id = $1', [idCust])).rows[0].n;
  check('and it is gone from the database', gone === 0);

  res = await api('/rest/v1/admins?select=user_id', { token: adminToken });
  check('still cannot read the admins table through the API', !res.ok || (await json(res)).length === 0, res.status);
}

/* -------------------------------------------------- losing admin rights --- */

console.log('\nAfter the admin is removed again');
{
  await db.query('delete from public.admins where user_id = $1', [adminId]);
  const res = await api('/rest/v1/enquiries?select=reference', { token: adminToken });
  const body = await json(res);
  check('access is withdrawn immediately, with no new sign-in', Array.isArray(body) && body.length === 0,
    JSON.stringify(body).slice(0, 140));
  check('is_admin() is false again',
    (await json(await api('/rest/v1/rpc/is_admin', { method: 'POST', token: adminToken, body: {} }))) === false);
}

/* ----------------------------------------------------------------- clean-up */

console.log('\nClean-up');
{
  const a = await db.query('delete from public.enquiries where email like $1 returning id', ['%' + DOMAIN]);
  const b = await db.query('delete from public.admins where user_id in (select id from auth.users where email like $1) returning user_id', ['%' + DOMAIN]);
  const c = await db.query('delete from auth.identities where user_id in (select id from auth.users where email like $1) returning id', ['%' + DOMAIN]);
  const d = await db.query('delete from auth.users where email like $1 returning id', ['%' + DOMAIN]);
  console.log('  removed ' + a.rowCount + ' enquiries, ' + b.rowCount + ' admin rows, ' + c.rowCount + ' identities, ' + d.rowCount + ' accounts');
  const leftQ = (await db.query('select count(*)::int n from public.enquiries')).rows[0].n;
  const leftU = (await db.query('select count(*)::int n from auth.users')).rows[0].n;
  console.log('  left behind: ' + leftQ + ' enquiries, ' + leftU + ' accounts');
  check('the suite left no test data behind', leftQ === 0 && leftU === 0, leftQ + ' enquiries, ' + leftU + ' accounts');
}

await db.end();
console.log('\n' + (failed === 0 ? '\u2713 all good' : '\u2717 ' + failed + ' failed') + '  \u2014  ' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
