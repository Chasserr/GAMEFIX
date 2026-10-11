/**
 * GameFix Hub - enquiry backend.
 *
 * One Cloudflare Worker that does three jobs:
 *
 *   1. Serves the static site (index.html, copied into ./public by build.mjs).
 *   2. Accepts POST /api/enquiry  - validates, rate-limits, stores in D1 and
 *      notifies the owner by email via Resend.
 *   3. Serves GET /dashboard     - a token-protected inbox to read requests.
 *
 * Deliberately dependency-free: plain fetch, plain SQL. Nothing to audit but
 * this file.
 *
 * Required bindings / variables (see wrangler.jsonc and .dev.vars.example):
 *   DB              D1 database binding
 *   ADMIN_TOKEN     secret, required to read /dashboard
 *   RESEND_API_KEY  secret, optional - requests are still stored without it
 *   MAIL_FROM       optional, e.g. "GameFix Hub <onboarding@resend.dev>"
 *   MAIL_TO         optional, defaults to the public contact address
 *   SESSION_SECRET  optional, auto-generated from ADMIN_TOKEN if unset
 *
 * D1 is created lazily on first write, so there is no migration step to forget.
 */

const SITE_NAME = 'GameFix Hub';
const PUBLIC_EMAIL = 'meshackosei50@gmail.com';
const MAX_BODY_BYTES = 32 * 1024;

const COOKIE_NAME = 'gfh_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const RATE_LIMIT_MAX = 6; // requests per IP...
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // ...per hour

// These must stay identical to the <option> labels in the site's service
// <select> (see index.html). A mismatch silently rejects every request.
const SERVICES = [
  'PC Repair',
  'Overheating / Cooling',
  'Windows / Drivers',
  'Gaming PC Parts',
  'PC Building',
  'Performance Upgrade',
  'Compatibility Check',
  'Other',
];

const URGENCIES = ['standard', 'soon', 'urgent'];
const CONTACT_METHODS = ['email', 'whatsapp', 'phone'];

/* ------------------------------------------------------------------ schema */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS enquiries (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  service       TEXT NOT NULL,
  budget        TEXT,
  urgency       TEXT NOT NULL DEFAULT 'standard',
  contact_by    TEXT NOT NULL DEFAULT 'email',
  message       TEXT NOT NULL,
  build_summary TEXT,
  parts_json    TEXT,
  status        TEXT NOT NULL DEFAULT 'new',
  notes         TEXT NOT NULL DEFAULT '',
  ip_hash       TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_enquiries_created_at ON enquiries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enquiries_status     ON enquiries (status);
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);
`;

/* ------------------------------------------------------------- small utils */

const enc = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function fail(status, message) {
  return json({ ok: false, error: message }, status);
}

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function clamp(value, allowed, fallback) {
  const v = str(value, 40).toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value);
}

function normalisePhone(value) {
  return value.replace(/[^\d+]/g, '').slice(0, 24);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Timing-safe string comparison for the admin token. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function parseCookies(request) {
  const raw = request.headers.get('cookie') || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin form posts and curl have no Origin
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------- session signing */

function base64url(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

async function signSession(secret, payload) {
  const body = base64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return body + '.' + base64url(sig);
}

async function verifySession(secret, token) {
  if (!token || token.indexOf('.') === -1) return null;
  const [body, sig] = token.split('.');
  const key = await hmacKey(secret);
  const expected = base64url(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
    ));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function sessionSecret(env) {
  // Prefer a dedicated secret; otherwise derive one so a token alone is enough.
  return env.SESSION_SECRET || 'gfh::' + (env.ADMIN_TOKEN || 'unset');
}

/* ----------------------------------------------------------------- database */

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  const statements = SCHEMA.split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
  schemaReady = true;
}

/**
 * Fixed-window rate limit. Cheap, good enough to stop a form being spammed,
 * and it costs one upsert per request.
 */
async function rateLimit(env, key, limit, windowMs) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count        = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`,
  )
    .bind(key, now, windowMs)
    .run();

  const row = await env.DB.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?1')
    .bind(key)
    .first();

  const recent = row && now - row.window_start < windowMs ? row.count : 1;
  return { allowed: recent <= limit, retryAfterMs: recent <= limit ? 0 : windowMs - (now - (row?.window_start ?? now)) };
}

/* --------------------------------------------------------------- validation */

function validateEnquiry(input) {
  const errors = [];
  const data = {
    name: str(input.name, 120),
    email: str(input.email, 160).toLowerCase(),
    phone: normalisePhone(str(input.phone, 40)),
    service: str(input.service, 80),
    budget: str(input.budget, 40),
    urgency: clamp(input.urgency, URGENCIES, 'standard'),
    contactBy: clamp(input.contactBy, CONTACT_METHODS, 'email'),
    message: str(input.message, 4000),
    buildSummary: str(input.buildSummary, 1200),
    parts: Array.isArray(input.parts) ? input.parts.slice(0, 24) : [],
  };

  if (data.name.length < 2) errors.push('name');
  if (!isEmail(data.email)) errors.push('email');
  if (!SERVICES.includes(data.service)) errors.push('service');
  if (data.phone && data.phone.replace(/\D/g, '').length < 6) errors.push('phone');
  if ((data.contactBy === 'whatsapp' || data.contactBy === 'phone') && !data.phone) errors.push('phone');
  if (data.message.length < 10) errors.push('message');
  if (data.message.length > 4000) errors.push('message');

  return { errors, data };
}

/* ------------------------------------------------------------------- email */

function buildNotificationHtml(row) {
  const line = (label, value) =>
    value
      ? `<tr><td style="padding:6px 14px 6px 0;color:#64748b;font:600 12px/1.5 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;vertical-align:top">${escapeHtml(
          label,
        )}</td><td style="padding:6px 0;color:#0f172a;font:400 15px/1.6 system-ui,sans-serif">${escapeHtml(
          value,
        )}</td></tr>`
      : '';

  const parts = row.parts && row.parts.length
    ? `<table style="border-collapse:collapse;margin:4px 0 0">${row.parts
        .map(
          (p) =>
            `<tr><td style="padding:3px 12px 3px 0;color:#64748b;font:600 12px/1.5 system-ui,sans-serif">${escapeHtml(
              p.category || '',
            )}</td><td style="padding:3px 0;color:#0f172a;font:400 14px/1.5 system-ui,sans-serif">${escapeHtml(
              p.name || '',
            )} <span style="color:#64748b">${escapeHtml(p.price == null ? '' : '€' + p.price)}</span></td></tr>`,
        )
        .join('')}</table>`
    : '<em style="color:#64748b">none attached</em>';

  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden">
    <div style="background:#0b1220;padding:20px 24px">
      <div style="color:#67e8f9;font:700 12px/1 system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase">${SITE_NAME}</div>
      <div style="color:#fff;font:700 20px/1.3 system-ui,sans-serif;margin-top:6px">New enquiry from ${escapeHtml(
        row.name,
      )}</div>
    </div>
    <div style="padding:20px 24px">
      <table style="border-collapse:collapse;width:100%">
        ${line('Service', row.service)}
        ${line('Urgency', row.urgency)}
        ${line('Reply by', row.contactBy)}
        ${line('Email', row.email)}
        ${line('Phone', row.phone)}
        ${line('Budget', row.budget)}
        ${line('Reference', row.id)}
      </table>
      <div style="margin:18px 0 6px;color:#64748b;font:600 12px/1.5 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.04em">Message</div>
      <div style="white-space:pre-wrap;color:#0f172a;font:400 15px/1.7 system-ui,sans-serif;border-left:3px solid #22d3ee;padding-left:14px">${escapeHtml(
        row.message,
      )}</div>
      ${
        row.buildSummary
          ? `<div style="margin:18px 0 6px;color:#64748b;font:600 12px/1.5 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.04em">Build plan</div>
             <div style="white-space:pre-wrap;color:#0f172a;font:400 14px/1.6 system-ui,sans-serif">${escapeHtml(
               row.buildSummary,
             )}</div>`
          : ''
      }
      <div style="margin:18px 0 6px;color:#64748b;font:600 12px/1.5 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.04em">Attached parts</div>
      ${parts}
    </div>
    <div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font:400 12px/1.6 system-ui,sans-serif">
      Sent automatically from gamefixhub. Reply directly to this email to answer ${escapeHtml(row.name)}.
    </div>
  </div></body></html>`;
}

async function sendNotification(env, row) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'RESEND_API_KEY not configured' };

  const from = env.MAIL_FROM || `${SITE_NAME} <onboarding@resend.dev>`;
  const to = env.MAIL_TO || PUBLIC_EMAIL;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: row.email,
        subject: `[${SITE_NAME}] ${row.urgency === 'urgent' ? 'URGENT - ' : ''}${row.service} - ${row.name}`,
        html: buildNotificationHtml(row),
        text: [
          `New enquiry from ${row.name}`,
          `Service:  ${row.service}`,
          `Urgency:  ${row.urgency}`,
          `Reply by: ${row.contactBy}`,
          `Email:    ${row.email}`,
          `Phone:    ${row.phone || '-'}`,
          `Budget:   ${row.budget || '-'}`,
          `Ref:      ${row.id}`,
          '',
          row.message,
          row.buildSummary ? '\n--- build plan ---\n' + row.buildSummary : '',
        ].join('\n'),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('resend_error', res.status, detail.slice(0, 300));
      return { sent: false, reason: 'resend ' + res.status };
    }
    return { sent: true };
  } catch (err) {
    console.error('resend_exception', String(err).slice(0, 200));
    return { sent: false, reason: 'network' };
  }
}

/* ---------------------------------------------------------------- endpoints */

async function handleEnquiry(request, env) {
  let body;

  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return fail(413, 'Request too large.');
    body = JSON.parse(text);
  } catch {
    return fail(400, 'Could not read that request.');
  }
  if (!body || typeof body !== 'object') return fail(400, 'Could not read that request.');

  // Honeypot: a real person never fills a field they cannot see.
  if (str(body.website, 200)) return json({ ok: true, id: 'ignored' });

  const { errors, data } = validateEnquiry(body);
  if (errors.length) return fail(422, 'Please check: ' + [...new Set(errors)].join(', '));

  await ensureSchema(env);

  const ipHash = await sha256Hex('gfh::' + clientIp(request) + '::' + (env.ADMIN_TOKEN || ''));
  const limit = await rateLimit(env, 'ip:' + ipHash, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!limit.allowed) {
    return json(
      { ok: false, error: 'Too many requests from this connection. Please try again later or WhatsApp us.' },
      429,
      { 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) },
    );
  }

  const id = 'GFH-' + Date.now().toString(36).toUpperCase() + '-' + ipHash.slice(0, 4).toUpperCase();
  const row = {
    id,
    created_at: Date.now(),
    name: data.name,
    email: data.email,
    phone: data.phone || null,
    service: data.service,
    budget: data.budget || null,
    urgency: data.urgency,
    contact_by: data.contactBy,
    message: data.message,
    build_summary: data.buildSummary || null,
    parts_json: data.parts.length ? JSON.stringify(data.parts) : null,
    status: 'new',
    notes: '',
    ip_hash: ipHash,
    user_agent: str(request.headers.get('user-agent'), 300) || null,
  };

  await env.DB.prepare(
    `INSERT INTO enquiries (
       id, created_at, name, email, phone, service, budget, urgency, contact_by,
       message, build_summary, parts_json, status, notes, ip_hash, user_agent
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`,
  )
    .bind(
      row.id,
      row.created_at,
      row.name,
      row.email,
      row.phone,
      row.service,
      row.budget,
      row.urgency,
      row.contact_by,
      row.message,
      row.build_summary,
      row.parts_json,
      row.status,
      row.notes,
      row.ip_hash,
      row.user_agent,
    )
    .run();

  const mail = await sendNotification(env, { ...row, parts: data.parts });

  // The request is stored regardless of email outcome - never lose an enquiry
  // because a third party had a bad minute.
  return json({ ok: true, id: row.id, emailed: mail.sent });
}

async function handleList(request, env, url) {
  await ensureSchema(env);
  const status = str(url.searchParams.get('status'), 20);
  const q = str(url.searchParams.get('q'), 80);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);

  const where = [];
  const binds = [];
  if (status && status !== 'all') {
    where.push('status = ?' + (binds.push(status) + ''));
  }
  if (q) {
    where.push('(name LIKE ?' + (binds.push('%' + q + '%') + '') + ' OR email LIKE ?' + (binds.push('%' + q + '%') + '') + ' OR id LIKE ?' + (binds.push('%' + q + '%') + '') + ')');
  }

  const sql =
    'SELECT id, created_at, name, email, phone, service, budget, urgency, contact_by, message, build_summary, parts_json, status, notes FROM enquiries' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC LIMIT ?' + (binds.push(limit) + '');

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json({ ok: true, count: results.length, enquiries: results });
}

async function handleStats(env) {
  await ensureSchema(env);
  const totals = await env.DB.prepare(
    `SELECT
       COUNT(*)                                                                AS total,
       COALESCE(SUM(CASE WHEN status  = 'new'    THEN 1 ELSE 0 END), 0)         AS new_count,
       COALESCE(SUM(CASE WHEN status  = 'won'    THEN 1 ELSE 0 END), 0)         AS won,
       COALESCE(SUM(CASE WHEN urgency = 'urgent' THEN 1 ELSE 0 END), 0)         AS urgent,
       COALESCE(SUM(CASE WHEN created_at >= ?1 - 604800000 THEN 1 ELSE 0 END), 0) AS last_week
     FROM enquiries`,
  )
    .bind(Date.now())
    .first();

  const byService = await env.DB.prepare(
    'SELECT service, COUNT(*) AS n FROM enquiries GROUP BY service ORDER BY n DESC LIMIT 8',
  ).all();

  return json({ ok: true, totals, byService: byService.results });
}

async function handleUpdate(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Could not read that request.');
  }

  const status = str(body.status, 20);
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 2000) : null;
  const allowed = ['new', 'read', 'replied', 'won', 'archived'];
  if (status && !allowed.includes(status)) return fail(422, 'Unknown status.');

  await ensureSchema(env);

  if (status && notes !== null) {
    await env.DB.prepare('UPDATE enquiries SET status = ?1, notes = ?2 WHERE id = ?3')
      .bind(status, notes, id)
      .run();
  } else if (status) {
    await env.DB.prepare('UPDATE enquiries SET status = ?1 WHERE id = ?2').bind(status, id).run();
  } else if (notes !== null) {
    await env.DB.prepare('UPDATE enquiries SET notes = ?1 WHERE id = ?2').bind(notes, id).run();
  } else {
    return fail(422, 'Nothing to update.');
  }

  return json({ ok: true });
}

async function handleDelete(env, id) {
  await ensureSchema(env);
  await env.DB.prepare('DELETE FROM enquiries WHERE id = ?1').bind(id).run();
  return json({ ok: true });
}

/**
 * Clears the throttle table. Admin only. Useful when a genuine customer was
 * locked out by over-eager clicking and you want to let them back in.
 */
async function handleResetRateLimits(env) {
  await ensureSchema(env);
  await env.DB.prepare('DELETE FROM rate_limits').run();
  return json({ ok: true });
}

async function handleCsv(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    'SELECT id, created_at, name, email, phone, service, budget, urgency, contact_by, status, message FROM enquiries ORDER BY created_at DESC LIMIT 2000',
  ).all();

  const header = ['id', 'received', 'name', 'email', 'phone', 'service', 'budget', 'urgency', 'contact_by', 'status', 'message'];
  const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  const lines = [header.join(',')];
  for (const r of results) {
    lines.push(
      [
        r.id,
        new Date(r.created_at).toISOString(),
        r.name,
        r.email,
        r.phone,
        r.service,
        r.budget,
        r.urgency,
        r.contact_by,
        r.status,
        r.message,
      ]
        .map(cell)
        .join(','),
    );
  }

  return new Response(lines.join('\r\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="gamefixhub-enquiries.csv"',
      'cache-control': 'no-store',
    },
  });
}

/* ---------------------------------------------------------------- dashboard */

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b1220'/%3E%3Cpath d='M22 26h20v9a10 10 0 0 1-10 10 10 10 0 0 1-10-10v-9Z' fill='none' stroke='%2322d3ee' stroke-width='4'/%3E%3Ccircle cx='27' cy='33' r='2.5' fill='%237c5cff'/%3E%3Ccircle cx='37' cy='33' r='2.5' fill='%237c5cff'/%3E%3C/svg%3E";

const DASHBOARD_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#070b14;color:#e8edf7;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:#67e8f9}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 80px}
header{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;margin-bottom:22px}
h1{font-size:20px;margin:0;letter-spacing:-.01em}
.sub{color:#8b9ab5;font-size:13px;margin-top:4px}
.bar{display:flex;flex-wrap:wrap;gap:8px}
input,select,button,textarea{font:inherit;color:inherit;background:#111a2b;border:1px solid #24334d;border-radius:9px;padding:9px 11px}
input:focus,select:focus,textarea:focus{outline:2px solid #22d3ee;outline-offset:1px}
button{cursor:pointer}
button.primary{background:#22d3ee;border-color:#22d3ee;color:#04121a;font-weight:650}
button.ghost:hover{background:#16223a}
button[disabled]{opacity:.5;cursor:not-allowed}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:22px}
.stat{background:#0d1524;border:1px solid #1c2740;border-radius:12px;padding:14px}
.stat b{display:block;font-size:24px;line-height:1.2}
.stat span{color:#8b9ab5;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.card{background:#0d1524;border:1px solid #1c2740;border-radius:12px;padding:16px;margin-bottom:10px}
.card h2{font-size:16px;margin:0 0 2px}
.card .meta{color:#8b9ab5;font-size:13px;word-break:break-word}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{border:1px solid #24334d;border-radius:999px;padding:3px 10px;font-size:12px;color:#b9c6dc}
.tag.urgent{border-color:#f97316;color:#fdba74}
.tag.new{border-color:#22d3ee;color:#67e8f9}
.tag.won{border-color:#22c55e;color:#86efac}
pre{white-space:pre-wrap;word-break:break-word;background:#070d19;border:1px solid #1c2740;border-radius:9px;padding:11px;margin:10px 0;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.empty{text-align:center;color:#8b9ab5;padding:52px 20px;border:1px dashed #24334d;border-radius:12px}
.login{max-width:360px;margin:14vh auto;background:#0d1524;border:1px solid #1c2740;border-radius:14px;padding:24px}
.login h1{margin:0 0 6px}
label{display:block;font-size:12px;color:#8b9ab5;text-transform:uppercase;letter-spacing:.05em;margin:14px 0 5px}
.login input,.login button{width:100%}
.err{color:#fca5a5;font-size:13px;min-height:19px;margin-top:10px}
`;

function dashboardLogin(errorMessage) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="${FAVICON}">
<title>Sign in - ${SITE_NAME}</title><style>${DASHBOARD_CSS}</style></head>
<body><form class="login" method="post" action="/dashboard/session">
  <h1>${SITE_NAME}</h1>
  <div class="sub">Request inbox</div>
  <label for="token">Admin token</label>
  <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
  <div class="err">${errorMessage ? escapeHtml(errorMessage) : ''}</div>
  <button class="primary" type="submit">Sign in</button>
</form></body></html>`,
    {
      status: errorMessage ? 401 : 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'robots': 'noindex, nofollow',
      },
    },
  );
}

function dashboardPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="${FAVICON}">
<title>Requests - ${SITE_NAME}</title><style>${DASHBOARD_CSS}</style></head>
<body><div class="wrap">
  <header>
    <div><h1>Request inbox</h1><div class="sub" id="sub">Loading...</div></div>
    <div class="bar">
      <input id="q" type="search" placeholder="Search name, email, ref" aria-label="Search requests">
      <select id="status" aria-label="Filter by status">
        <option value="all">All statuses</option>
        <option value="new">New</option>
        <option value="read">Read</option>
        <option value="replied">Replied</option>
        <option value="won">Won</option>
        <option value="archived">Archived</option>
      </select>
      <button class="ghost" id="refresh">Refresh</button>
      <button class="ghost" id="csv">Export CSV</button>
      <button class="ghost" id="signout">Sign out</button>
    </div>
  </header>
  <div class="stats" id="stats"></div>
  <div id="list"></div>
</div>
<script>
(function () {
  var state = { status: 'all', q: '' };

  function text(node, value) { node.textContent = value; }

  function tag(cls, label) {
    var el = document.createElement('span');
    el.className = 'tag ' + cls;
    el.textContent = label;
    return el;
  }

  function renderStats(totals) {
    var box = document.getElementById('stats');
    box.textContent = '';
    var items = [
      ['Total', totals.total || 0],
      ['Unread', totals.new_count || 0],
      ['This week', totals.last_week || 0],
      ['Urgent', totals.urgent || 0],
      ['Won', totals.won || 0]
    ];
    items.forEach(function (pair) {
      var d = document.createElement('div');
      d.className = 'stat';
      var b = document.createElement('b');
      text(b, String(pair[1]));
      var s = document.createElement('span');
      text(s, pair[0]);
      d.appendChild(b); d.appendChild(s);
      box.appendChild(d);
    });
  }

  function renderCard(item) {
    var card = document.createElement('article');
    card.className = 'card';

    var row = document.createElement('div');
    row.className = 'row';

    var left = document.createElement('div');
    var h = document.createElement('h2');
    text(h, item.name + ' - ' + item.service);
    var meta = document.createElement('div');
    meta.className = 'meta';
    text(meta, new Date(item.created_at).toLocaleString() + ' - ' + item.id);
    left.appendChild(h); left.appendChild(meta);

    var tags = document.createElement('div');
    tags.className = 'tags';
    tags.appendChild(tag(item.status === 'new' ? 'tag new' : 'tag', item.status));
    if (item.urgency === 'urgent') tags.appendChild(tag('urgent', 'urgent'));
    if (item.urgency === 'soon') tags.appendChild(tag('', 'soon'));
    tags.appendChild(tag('', 'reply by ' + item.contact_by));
    if (item.budget) tags.appendChild(tag('', item.budget));

    row.appendChild(left); row.appendChild(tags);
    card.appendChild(row);

    var contact = document.createElement('div');
    contact.className = 'meta';
    var mail = document.createElement('a');
    mail.href = 'mailto:' + item.email;
    text(mail, item.email);
    contact.appendChild(mail);
    if (item.phone) {
      contact.appendChild(document.createTextNode(' - '));
      var tel = document.createElement('a');
      tel.href = 'tel:' + item.phone;
      text(tel, item.phone);
      contact.appendChild(tel);
    }
    card.appendChild(contact);

    var body = document.createElement('pre');
    text(body, item.message);
    card.appendChild(body);

    if (item.build_summary) {
      var build = document.createElement('pre');
      text(build, 'Build plan\\n' + item.build_summary);
      card.appendChild(build);
    }

    if (item.parts_json) {
      try {
        var parts = JSON.parse(item.parts_json);
        if (parts.length) {
          var list = document.createElement('pre');
          text(list, 'Parts\\n' + parts.map(function (p) {
            return '- ' + (p.category || '') + ': ' + (p.name || '') + (p.price != null ? ' (EUR ' + p.price + ')' : '');
          }).join('\\n'));
          card.appendChild(list);
        }
      } catch (e) { /* ignore malformed attachment */ }
    }

    var actions = document.createElement('div');
    actions.className = 'bar';
    ['read', 'replied', 'won', 'archived', 'new'].forEach(function (s) {
      if (s === item.status) return;
      var b = document.createElement('button');
      b.className = 'ghost';
      text(b, 'Mark ' + s);
      b.addEventListener('click', function () { setStatus(item.id, s, b); });
      actions.appendChild(b);
    });
    var del = document.createElement('button');
    del.className = 'ghost';
    text(del, 'Delete');
    del.addEventListener('click', function () {
      if (!confirm('Permanently delete ' + item.id + '?')) return;
      fetch('/api/enquiry/' + encodeURIComponent(item.id), { method: 'DELETE' })
        .then(load)
        .catch(function () { alert('Delete failed'); });
    });
    actions.appendChild(del);
    card.appendChild(actions);

    return card;
  }

  function setStatus(id, status, button) {
    button.disabled = true;
    fetch('/api/enquiry/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: status })
    }).then(load).catch(function () { button.disabled = false; alert('Update failed'); });
  }

  function load() {
    var list = document.getElementById('list');
    var url = '/api/enquiries?limit=200&status=' + encodeURIComponent(state.status) +
      (state.q ? '&q=' + encodeURIComponent(state.q) : '');

    fetch(url).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('unauthorised'); }
      return r.json();
    }).then(function (data) {
      document.getElementById('sub').textContent = data.count + ' shown';
      list.textContent = '';
      if (!data.enquiries.length) {
        var empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No requests match this view yet.';
        list.appendChild(empty);
        return;
      }
      data.enquiries.forEach(function (item) { list.appendChild(renderCard(item)); });
    }).catch(function () {
      document.getElementById('sub').textContent = 'Could not load requests.';
    });

    fetch('/api/stats').then(function (r) { return r.json(); }).then(function (data) {
      if (data.ok) renderStats(data.totals || {});
    }).catch(function () {});
  }

  var debounce;
  document.getElementById('q').addEventListener('input', function (e) {
    clearTimeout(debounce);
    var value = e.target.value;
    debounce = setTimeout(function () { state.q = value; load(); }, 250);
  });
  document.getElementById('status').addEventListener('change', function (e) { state.status = e.target.value; load(); });
  document.getElementById('refresh').addEventListener('click', load);
  document.getElementById('csv').addEventListener('click', function () { location.href = '/api/export.csv'; });
  document.getElementById('signout').addEventListener('click', function () {
    fetch('/dashboard/session', { method: 'DELETE' }).then(function () { location.reload(); });
  });

  load();
})();
</script>
</body></html>`;
}

async function handleLogin(request, env) {
  const form = await request.formData().catch(() => null);
  const token = form ? String(form.get('token') || '') : '';

  if (!env.ADMIN_TOKEN) return dashboardLogin('ADMIN_TOKEN is not set on the server.');
  if (!safeEqual(token, env.ADMIN_TOKEN)) {
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing
    return dashboardLogin('That token is not correct.');
  }

  const session = await signSession(await sessionSecret(env), {
    sub: 'admin',
    exp: Date.now() + SESSION_TTL_MS,
  });

  return new Response(null, {
    status: 303,
    headers: {
      location: '/dashboard',
      'set-cookie':
        COOKIE_NAME + '=' + session + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
        Math.floor(SESSION_TTL_MS / 1000) + '; Secure',
      'cache-control': 'no-store',
    },
  });
}

async function requireAdmin(request, env) {
  const token = parseCookies(request)[COOKIE_NAME];
  return verifySession(await sessionSecret(env), token);
}

/* ------------------------------------------------------------------- router */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Everything except the API is checked for cross-site writes.
    const mutating = method !== 'GET' && method !== 'HEAD';

    if (pathname === '/api/enquiry' && method === 'POST') {
      if (!sameOrigin(request)) return fail(403, 'Cross-origin request blocked.');
      if (!env.DB) return fail(503, 'Storage is not configured yet.');
      return handleEnquiry(request, env);
    }

    if (pathname === '/dashboard/session') {
      if (method === 'POST') return handleLogin(request, env);
      if (method === 'DELETE') {
        return json({ ok: true }, 200, {
          'set-cookie': COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
        });
      }
      return fail(405, 'Method not allowed.');
    }

    if (pathname === '/dashboard' || pathname === '/dashboard/') {
      if (!(await requireAdmin(request, env))) return dashboardLogin('');
      return new Response(dashboardPage(), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'robots': 'noindex, nofollow',
        },
      });
    }

    if (pathname.startsWith('/api/')) {
      if (!(await requireAdmin(request, env))) return fail(401, 'Sign in at /dashboard first.');
      if (!env.DB) return fail(503, 'Storage is not configured yet.');
      if (mutating && !sameOrigin(request)) return fail(403, 'Cross-origin request blocked.');

      if (pathname === '/api/enquiries' && method === 'GET') return handleList(request, env, url);
      if (pathname === '/api/stats' && method === 'GET') return handleStats(env);
      if (pathname === '/api/export.csv' && method === 'GET') return handleCsv(env);
      if (pathname === '/api/rate-limits' && method === 'DELETE') return handleResetRateLimits(env);

      const match = pathname.match(/^\/api\/enquiry\/([A-Za-z0-9-]+)$/);
      if (match) {
        if (method === 'PATCH') return handleUpdate(request, env, match[1]);
        if (method === 'DELETE') return handleDelete(env, match[1]);
      }

      return fail(404, 'No such endpoint.');
    }

    // Anything else is the static site.
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404 || !(request.headers.get('accept') || '').includes('text/html')) {
        return asset;
      }
      // Unknown deep link: hand back the single page rather than a 404 page.
      return env.ASSETS.fetch(new Request(new URL('/', url).toString(), request));
    }

    return fail(404, 'Not found.');
  },
};
