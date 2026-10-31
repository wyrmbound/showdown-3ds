// node tests/com-node.js : plays COM battles in every format through the real app code.
'use strict';
const cleanup = require('./boot-node')();
let failed = 0;
const games = +process.argv[2] || 3;
for (const [fmt, team] of [['gen9randombattle'], ['gen9ou', 'rental'], ['gen9ou', 'team-0'], ['gen9ubers', 'rental']]) {
  for (let g = 0; g < games; g++) {
    const app = new App();
    const r = playCOM(app, fmt, {team});
    const ok = r.ended && !r.errors.length;
    if (!ok) failed++;
    if (process.env.DUMP === fmt && g === 0) console.log(app.tracker.log.join('\n'));
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${fmt} ${team || ''} turns=${r.turns} choices=${r.choices} winner=${r.winner}` + (ok ? '' : `\n  ${r.errors.slice(0, 5).join('\n  ')}\n  last: ${r.lastLog.join(' / ')}`));
  }
}
cleanup();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
