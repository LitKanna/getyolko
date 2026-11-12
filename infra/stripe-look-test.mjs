// node infra/stripe-look-test.mjs : the Stripe pay page look must never stop a payment.
// Pulls the helpers out of the Worker source and runs them against a pretend Stripe.
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./cloudflare-worker.mjs', import.meta.url), 'utf8');
const grab = (start, end) => { const i = src.indexOf(start); const j = src.indexOf(end, i); if (i < 0 || j < 0) throw new Error('missing ' + start); return src.slice(i, j); };
const code = [
  'const STRIPE_BRAND = "YOLKO"; const UPSTREAM_ASSETS = "https://raw.example/SHA";',
  grab('const STRIPE_LOOK = {', '/** Build Stripe Checkout Session').replace(/\/\*\* Ensure Checkout[\s\S]*$/, ''),
  'return { STRIPE_LOOK, postCheckoutSession, stripeBrandFile, ensureStripeAccountLook, stripeAccountLook };',
].join('\n');
const mod = new Function(code)();
const kv = () => { const m = new Map(); return { m, get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => void m.set(k, v) }; };
let calls = [];
const ok = (cond, msg) => { if (!cond) { console.log("FAIL", msg); process.exitCode = 1; } };

// 1. Stripe takes the look
calls = []; globalThis.fetch = async (u, o) => { calls.push([u, String(o?.body || '')]); return { ok: true, json: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }) }; };
let env = { STRIPE_KEY: 'sk_x', DATA: kv() };
let params = new URLSearchParams({ mode: 'payment', ...mod.STRIPE_LOOK });
let r = await mod.postCheckoutSession(env, params);
ok(r.url && calls.length === 1 && calls[0][1].includes('branding_settings'), 'look accepted: one request, carries the look');
ok(calls[0][1].includes('background_color%5D=%23faf7f0') && calls[0][1].includes('button_color%5D=%23ffd32a'), 'cream page and yolk button sent');

// 2. Stripe refuses the look: second request goes without it and the payment page still comes back
calls = []; globalThis.fetch = async (u, o) => { const b = String(o?.body || ''); calls.push([u, b]); return { ok: true, json: async () => (b.includes('branding_settings') ? { error: { param: 'branding_settings', message: 'Received unknown parameter: branding_settings' } } : { id: 'cs_2', url: 'https://checkout.stripe.com/y' }) }; };
env = { STRIPE_KEY: 'sk_x', DATA: kv() }; params = new URLSearchParams({ mode: 'payment', ...mod.STRIPE_LOOK });
r = await mod.postCheckoutSession(env, params);
ok(r.url === 'https://checkout.stripe.com/y' && calls.length === 2 && !calls[1][1].includes('branding_settings') && calls[1][1].includes('mode=payment'), 'look refused: retried without it, got a pay page');
ok(env.DATA.m.has('stripe:look:refused') && JSON.parse(env.DATA.m.get('stripe:look:refused')).note.includes('unknown parameter'), 'refusal noted for the admin');

// 3. Stripe fails for another reason: error comes back, no false note
calls = []; globalThis.fetch = async (u, o) => { calls.push(1); return { ok: false, json: async () => ({ error: { message: 'card network down' } }) }; };
env = { STRIPE_KEY: 'sk_x', DATA: kv() }; params = new URLSearchParams({ mode: 'payment', ...mod.STRIPE_LOOK });
r = await mod.postCheckoutSession(env, params);
ok(r.error && calls.length === 2 && !env.DATA.m.has('stripe:look:refused'), 'other failure: error returned, no note');

// 4. account look: uploads each picture once, then sets colours and file ids
calls = []; globalThis.fetch = async (u, o) => {
  calls.push([String(u), o?.body]);
  if (String(u).startsWith('https://raw.example')) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  if (String(u).startsWith('https://files.stripe.com')) return { ok: true, json: async () => ({ id: 'file_' + o.body.get('purpose') }) };
  return { ok: true, json: async () => ({ settings: { branding: { icon: 'file_a', logo: 'file_b', primary_color: '#14120e', secondary_color: '#faf7f0' } } }) };
};
env = { STRIPE_KEY: 'sk_x', DATA: kv() };
r = await mod.ensureStripeAccountLook(env);
const acct = calls.find((c) => c[0] === 'https://api.stripe.com/v1/account');
ok(r.ok && r.icon && r.logo && r.primaryColor === '#14120e', 'account look reported back');
ok(acct && String(acct[1]).includes('icon%5D=file_business_icon') && String(acct[1]).includes('logo%5D=file_business_logo') && String(acct[1]).includes('primary_color%5D=%2314120e'), 'account gets colours and both file ids');
const up = calls.find((c) => c[0].startsWith('https://files.stripe.com')); const f = up[1].get('file');
ok(f.name === 'icon-512.png' && f.type === 'image/png' && f.size === 3, 'picture uploaded as a PNG file');
const n = calls.length; await mod.ensureStripeAccountLook(env);
ok(calls.length === n + 1, 'second run reuses the kept file ids (one request)');

// 5. account refuses: reported, nothing thrown
globalThis.fetch = async (u) => (String(u).includes('/v1/account') ? { ok: false, json: async () => ({ error: { message: 'not allowed' } }) } : { ok: false });
r = await mod.ensureStripeAccountLook({ STRIPE_KEY: 'sk_x', DATA: kv() });
ok(r.ok === false && r.error === 'not allowed', 'account refusal reported, not thrown');
if (!process.exitCode) console.log("stripe look tests passed");
