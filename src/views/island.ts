/**
 * src/views/island.ts — the only client-side JavaScript in the product.
 *
 * Two things genuinely cannot be done on the server:
 *   1. `navigator.credentials` — the passkey ceremony happens on the device;
 *   2. image compression before upload — a 12 MB phone photo must not cross a
 *      Matrouh 3G connection at all, so it has to shrink in the browser.
 *
 * Everything else is server-rendered HTML. Written as plain inline script rather
 * than a bundle: ~2 KB against a ≤120 KB budget, and no build step to keep alive.
 *
 * Both islands degrade: if JS never runs, the login page still shows the help
 * path, and the upload form still posts the original file.
 */

/** Base64url ⇄ ArrayBuffer, the conversion every WebAuthn integration needs. */
const HELPERS = `
const b64u = {
  dec: s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')
        .padEnd(s.length + (4 - s.length % 4) % 4, '=')), c => c.charCodeAt(0)),
  enc: b => btoa(String.fromCharCode(...new Uint8Array(b)))
        .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')
};
const say = (el, text, kind) => {
  const box = document.getElementById('js-msg');
  if (!box) return;
  box.className = 'banner ' + (kind || 'warn');
  box.textContent = text;
  box.hidden = false;
};
`;

export const PASSKEY_LOGIN_JS = `<script>
${HELPERS}
(function () {
  const form = document.getElementById('login-form');
  if (!form || !window.PublicKeyCredential) return;   // no passkeys: server flow stands
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const phone = form.querySelector('#phone').value;
    btn.disabled = true; btn.textContent = MSG.working;
    try {
      const r = await fetch('/api/auth/login/begin', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || MSG.failed);
      if (data.needsActivation) { say(null, MSG.needsActivation, 'info'); return; }

      const o = data.options;
      o.challenge = b64u.dec(o.challenge);
      (o.allowCredentials || []).forEach(c => c.id = b64u.dec(c.id));
      const cred = await navigator.credentials.get({ publicKey: o });

      const v = await fetch('/api/auth/login/finish', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: data.key, response: {
          id: cred.id, rawId: b64u.enc(cred.rawId), type: cred.type,
          clientExtensionResults: cred.getClientExtensionResults(),
          response: {
            clientDataJSON: b64u.enc(cred.response.clientDataJSON),
            authenticatorData: b64u.enc(cred.response.authenticatorData),
            signature: b64u.enc(cred.response.signature),
            userHandle: cred.response.userHandle ? b64u.enc(cred.response.userHandle) : undefined
          }
        }})
      });
      const out = await v.json();
      if (!v.ok) throw new Error(out.error || MSG.failed);
      location.href = '/';
    } catch (err) {
      // NotAllowedError = the person cancelled or the sensor timed out. That is
      // not an error to apologise for; it is a normal thing to do by accident.
      say(null, err.name === 'NotAllowedError' ? MSG.cancelled : (err.message || MSG.failed));
    } finally {
      btn.disabled = false; btn.textContent = MSG.submit;
    }
  });
})();
</script>`;

export const PASSKEY_ENROLL_JS = `<script>
${HELPERS}
(function () {
  const btn = document.getElementById('enroll-btn');
  if (!btn) return;
  if (!window.PublicKeyCredential) { say(null, MSG.noPasskey, 'warn'); btn.disabled = true; return; }
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = MSG.working;
    try {
      const r = await fetch('/api/auth/enroll/begin', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || MSG.failed);
      const o = data.options;
      o.challenge = b64u.dec(o.challenge);
      o.user.id = b64u.dec(o.user.id);
      (o.excludeCredentials || []).forEach(c => c.id = b64u.dec(c.id));
      const cred = await navigator.credentials.create({ publicKey: o });
      const v = await fetch('/api/auth/enroll/finish', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: data.key, label: navigator.platform || 'جهاز', response: {
          id: cred.id, rawId: b64u.enc(cred.rawId), type: cred.type,
          clientExtensionResults: cred.getClientExtensionResults(),
          response: {
            clientDataJSON: b64u.enc(cred.response.clientDataJSON),
            attestationObject: b64u.enc(cred.response.attestationObject),
            transports: cred.response.getTransports ? cred.response.getTransports() : []
          }
        }})
      });
      const out = await v.json();
      if (!v.ok) throw new Error(out.error || MSG.failed);
      location.href = '/activate/done';
    } catch (err) {
      say(null, err.name === 'NotAllowedError' ? MSG.cancelled : (err.message || MSG.failed));
      btn.disabled = false; btn.textContent = MSG.enroll;
    }
  });
})();
</script>`;

/**
 * Client-side image compression.
 *
 * Three jobs, and the third is the one people forget:
 *   · shrink 4–12 MB phone photos to ~500 KB so the upload finishes on 3G;
 *   · show progress, because a silent 40-second wait reads as a broken app;
 *   · **strip EXIF**, geolocation above all. Re-encoding through a canvas drops
 *     every EXIF tag as a side effect — a maintenance photo would otherwise
 *     broadcast the exact flat it was taken in (R-026).
 */
export const UPLOAD_JS = `<script>
${HELPERS}
(function () {
  const input = document.getElementById('receipt-file');
  const preview = document.getElementById('receipt-preview');
  const hidden = document.getElementById('receipt-data');
  const sizeEl = document.getElementById('receipt-size');
  if (!input) return;

  // Measured 2026-08-04 against a photographed PAPER receipt — the worst
  // realistic input, far worse than a bank-app screenshot:
  //   1600px q82 -> 41 KB      1200px q60 -> 6 KB
  // 1200/q60 keeps every printed digit legible and is ~7x smaller, which is
  // what makes storing receipts in D1 viable at all (ADR-023).
  const MAX_EDGE = 1200, TARGET_BYTES = 200 * 1024, START_Q = 0.60;

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    say(null, MSG.compressing, 'info');
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * scale);
      cv.height = Math.round(bmp.height * scale);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);

      // Step the quality down until it fits. Re-encoding also drops EXIF —
      // including GPS — which is a requirement, not a bonus.
      let blob = null, q = START_Q;
      for (let i = 0; i < 5; i++) {
        blob = await new Promise(res => cv.toBlob(res, 'image/webp', q));
        if (!blob || blob.size <= TARGET_BYTES) break;
        q -= 0.12;
      }
      if (!blob) throw new Error(MSG.tooBig);

      preview.src = URL.createObjectURL(blob);
      preview.hidden = false;
      sizeEl.textContent = Math.round(blob.size / 1024) + ' KB';
      const buf = await blob.arrayBuffer();
      hidden.value = b64u.enc(buf);
      say(null, MSG.ready, 'ok');
      // Local draft: if the connection dies now, nothing typed is lost.
      try { sessionStorage.setItem('pay-draft-img', hidden.value); } catch (e) {}
    } catch (err) {
      say(null, MSG.tooBig);
    }
  });
})();
</script>`;

/**
 * Step 5 — send the accumulated draft plus the image the browser is holding.
 *
 * The five text fields already live on the server (`payment_drafts`), so this
 * carries only the image. If sessionStorage lost it — the tab was killed, the
 * phone reclaimed memory — the resident re-takes ONE photo rather than
 * re-entering six fields.
 *
 * The button disables on click. Not cosmetic: an admin's phone on a bad
 * connection retries, and two receipts for one transfer is a real support call.
 */
export const SUBMIT_JS = `<script>
${HELPERS}
(function () {
  const btn = document.getElementById('submit-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const img = sessionStorage.getItem('pay-draft-img');
    if (!img) { say(null, MSG.needImage, 'warn'); return; }
    btn.disabled = true; btn.textContent = MSG.working;
    try {
      const r = await fetch('/api/payments/submit-draft', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: img })
      });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || MSG.failed);
      sessionStorage.removeItem('pay-draft-img');
      if (out.duplicateOf) sessionStorage.setItem('pay-dup', out.duplicateOf);
      location.href = '/pay/done/' + encodeURIComponent(out.receiptNo);
    } catch (err) {
      say(null, err.message || MSG.failed);
      btn.disabled = false; btn.textContent = MSG.submit;
    }
  });
})();
</script>`;

/** Redeem a printed recovery code, then go straight into enrolling a new
 *  passkey — a recovered account with no passkey is an account the resident
 *  still cannot open tomorrow. */
export const RECOVER_JS = `<script>
${HELPERS}
(function () {
  const form = document.getElementById('recover-form');
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = MSG.working;
    try {
      const r = await fetch('/api/auth/recover', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: form.querySelector('#code').value })
      });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || MSG.failed);
      location.href = out.next;
    } catch (err) {
      say(null, err.message || MSG.failed);
      btn.disabled = false; btn.textContent = MSG.confirm || MSG.submit;
    }
  });
})();
</script>`;

/**
 * PUSH_JS — the enable-notifications button.
 *
 * The only client-side code a resident meets besides the passkey ceremony and
 * image compression. It is an island, not a framework: register the worker, ask
 * permission, post the subscription, done.
 *
 * ## Why the button says what it says
 * Browsers only allow the permission prompt in response to a tap, and a prompt
 * that arrives unexplained is denied — permanently, with no way back except
 * browser settings a resident here will not find. So the button explains first
 * and asks second, and a denial is answered with what to do about it rather
 * than a shrug.
 */
export const PUSH_JS = `<script>
(() => {
  const btn = document.getElementById('push-btn');
  const out = document.getElementById('push-msg');
  if (!btn) return;
  const say = (t) => { if (out) { out.textContent = t; out.hidden = false; } };

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.hidden = true; say(MSG.unsupported); return;
  }
  if (Notification.permission === 'denied') { btn.hidden = true; say(MSG.blocked); return; }

  const b64 = (s) => {
    const p = (s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g,'+').replace(/_/g,'/');
    const raw = atob(p); const a = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i);
    return a;
  };

  btn.addEventListener('click', async () => {
    btn.disabled = true; say(MSG.working);
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { say(MSG.blocked); btn.disabled = false; return; }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64(btn.dataset.key),
      });
      const j = sub.toJSON();
      const r = await fetch('/api/push/subscribe', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
          label: navigator.userAgent.slice(0, 60),
        }),
      });
      if (!r.ok) throw new Error('save failed');
      btn.hidden = true; say(MSG.enabled);
    } catch (e) {
      say(MSG.failed); btn.disabled = false;
    }
  });
})();
</script>`;
