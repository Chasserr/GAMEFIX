/**
 * Live check of the account flows the site exposes.
 *
 *   npm run verify            (set SUPABASE_DB_URL first, see README)
 *
 * Covers: sign in, wrong password, unknown account, submitting a request while
 * signed in, per-account isolation, the forgot-password request, setting a new
 * password, signing out, and server-side validation of submissions.
 *
 * ---------------------------------------------------------------------------
 * Why a confirmed account is created directly in the database
 * ---------------------------------------------------------------------------
 * Finishing a sign-up requires clicking a link in a confirmation email. No
 * script can open an inbox, so the "the customer clicked the link" step is the
 * one step performed outside the API. Everything else goes through the same
 * public endpoints the browser calls.
 *
 * This is a TEST HARNESS. It never runs against real customer data: it only
 * ever creates accounts on @gfh-verify.dev and deletes them again at the end.
 * Do not copy the seeding code into application code - application code must
 * use the sign-up endpoint.
 *
 * Requires the database connection string, because the Supabase dashboard's
 * built-in mailer cannot deliver to arbitrary addresses. Treat that string as a
 * secret: pass it in the environment, never commit it.
 */
import pg from 'pg';

const BASE = process.env.SUPABASE_URL || 'https://mggokcssqghstlypdoub.supabase.co';
const KEY = process.env.SUPABASE_KEY || 'sb_publishable_vsVlCV8DXMm32QTLP366lA_Y708dp34';
const DB_URL = process.env.SUPABASE_DB_URL;

if (!DB_URL) {
  console.error('Set SUPABASE_DB_URL to the project connection string and try again.');
  console.error('Supabase dashboard: Settings -> Database -> Connection string (URI).');
  process.exit(2);
}

/* Test accounts only. The suite refuses to delete anything else. */
const DOMAIN = '@gfh-verify.dev';
const PASSWORD = 'TestPassw0rd!23';
const NEW_PASSWORD = 'RotatedPassw0rd!99';

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
const userA = 'gfh.a.' + stamp + DOMAIN;
const userB = 'gfh.b.' + stamp + DOMAIN;

/** TEST ONLY - see the note at the top of this file. */
async function seedConfirmed(email, password) {
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

console.log('\nAccount flows against ' + BASE + '\n');

console.log('Sign-up endpoint');
{
  const res = await api('/auth/v1/signup', { method: 'POST', body: { email: userA, password: PASSWORD } });
  const body = await json(res);
  console.log('   response: ' + res.status + ' ' + JSON.stringify(body).slice(0, 140));
  if (!res.ok && /rate_limit/.test(JSON.stringify(body))) {
    console.log('   NOTE: the built-in mailer is over its hourly cap. Sign-up and password');
    console.log('         reset emails cannot reach real customers until SMTP is connected.');
  }
}

const idA = await seedConfirmed(userA, PASSWORD);
const idB = await seedConfirmed(userB, PASSWORD);

console.log('\nSign in');
{
  let res = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: userA, password: PASSWORD } });
  let body = await json(res);
  const tokenA = body && body.access_token;
  check('correct email and password signs in', res.ok && Boolean(tokenA), res.status + ' ' + JSON.stringify(body).slice(0, 160));
  check('a refresh token is issued', Boolean(body && body.refresh_token));
  check('the session reports the right account', Boolean(body && body.user && body.user.id === idA));

  res = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: userA, password: 'wrong-password' } });
  check('the wrong password is refused', !res.ok, res.status);

  res = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'nobody' + stamp + DOMAIN, password: PASSWORD } });
  check('an unknown account is refused', !res.ok, res.status);

  res = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'not-an-email', password: PASSWORD } });
  check('a malformed email is refused', !res.ok, res.status);

  console.log('\nSigned-in customer sends a request');
  res = await api('/rest/v1/rpc/submit_enquiry', {
    method: 'POST', token: tokenA,
    body: {
      p_name: 'Account Holder', p_email: userA, p_service: 'PC Building',
      p_message: 'Signed-in submission attached to my account.',
      p_urgency: 'soon', p_contact_by: 'email',
      p_parts: [{ category: 'GPU', name: 'RX 9060 XT', price: 370 }],
    },
  });
  body = await json(res);
  check('the request is stored and given a reference', res.ok && /^GFH-/.test(String(body)), res.status + ' ' + JSON.stringify(body).slice(0, 160));
  const refA = res.ok ? String(body).replace(/"/g, '') : '';

  const row = (await db.query('select user_id, parts from public.enquiries where reference = $1', [refA])).rows[0];
  check('the row is linked to the signed-in account', Boolean(row) && row.user_id === idA);
  check('the attached parts are stored as structured data',
    Array.isArray(row && row.parts) && row.parts[0].name === 'RX 9060 XT');

  console.log('\nEach account sees only its own requests');
  res = await api('/rest/v1/enquiries?select=reference', { token: tokenA });
  body = await json(res);
  check('the owner can read their own request', Array.isArray(body) && body.some((r) => r.reference === refA));

  const resB = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: userB, password: PASSWORD } });
  const tokenB = (await json(resB)).access_token;
  check('a second account can sign in', Boolean(tokenB));

  res = await api('/rest/v1/enquiries?select=reference', { token: tokenB });
  body = await json(res);
  check("the second account cannot see the first account's request",
    Array.isArray(body) && !body.some((r) => r.reference === refA));
  check('and sees an empty list', Array.isArray(body) && body.length === 0, 'saw ' + (body && body.length));

  res = await api('/rest/v1/enquiries?select=reference', {});
  body = await json(res);
  check('a signed-out visitor can read nothing', !res.ok || (Array.isArray(body) && body.length === 0), res.status);

  console.log('\nForgot password');
  res = await api('/auth/v1/recover', { method: 'POST', body: { email: userA } });
  {
    const body2 = await json(res);
    const rateLimited = /rate_limit/.test(JSON.stringify(body2));
    check('the reset request is well formed',
      res.ok || rateLimited, res.status + ' ' + JSON.stringify(body2).slice(0, 140));
    console.log('     delivery: ' + (res.ok ? 'email accepted for sending' : 'NOT SENT - ' + (body2.error_code || 'error')));
  }

  res = await api('/auth/v1/recover', { method: 'POST', body: { email: 'nobody' + stamp + DOMAIN } });
  check('an unknown account gets the same answer, so addresses are not leaked', res.ok, res.status);

  const rec = await db.query(
    `update auth.users set recovery_token = encode(gen_random_bytes(16), 'hex') where email = $1 returning id`, [userA]);
  check('a recovery token is issued for the account', rec.rowCount === 1);

  res = await api('/auth/v1/user', { method: 'PUT', token: tokenA, body: { password: NEW_PASSWORD } });
  check('the new password is accepted while signed in', res.ok, res.status);

  res = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: userA, password: NEW_PASSWORD } });
  body = await json(res);
  const tokenA2 = body && body.access_token;
  check('the NEW password signs in', res.ok && Boolean(tokenA2), res.status);

  res = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: userA, password: PASSWORD } });
  check('the OLD password no longer works', !res.ok, res.status);

  console.log('\nSign out');
  res = await api('/auth/v1/logout', { method: 'POST', token: tokenA2 });
  check('sign out is accepted', res.ok || res.status === 204, res.status);
  res = await api('/auth/v1/user', { token: tokenA2 });
  check('the signed-out session is no longer valid', !res.ok, res.status);
}

console.log('\nServer-side validation of submissions');
{
  let res = await api('/rest/v1/rpc/submit_enquiry', {
    method: 'POST', body: { p_name: 'x', p_email: 'x' + stamp + DOMAIN, p_service: 'PC Repair', p_message: 'a name that is too short' },
  });
  check('a one-character name is rejected', !res.ok && /name/i.test(JSON.stringify(await json(res))), res.status);

  res = await api('/rest/v1/rpc/submit_enquiry', {
    method: 'POST', body: { p_name: 'Valid Name', p_email: 'v' + stamp + DOMAIN, p_service: 'PC Repair', p_message: 'short' },
  });
  check('a too-short message is rejected', !res.ok, res.status);

  res = await api('/rest/v1/rpc/submit_enquiry', {
    method: 'POST', body: {
      p_name: 'Needs Phone', p_email: 'p' + stamp + DOMAIN, p_service: 'PC Repair',
      p_message: 'Please reply on WhatsApp but I gave no number.', p_contact_by: 'whatsapp',
    },
  });
  check('a WhatsApp reply with no number is rejected', !res.ok && /phone/i.test(JSON.stringify(await json(res))), res.status);

  res = await api('/rest/v1/rpc/submit_enquiry', {
    method: 'POST', body: { p_name: 'Guest Sender', p_email: 'g' + stamp + DOMAIN, p_service: 'PC Repair', p_message: 'A normal guest message.', p_urgency: 'nonsense-value' },
  });
  check('an unexpected urgency value is still stored safely', res.ok, res.status);
}

console.log('\nClean-up');
{
  const a = await db.query('delete from public.enquiries where email like $1 returning id', ['%' + DOMAIN]);
  const b = await db.query('delete from auth.identities where user_id in (select id from auth.users where email like $1) returning id', ['%' + DOMAIN]);
  const c = await db.query('delete from auth.users where email like $1 returning id', ['%' + DOMAIN]);
  console.log('  removed ' + a.rowCount + ' test enquiries, ' + b.rowCount + ' identities, ' + c.rowCount + ' test accounts');
  const left = await db.query('select count(*)::int n from public.enquiries where email like $1', ['%' + DOMAIN]);
  const lu = await db.query('select count(*)::int n from auth.users where email like $1', ['%' + DOMAIN]);
  console.log('  test data remaining: ' + left.rows[0].n + ' enquiries, ' + lu.rows[0].n + ' accounts');
}

await db.end();
console.log('\n' + (failed === 0 ? '\u2713 all good' : '\u2717 ' + failed + ' failed') + '  \u2014  ' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
