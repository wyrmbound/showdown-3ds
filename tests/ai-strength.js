// node tests/ai-strength.js [games] : COM difficulty check. Two COMs play each other in
// [Gen 9] Random Battle (same teams both ways round) and the win rates are reported.
'use strict';
const cleanup = require('./boot-node')();
const sim = globalThis.require('/sim/index.js'); // the app's loader, set up by boot-node
const games = +process.argv[2] || 40;

function play(teamA, teamB, diffA, diffB) {
  const reqs = {};
  const battle = new sim.Battle({formatid: 'gen9randombattle', send: (t, d) => {
    if (t !== 'sideupdate') return;
    const [side, msg] = [d.slice(0, 2), d.slice(3)];
    if (msg.startsWith('|request|')) reqs[side] = JSON.parse(msg.slice(9));
  }});
  battle.setPlayer('p1', {name: 'A', team: teamA});
  battle.setPlayer('p2', {name: 'B', team: teamB});
  battle.sendUpdates();
  for (let guard = 0; !battle.ended && guard < 1000; guard++) {
    for (const [side, diff] of [['p1', diffA], ['p2', diffB]]) {
      const r = reqs[side];
      if (!r || r.wait) continue;
      delete reqs[side];
      if (!battle.choose(side, chooseCOM(battle, side, r, diff))) battle.choose(side, 'default');
    }
    battle.sendUpdates();
  }
  return battle.winner;
}

for (const [a, b] of [['hard', 'normal'], ['normal', 'easy'], ['hard', 'easy']]) {
  let winsA = 0, done = 0;
  for (let g = 0; g < games; g++) {
    const t1 = sim.Teams.generate('gen9randombattle'), t2 = sim.Teams.generate('gen9randombattle');
    // Same teams both ways round, so team luck cancels out.
    if (play(t1, t2, a, b) === 'A') winsA++;
    if (play(t2, t1, a, b) === 'A') winsA++;
    done += 2;
  }
  console.log(`${a.padEnd(6)} vs ${b.padEnd(6)}: ${a} wins ${winsA}/${done} (${Math.round(100 * winsA / done)}%)`);
}
cleanup();
