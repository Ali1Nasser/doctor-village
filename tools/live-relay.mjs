/**
 * tools/live-relay.mjs — put a real browser in front of the DEPLOYED site.
 *
 * ## Why this exists
 *
 * Chromium in this sandbox cannot reach any HTTPS host: every navigation dies
 * with `ERR_CONNECTION_RESET`, including `https://example.com`, with or without
 * the egress proxy configured. Node's `fetch` and `curl` go through fine. So
 * the browser cannot talk to production, but this process can.
 *
 * This relay sits on 127.0.0.1, forwards every request to the deployed Worker
 * with `fetch`, and hands the answer back to Chromium **verbatim**. What the
 * browser renders, executes and screenshots is exactly the bytes production
 * served — the deployed bundle, the deployed database, the deployed Worker.
 *
 * ## The two things it changes, and why neither is the app
 *
 *   1. **`Secure` is stripped from `Set-Cookie`.** The browser is on
 *      `http://127.0.0.1`, and a `Secure` cookie is dropped on plain HTTP — so
 *      without this, nobody can stay logged in and the whole walk tests the
 *      login page forty times. The flag is a transport property of the hop
 *      between Chromium and this process, not behaviour under test. (`HttpOnly`
 *      and `SameSite` are left exactly as production set them.)
 *   2. **`content-encoding` / `content-length` are dropped**, because `fetch`
 *      has already decompressed the body and re-announcing gzip would make
 *      Chromium fail to parse it.
 *
 * Everything else — status, `location`, `cache-control`, `content-type`, the
 * body itself — passes through untouched.
 *
 * ## `/__roles`
 *
 * The walkthrough asks the server which session token belongs to which role.
 * Production has no such endpoint and must not; this relay answers it from a
 * local JSON file the operator prepares (probe sessions opened directly in the
 * database, then revoked afterwards).
 *
 *   node tools/live-relay.mjs <origin> <roles.json> [port]
 *
 * ⚠️ This points a test harness at PRODUCTION. Everything the walk does is a
 * real write to the real database. Read the cleanup section of whatever script
 * drives it before running it.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const ORIGIN = process.argv[2] ?? 'https://qaryat-atebaa.qaryat-atebaa-portal.workers.dev';
const ROLES = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const PORT = Number(process.argv[4] ?? 8788);

/** Headers that describe the HOP, not the answer. Re-sending them lies. */
const DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding',
                      'connection', 'keep-alive', 'strict-transport-security']);

const server = createServer(async (req, res) => {
  if (req.url === '/__roles') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(ROLES));
    return;
  }

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined
    : await new Promise(done => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => done(Buffer.concat(chunks)));
      });

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'accept-encoding', 'content-length'].includes(k)) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }

  let upstream;
  try {
    upstream = await fetch(ORIGIN + req.url, {
      method: req.method, headers, body, redirect: 'manual',
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('relay could not reach the deployed site: ' + e);
    return;
  }

  const out = {};
  upstream.headers.forEach((v, k) => { if (!DROP.has(k.toLowerCase())) out[k] = v; });

  // Set-Cookie needs the multi-value accessor; `forEach` folds duplicates into
  // one comma-joined string, which is exactly the trap that cost this project a
  // production bug two sessions ago.
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  delete out['set-cookie'];

  res.writeHead(upstream.status, {
    ...out,
    ...(cookies.length ? { 'set-cookie': cookies.map(c => c.replace(/;\s*Secure/gi, '')) } : {}),
  });
  res.end(Buffer.from(await upstream.arrayBuffer()));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`  relaying ${ORIGIN}  ->  http://127.0.0.1:${PORT}`);
  console.log('  ⚠️  every write the browser makes lands on the real database');
});
