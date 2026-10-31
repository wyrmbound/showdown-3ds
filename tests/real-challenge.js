// node tests/real-challenge.js : checks challenges on the REAL Showdown server with two guest
// clients running the app's code. A challenges B, B should see it, then B declines. No battle.
'use strict';
const cleanup = require('./boot-node')();
const tag = Math.floor(Math.random() * 1e5);
const log = [];

function client(name, answers) {
  const app = new App();
  app.cfg = {name}; // default server + login server, like the 3DS
  const c = {app, name, ws: null, now: 0, answers};
  c.pump = () => {
    c.now += 1200;
    app.tick(c.now);
    for (const [cmd, ...args] of app.takeCommands()) {
      if (cmd === 'ws_open') {
        const ws = c.ws = new WebSocket(`ws://${args[0]}:${args[1]}${args[2]}`);
        ws.onopen = () => app.netEvent('open');
        ws.onmessage = e => {
          for (const l of String(e.data).split('\n')) if (/^\|(pm|popup|updatechallenges|nametaken)\|/.test(l)) log.push(`${name} << ${l.slice(0, 160)}`);
          app.netEvent('message', e.data);
        };
        ws.onclose = e => app.netEvent('closed', e.reason);
      } else if (cmd === 'ws_send') { log.push(`${name} >> ${args[0]}`); c.ws.send(args[0]); }
      else if (cmd === 'ws_close') c.ws.close();
      else if (cmd === 'http_get') fetch(args[1]).then(async r => app.httpDone(args[0], r.status, await r.text()), () => app.httpDone(args[0], 0, null));
      else if (cmd === 'keyboard') app.keyboardDone(args[0], c.answers[args[0]]);
    }
  };
  return c;
}

const wait = (cond, ms, clients) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    for (const c of clients) c.pump();
    if (cond()) { clearInterval(iv); resolve(); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout: ' + clients.map(c => `${c.name}=${c.app.screen} "${c.app.view.title}" ${c.app.notice}`).join(', '))); }
  }, 30);
});

(async () => {
  const b = client(`sd3dsB${tag}`, {});
  const a = client(`sd3dsA${tag}`, {challenge: b.name});
  const both = [a, b];
  for (const c of both) c.app.select('online');
  await wait(() => both.every(c => c.app.screen === 'lobby'), 20000, both);
  console.log('ok   both logged in on the real server:', a.app.net.userName, '/', b.app.net.userName);
  a.app.select('challenge');
  await wait(() => a.app.screen === 'format', 5000, both);
  a.app.select('gen9randombattle');
  await wait(() => b.app.screen === 'challenged' || a.app.screen === 'lobby', 20000, both);
  console.log(b.app.screen === 'challenged' ? `ok   B received: ${b.app.view.title}` : `FAIL A is back in the lobby: ${a.app.notice}`);
  if (b.app.screen === 'challenged') { b.app.select('decline'); await wait(() => a.app.screen === 'lobby', 10000, both); console.log('ok   decline reached A:', a.app.notice); }
})().catch(e => console.log('FAIL', e.message)).finally(() => {
  console.log(log.join('\n'));
  setTimeout(() => { cleanup(); process.exit(0); }, 500);
});
