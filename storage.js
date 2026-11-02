// Optional cloud storage (Cloudflare R2, or any S3 compatible service) with no external packages.
// Turned on when S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are set.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');

const cfg = {
  endpoint: (process.env.S3_ENDPOINT || '').replace(/\/+$/, ''),
  bucket: process.env.S3_BUCKET || '',
  key: process.env.S3_ACCESS_KEY_ID || '',
  secret: process.env.S3_SECRET_ACCESS_KEY || '',
  region: process.env.S3_REGION || 'auto',
};
const enabled = !!(cfg.endpoint && cfg.bucket && cfg.key && cfg.secret);

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
const rfc3986 = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encodePath = p => p.split('/').map(rfc3986).join('/');

function amzNow(now = new Date()) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, date: amzDate.slice(0, 8) };
}
function signingKey(secret, date, region) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), 's3'), 'aws4_request');
}

// Header based signature (used for uploads, downloads, deletes).
function signRequest({ method, host, path, headers = {}, payloadHash = 'UNSIGNED-PAYLOAD', key, secret, region, now }) {
  const { amzDate, date } = amzNow(now);
  const h = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const lower = {};
  for (const [k, v] of Object.entries(h)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(lower).sort();
  const canonical = [method, path, '', names.map(n => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const signature = hmac(signingKey(secret, date, region), toSign).toString('hex');
  return {
    headers: { ...h, Authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` },
    signature,
  };
}

// Pre-signed link (lets the browser fetch a private video directly from storage for a while).
function presignUrl({ host, path, origin, expires, extra = {}, key, secret, region, now }) {
  const { amzDate, date } = amzNow(now);
  const scope = `${date}/${region}/s3/aws4_request`;
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${key}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
    ...extra,
  };
  const query = Object.keys(q).sort().map(k => `${rfc3986(k)}=${rfc3986(q[k])}`).join('&');
  const canonical = ['GET', path, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const signature = hmac(signingKey(secret, date, region), toSign).toString('hex');
  return { url: `${origin}${path}?${query}&X-Amz-Signature=${signature}`, signature };
}

function target(objectKey) {
  const u = new URL(cfg.endpoint);
  const basePath = u.pathname.replace(/\/+$/, '');
  return { u, host: u.host, origin: u.origin, path: `${basePath}/${rfc3986(cfg.bucket)}/${encodePath(objectKey)}` };
}

function request(method, objectKey, { headers = {}, body, bodyStream, toFile } = {}) {
  return new Promise((resolve, reject) => {
    const t = target(objectKey);
    const { headers: signed } = signRequest({ method, host: t.host, path: t.path, headers, key: cfg.key, secret: cfg.secret, region: cfg.region });
    const lib = t.u.protocol === 'http:' ? http : https;
    const req = lib.request({ method, hostname: t.u.hostname, port: t.u.port || undefined, path: t.path, headers: signed }, res => {
      if (toFile && res.statusCode === 200) {
        const out = fs.createWriteStream(toFile);
        res.pipe(out);
        out.on('finish', () => resolve({ status: 200 }));
        out.on('error', reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(10 * 60e3, () => req.destroy(new Error('Storage request timed out')));
    if (bodyStream) bodyStream.pipe(req);
    else req.end(body);
  });
}

async function check(res, what) {
  if (res.status >= 200 && res.status < 300) return res;
  throw new Error(`${what} failed (${res.status}) ${res.body ? res.body.toString().slice(0, 200) : ''}`);
}

const storage = {
  enabled,
  async putFile(objectKey, file, contentType) {
    const size = fs.statSync(file).size;
    return check(await request('PUT', objectKey, {
      headers: { 'content-type': contentType, 'content-length': size },
      bodyStream: fs.createReadStream(file),
    }), 'Upload of ' + objectKey);
  },
  async putBuffer(objectKey, buf, contentType) {
    return check(await request('PUT', objectKey, { headers: { 'content-type': contentType, 'content-length': buf.length }, body: buf }), 'Upload of ' + objectKey);
  },
  async getBuffer(objectKey) {
    const r = await request('GET', objectKey);
    if (r.status === 404) return null;
    await check(r, 'Download of ' + objectKey);
    return r.body;
  },
  async getToFile(objectKey, file) {
    const r = await request('GET', objectKey, { toFile: file });
    return check(r, 'Download of ' + objectKey);
  },
  async remove(objectKey) {
    const r = await request('DELETE', objectKey);
    if (r.status !== 404) await check(r, 'Delete of ' + objectKey);
  },
  link(objectKey, { download } = {}) {
    const t = target(objectKey);
    const extra = download ? { 'response-content-disposition': `attachment; filename="${download.replace(/[^\w .-]+/g, '')}"` } : {};
    return presignUrl({ host: t.host, path: t.path, origin: t.origin, expires: 6 * 3600, extra, key: cfg.key, secret: cfg.secret, region: cfg.region }).url;
  },
};

module.exports = { storage, signRequest, presignUrl };
