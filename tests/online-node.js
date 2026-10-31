// node tests/online-node.js [host:port] : two app instances log in to a (local, noguestsecurity)
// Showdown server, one challenges the other, and they battle to the end. Then a random battle.
'use strict';
const cleanup = require('./boot-node')();
const server = process.argv[2] || 'localhost:8001';

function client(name, answers) {
  const app = new App();
  app.cfg = {name, server, login: ''};
  const c = {app, name, errors: [], ws: null, now: 0, answers};
  c.pump = () => {
    c.now += 1200;
    app.tick(c.now);
    for (const [cmd, ...args] of app.takeCommands()) {
      if (cmd === 'ws_open') {
        const ws = c.ws = new WebSocket(`ws://${args[0]}:${args[1]}${args[2]}`);
        ws.onopen = () => app.netEvent('open');
        ws.onmessage = e => {
          if (process.env.TRACE) for (const l of String(e.data).split('\n')) if (/^\|(error|c|request|turn|win|inactive|popup)\|/.test(l)) console.log(`${name} << ${l.slice(0, 120)}`);
          app.netEvent('message', e.data);
        };
        ws.onclose = e => app.netEvent('closed', e.reason);
      } else if (cmd === 'ws_send') { if (process.env.TRACE) console.log(`${name} >> ${args[0]}`); c.ws.send(args[0]); }
      else if (cmd === 'ws_close') c.ws.close();
      else if (cmd === 'keyboard') app.keyboardDone(args[0], c.answers[args[0]]);
      else c.errors.push('unexpected command ' + cmd);
    }
    if (/^Error/.test(app.notice)) c.errors.push(app.notice);
  };
  return c;
}

// Same random policy as drive.js, one decision per pump.
function play(c) {
  const v = c.app.view;
  if (!v || v.screen !== 'battle') return;
  for (const line of v.log) if (/undefined|NaN|\[object/.test(line)) c.errors.push('bad log line: ' + line);
  const ids = v.buttons.filter(b => b.enabled).map(b => b.id);
  const pick = l => l[Math.floor(Math.random() * l.length)];
  if (ids.includes('continue')) { c.done = {winner: c.app.tracker.winner, turns: c.app.tracker.turn}; c.app.select('continue'); }
  else if (ids.includes('skip')) c.app.select('skip');
  else if (v.layout === 'moves') c.app.select(pick(ids.filter(i => i.startsWith('move'))));
  else if (v.layout === 'party') c.app.select(pick(ids.filter(i => i.startsWith('mon'))));
}

const wait = (cond, ms, clients) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    for (const c of clients) { c.pump(); play(c); }
    if (cond()) { clearInterval(iv); resolve(); }
    else if (Date.now() - t0 > ms) {
      clearInterval(iv);
      reject(new Error('timeout; screens: ' + clients.map(c => `${c.name}=${c.app.screen} "${c.app.view.title}" ${c.app.notice} pms=${JSON.stringify(c.app.net?.pms)} errors=${c.errors.join('|')} log=${JSON.stringify(c.app.tracker.log.slice(-4))}`).join(', ')));
    }
  }, 15);
});

// --bot: one client that searches a random battle and plays it (opponent for host_main online).
if (process.argv.includes('--bot')) {
  (async () => {
    const bot = client(`NodeBot ${process.pid % 100000}`, {}); // unique: Showdown merges same-name connections
    bot.app.select('online');
    await wait(() => bot.app.screen === 'lobby', 15000, [bot]);
    bot.app.select('search');
    bot.app.select('gen9randombattle');
    await wait(() => bot.done, 240000, [bot]);
    console.log(`bot: battle finished, winner ${bot.done.winner}`);
    bot.ws.close();
    cleanup();
    process.exit(0);
  })().catch(e => { console.log('bot FAIL', e.message); cleanup(); process.exit(1); });
} else (async () => {
  const a = client('Bot A 3ds', {challenge: 'Bot B 3ds', 'pm-to': 'Bot B 3ds', pm: 'hello from A', chat: 'gl hf'});
  const b = client('Bot B 3ds', {});
  const both = [a, b];
  for (const c of both) c.app.select('online');
  await wait(() => both.every(c => c.app.screen === 'lobby'), 15000, both);
  console.log('ok   both logged in:', a.app.net.userName, '/', b.app.net.userName);

  a.app.select('messages');
  a.app.select('newpm');
  // Unregistered names can't send PMs on Showdown: then A must show the server's explanation.
  await wait(() => b.app.net.pms.bota3ds?.unread === 1 || /registered/.test(a.app.net.pms.botb3ds?.lines.join('')), 10000, both);
  if (b.app.net.pms.bota3ds) {
    if (b.app.view.buttons.find(x => x.id === 'messages')?.sub !== '1 unread') throw new Error('B lobby should show 1 unread');
    b.app.select('messages');
    b.app.select('conv-bota3ds');
    if (b.app.net.pms.bota3ds.unread !== 0 || !b.app.view.text.includes('Bot A 3ds: hello from A')) throw new Error('B conversation view wrong: ' + b.app.view.text);
    b.app.select('back'); b.app.select('back');
  } else {
    console.log('ok   (server refuses PMs from unregistered names; A shows: ' + a.app.net.pms.botb3ds.lines.at(-1) + ')');
  }
  a.app.select('back'); a.app.select('back');
  console.log('ok   private messages: send, receive or server refusal handled');

  a.app.select('challenge');
  await wait(() => a.app.screen === 'format', 5000, both);
  a.app.select('gen9ou');
  a.app.select('rental');
  await wait(() => b.app.screen === 'challenged', 15000, both);
  console.log('ok   challenge received:', b.app.view.title, b.app.view.text);
  b.app.select('accept');
  b.app.select('team-0'); // the fixture's 3-mon OU team
  await wait(() => both.every(c => c.app.screen === 'battle'), 15000, both);
  console.log('ok   OU battle started in', a.app.room);
  // A third console watches it: Watch -> format -> the server's room list -> joined as a spectator.
  // Pumped on its own: play() would press its Leave button.
  const w = client('Bot W 3ds', {});
  const pumpW = setInterval(w.pump, 15);
  w.app.select('online');
  await wait(() => w.app.screen === 'lobby', 15000, both);
  w.app.select('watch'); w.app.select('gen9ou');
  await wait(() => w.app.view.screen === 'battle' && w.app.room === a.app.room && w.app.tracker.turn > 0, 20000, both);
  if (!w.app.view.buttons.some(x => x.id === 'continue') || w.app.view.buttons.some(x => x.id === 'forfeit')) throw new Error('spectator buttons: ' + JSON.stringify(w.app.view.buttons));
  console.log(`ok   W is watching ${w.app.room} at turn ${w.app.tracker.turn}: ${w.app.view.top.myName} vs ${w.app.view.top.foeName}`);
  await wait(() => a.app.view.buttons.some(x => x.id === 'chat'), 15000, both);
  a.app.select('chat'); // the on-screen keyboard: type a line and send it
  for (const ch of 'gl hf') a.app.select(ch === ' ' ? 'space' : `k:${ch}`);
  if (a.app.view.text !== 'gl hf_') throw new Error('typed text: ' + a.app.view.text);
  a.app.select('send');
  // Like PMs, battle chat needs a registered name; then A must show the server's reason.
  await wait(() => b.app.tracker.log.includes('\x01Bot A 3ds: gl hf') || a.app.tracker.log.some(l => /registered to chat/.test(l)), 10000, both);
  console.log(b.app.tracker.log.includes('\x01Bot A 3ds: gl hf') ? 'ok   battle chat reached the opponent'
    : 'ok   (server refuses battle chat from unregistered names; A shows its reason)');
  // Battle timer: A turns it on while waiting; the countdown must show up on A's screen.
  await wait(() => a.app.view.buttons.some(x => x.id === 'timer'), 30000, both);
  a.app.select('timer');
  await wait(() => a.app.view.top && a.app.view.top.timer >= 0, 20000, both);
  console.log(`ok   battle timer on, A sees ${a.app.view.top.timer}s left`);
  // A dropped connection mid-battle: A must reconnect by itself and rejoin the same battle.
  const room = a.app.room;
  a.ws.close();
  await wait(() => a.app.reconnect, 5000, both);
  await wait(() => !a.app.reconnect && a.app.room === room && a.app.screen === 'battle' && a.app.net?.named, 30000, both);
  console.log('ok   reconnected after a dropped connection and rejoined', room);
  await wait(() => both.every(c => c.done), 120000, both);
  console.log(`ok   OU battle finished: winner ${a.done.winner} after ${a.done.turns} turns (B saw ${b.done.winner})`);
  if (a.done.winner !== b.done.winner) throw new Error('clients disagree on the winner');
  await wait(() => w.app.tracker.ended, 60000, both); // the spectator's animations lag behind the players
  if (w.app.tracker.winner !== a.done.winner) throw new Error(`the spectator saw ${w.app.tracker.winner} win`);
  console.log('ok   the spectator saw the same winner');
  // L scrolls the log back, R forward to live.
  const n = w.app.tracker.log.length;
  w.app.select('log-older'); w.app.select('log-older');
  if (w.app.logAt !== n - 9 || w.app.view.log[6] !== w.app.tracker.log[n - 9] || !/8 lines back/.test(w.app.view.title)) throw new Error(`log scroll: at=${w.app.logAt} title=${w.app.view.title}`);
  for (let i = 0; i < 3; i++) w.app.select('log-newer');
  if (w.app.logAt !== null || w.app.view.log.length !== 7) throw new Error('log scroll back to live failed');
  console.log(`ok   log scrolls back ${n} lines and returns to live`);
  w.app.select('continue'); clearInterval(pumpW);

  for (const c of both) { c.done = null; }
  await wait(() => both.every(c => c.app.screen === 'lobby'), 15000, both);
  for (const c of both) { c.app.select('search'); c.app.select('gen9randombattle'); }
  await wait(() => both.every(c => c.app.screen === 'battle'), 30000, both);
  console.log('ok   random battle matched via ladder search');
  await wait(() => both.every(c => c.done), 120000, both);
  console.log(`ok   random battle finished: winner ${a.done.winner}`);

  const errors = [...both, w].flatMap(c => c.errors.map(e => `${c.name}: ${e}`));
  for (const c of both) c.ws.close();
  cleanup();
  if (errors.length) { console.log('FAIL\n' + errors.join('\n')); process.exit(1); }
  console.log('all passed');
  process.exit(0);
})().catch(e => { console.log('FAIL', e.message); cleanup(); process.exit(1); });
