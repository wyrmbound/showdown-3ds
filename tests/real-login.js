// node tests/real-login.js : runs the app's password-login flow against the REAL Showdown login
// API with a made-up account name (never a real account), using fetch in place of the C client.
// Checks that the reply is understood and that neither the password nor a throwaway session is saved.
'use strict';
const cleanup = require('./boot-node')();
const name = `sd3dsnobody${Math.floor(Math.random() * 1e5)}`;
const app = new App();
app.cfg = {name};
app.saveConfig();
let ws, now = 0, prompts = 0;
const pump = () => {
  now += 1200; app.tick(now);
  for (const [cmd, ...a] of app.takeCommands()) {
    if (cmd === 'ws_open') { ws = new WebSocket(`ws://${a[0]}:${a[1]}${a[2]}`); ws.onopen = () => app.netEvent('open'); ws.onmessage = e => app.netEvent('message', e.data); }
    else if (cmd === 'ws_send') { if (!a[0].startsWith('|/trn')) console.log('>>', a[0]); ws.send(a[0]); }
    else if (cmd === 'ws_close') ws.close();
    else if (cmd === 'http_get') fetch(a[1]).then(async r => app.httpDone(a[0], r.status, await r.text(), ''));
    else if (cmd === 'https') {
      console.log(`https ${a[0]} ${a[1]} (${a[2] ? 'POST' : 'GET'})`);
      fetch(a[1], a[2] ? {method: 'POST', body: a[2], headers: {'Content-Type': 'application/x-www-form-urlencoded'}} : {headers: a[3] ? {Cookie: a[3]} : {}})
        .then(async r => app.httpDone(a[0], r.status, await r.text(), (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ')));
    } else if (cmd === 'keyboard') {
      if (a[0] === 'password') prompts++;
      app.keyboardDone(a[0], a[0] === 'password' && prompts === 1 ? 'not-a-real-password' : null);
    }
  }
};
const iv = setInterval(pump, 20);
app.select('account');
app.select('loginpw');
setTimeout(() => {
  clearInterval(iv);
  const saved = require('fs').readFileSync(__DATA + '/config.txt', 'utf8');
  console.log('screen:', app.screen, '| named:', app.net?.named, '| notice:', app.notice);
  console.log('password prompts:', prompts, '| config saved:', JSON.stringify(saved));
  // A made-up (unregistered) name gets no real session, so nothing but the name may be saved.
  const ok = !/not-a-real-password/.test(saved) && !/sid=/.test(saved) && app.password == null && app.net?.named;
  console.log(ok ? 'ok   logged in; password and throwaway session cookie not stored' : 'FAIL');
  // Reusing a saved session needs a registered account (made-up names get none): checked on the console.
  ws?.close(); cleanup(); process.exit(ok ? 0 : 1);
}, 8000);
