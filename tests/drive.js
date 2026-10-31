// Plays the app like a (random) player would: taps buttons from app.view until the
// battle ends. Shared by the node and QuickJS test runners.
'use strict';
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

function playCOM(app, formatId, opts = {}) {
  const errors = [];
  let now = 0, ticks = 0, choices = 0;
  const tick = () => { now += 1200; app.tick(now); ticks++; for (const c of app.takeCommands()) errors.push('unexpected command ' + c[0]); };
  tick();
  app.select('com');
  app.select(formatId);
  if (app.screen === 'team') app.select(opts.team || 'rental');
  while (ticks < 20000) {
    tick();
    const v = app.view;
    if (/^Error/.test(v.text) || /^Error/.test(app.notice)) { errors.push(app.notice); break; }
    if (v.screen === 'menu') break;
    if (v.screen !== 'battle') continue;
    for (const line of v.log) if (/undefined|NaN|\[object/.test(line)) errors.push('bad log line: ' + line);
    const ok = v.buttons.filter(b => b.enabled);
    if (!ok.length) continue;
    const ids = ok.map(b => b.id);
    if (ids.includes('continue')) { app.select('continue'); continue; }
    if (ids.includes('skip')) { app.select('skip'); continue; }
    if (v.layout === 'moves') {
      choices++;
      const moves = ids.filter(i => i.startsWith('move'));
      if (ids.includes('tera') && Math.random() < 0.2) app.select('tera');
      app.select(Math.random() < 0.1 && ids.includes('switch') ? 'switch' : pick(moves));
    } else if (v.layout === 'party') {
      choices++;
      const mons = ids.filter(i => i.startsWith('mon'));
      app.select(mons.length ? pick(mons) : 'back');
    }
  }
  const t = app.tracker;
  return {errors, ticks, choices, turns: t.turn, winner: t.winner, ended: t.ended, lastLog: t.log.slice(-3)};
}
globalThis.playCOM = playCOM;
