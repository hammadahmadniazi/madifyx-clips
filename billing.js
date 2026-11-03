// Stripe billing with no packages: Checkout for upgrades, the Customer Portal for
// managing or cancelling, and signed webhooks to keep plans in sync.
// Set STRIPE_SECRET_KEY, STRIPE_PRICE_ID (a recurring monthly price) and STRIPE_WEBHOOK_SECRET.
const crypto = require('crypto');

const KEY = process.env.STRIPE_SECRET_KEY || '';
const PRICE = process.env.STRIPE_PRICE_ID || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const API = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '');

const billingReady = () => !!(KEY && PRICE);

// Stripe expects form encoding with bracketed keys: line_items[0][price]=...
function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

async function stripe(method, path, params) {
  if (!KEY) throw new Error('Stripe is not set up');
  const body = params && method !== 'GET' ? encode(params) : undefined;
  const qs = params && method === 'GET' ? '?' + encode(params) : '';
  const r = await fetch(API + path + qs, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Stripe error ${r.status}`);
  return j;
}

function createCheckout({ workspaceId, email, customerId, successUrl, cancelUrl }) {
  return stripe('POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: PRICE, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: workspaceId,
    customer: customerId || undefined,
    customer_email: customerId ? undefined : email,
    allow_promotion_codes: 'true',
    subscription_data: { metadata: { workspace_id: workspaceId } },
    metadata: { workspace_id: workspaceId },
  });
}
const getCheckout = id => stripe('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);
const getSubscription = id => stripe('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);
const listSubscriptions = customer => stripe('GET', '/v1/subscriptions', { customer, status: 'all', limit: 5 });
const createPortal = ({ customerId, returnUrl }) => stripe('POST', '/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl });

// Shows the price on the upgrade button, e.g. "$9/month". Cached for an hour.
let priceCache = { at: 0, label: null };
async function priceLabel() {
  if (!billingReady()) return null;
  if (Date.now() - priceCache.at < 3600e3) return priceCache.label;
  try {
    const p = await stripe('GET', `/v1/prices/${encodeURIComponent(PRICE)}`);
    const amount = (p.unit_amount || 0) / 100;
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: (p.currency || 'usd').toUpperCase(), minimumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
    const every = p.recurring ? (p.recurring.interval_count > 1 ? `${p.recurring.interval_count} ${p.recurring.interval}s` : p.recurring.interval) : 'once';
    priceCache = { at: Date.now(), label: `${money}/${every}` };
  } catch (e) { console.error('Could not read the Stripe price:', e.message); priceCache = { at: Date.now() - 3000e3, label: null }; }
  return priceCache.label;
}

// Checks the Stripe-Signature header so nobody can fake a "payment succeeded" message.
function verifyWebhook(rawBody, header) {
  if (!WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  const parts = Object.fromEntries(String(header || '').split(',').map(kv => kv.split('=')).filter(x => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header || '').split(',').filter(x => x.trim().startsWith('v1=')).map(x => x.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) throw new Error('Missing signature');
  if (Math.abs(Date.now() / 1000 - t) > 300) throw new Error('Signature too old');
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex');
  const ok = sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error('Bad signature');
  return JSON.parse(rawBody);
}

module.exports = { billingReady, createCheckout, getCheckout, getSubscription, listSubscriptions, createPortal, priceLabel, verifyWebhook, encode };
