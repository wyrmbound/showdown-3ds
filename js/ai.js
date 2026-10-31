// COM opponent: picks the move that looks best this turn (damage estimate plus a few
// rules for status, setup and recovery), and switches out of hopeless matchups.
// It reads the live sim Battle, so like in-game trainers it knows the player's active Pokemon.
'use strict';

const ABSORB = {
  levitate: 'Ground', eartheater: 'Ground', flashfire: 'Fire', wellbakedbody: 'Fire', waterabsorb: 'Water',
  stormdrain: 'Water', dryskin: 'Water', voltabsorb: 'Electric', lightningrod: 'Electric', motordrive: 'Electric',
  sapsipper: 'Grass',
};
const HAZARDS = ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'];
const boostMul = n => n >= 0 ? (2 + n) / 2 : 2 / (2 - n);

function typeMul(battle, type, target) {
  if (ABSORB[target.ability] === type && !target.volatiles?.gastroacid) return 0;
  if (!battle.dex.getImmunity(type, target)) return 0;
  return 2 ** battle.dex.getEffectiveness(type, target);
}

function damageScore(battle, user, target, move) {
  if (move.category === 'Status') return 0;
  let bp = move.basePower || 60;
  if (move.multihit) bp *= Array.isArray(move.multihit) ? 3 : move.multihit;
  const physical = move.category === 'Physical';
  const atk = user.storedStats[physical ? 'atk' : 'spa'] * boostMul(user.boosts[physical ? 'atk' : 'spa']);
  const def = target.storedStats[physical ? 'def' : 'spd'] * boostMul(target.boosts[physical ? 'def' : 'spd']);
  const stab = user.hasType(move.type) ? 1.5 : 1;
  const acc = move.accuracy === true ? 1 : move.accuracy / 100;
  return bp * stab * typeMul(battle, move.type, target) * (atk / def) * acc;
}

function statusScore(battle, user, target, move, side) {
  const hpFrac = user.hp / user.maxhp;
  if ((move.heal || move.flags?.heal || ['rest', 'roost', 'recover', 'slackoff', 'softboiled', 'moonlight',
    'morningsun', 'synthesis', 'shoreup', 'milkdrink', 'strengthsap'].includes(move.id)) && hpFrac < 0.5) return 110;
  if (move.target === 'self' && move.boosts) {
    const total = Object.values(user.boosts).reduce((a, b) => a + b, 0);
    return hpFrac > 0.7 && total < 2 ? 85 : 5;
  }
  if (HAZARDS.includes(move.id)) return side.foe.sideConditions[move.id] ? 0 : 70;
  if (move.status) {
    if (target.status || typeMul(battle, move.type, target) === 0) return 0;
    if (move.status === 'brn' && target.hasType('Fire')) return 0;
    if ((move.status === 'psn' || move.status === 'tox') && (target.hasType('Poison') || target.hasType('Steel'))) return 0;
    if (move.status === 'par' && target.hasType('Electric')) return 0;
    return 60;
  }
  if (['protect', 'detect', 'spikyshield', 'kingsshield', 'banefulbunker', 'silktrap'].includes(move.id)) return 15;
  return 20;
}

// How good is this Pokemon against the foe's active: our best hit minus their best hit on us.
function matchup(battle, mon, foe) {
  let best = 0;
  for (const slot of mon.moveSlots) best = Math.max(best, damageScore(battle, mon, foe, battle.dex.moves.get(slot.id)));
  let worst = 0;
  for (const type of foe.getTypes()) worst = Math.max(worst, typeMul(battle, type, mon));
  return best - 40 * worst;
}

function bestSwitch(battle, side, req) {
  const foe = side.foe.active[0];
  let pick = 0, pickScore = -Infinity;
  req.side.pokemon.forEach((p, i) => {
    if (p.active || p.condition.endsWith(' fnt') || p.condition === '0 fnt') return;
    const mon = side.pokemon[i];
    const score = foe ? matchup(battle, mon, foe) : mon.hp;
    if (score > pickScore) { pickScore = score; pick = i + 1; }
  });
  return pick;
}

// ---- Hard: real damage numbers, speed order and KO checks ----

// Expected damage (HP) of `move` from user to target, using the game's damage formula with an
// average roll. Covers the big modifiers; rarer abilities and items are left out.
function estimateDamage(battle, user, target, move, tera) {
  if (move.category === 'Status' || !move.basePower) return 0;
  const physical = move.category === 'Physical';
  const atkStat = physical ? 'atk' : 'spa', defStat = physical ? 'def' : 'spd';
  const atk = user.storedStats[atkStat] * boostMul(user.boosts[atkStat]);
  const def = target.storedStats[defStat] * boostMul(target.boosts[defStat]);
  let dmg = Math.floor(Math.floor(Math.floor(2 * user.level / 5 + 2) * move.basePower * atk / def) / 50) + 2;
  const types = tera ? [tera] : user.getTypes();
  if (types.includes(move.type) || user.hasType(move.type)) dmg *= user.ability === 'adaptability' ? 2 : 1.5;
  dmg *= typeMul(battle, move.type, target);
  if (physical && user.status === 'brn' && user.ability !== 'guts') dmg *= 0.5;
  if ((physical && user.item === 'choiceband') || (!physical && user.item === 'choicespecs')) dmg *= 1.5;
  if (user.item === 'lifeorb') dmg *= 1.3;
  if (move.multihit) dmg *= Array.isArray(move.multihit) ? 3 : move.multihit;
  return dmg * 0.925 * (move.accuracy === true ? 1 : move.accuracy / 100);
}

function speed(mon) {
  let s = mon.storedStats.spe * boostMul(mon.boosts.spe);
  if (mon.status === 'par') s *= 0.5;
  if (mon.item === 'choicescarf') s *= 1.5;
  return s;
}

// The foe's most damaging known move against `mon` (the COM sees the battle, like game AIs).
function foeBest(battle, foe, mon) {
  let best = 0;
  for (const slot of foe.moveSlots) best = Math.max(best, estimateDamage(battle, foe, mon, battle.dex.moves.get(slot.id)));
  return best;
}

function hardChoice(battle, side, req) {
  const me = side.active[0], foe = side.foe.active[0], act = req.active[0];
  const usable = act.moves.map((m, i) => ({m, i, move: battle.dex.moves.get(m.id)})).filter(x => !x.m.disabled && x.m.pp !== 0);
  if (!usable.length) return 'move 1';
  const faster = speed(me) > speed(foe);
  const threat = foeBest(battle, foe, me); // what the foe can do to us this turn
  const canSwitch = !act.trapped && !act.maybeTrapped;
  const dmg = x => estimateDamage(battle, me, foe, x.move);
  const kills = usable.filter(x => dmg(x) >= foe.hp);
  // 1. Take a KO: before the foe moves if possible (speed or priority).
  const firstKill = kills.find(x => faster || x.move.priority > 0);
  if (firstKill) return `move ${firstKill.i + 1}`;
  // 2. About to be knocked out by a faster foe: priority KO, else switch to something that takes it.
  if (!faster && threat >= me.hp) {
    if (kills.length && canSwitch) {
      const n = bestSwitch(battle, side, req);
      if (n && foeBest(battle, foe, side.pokemon[n - 1]) < side.pokemon[n - 1].hp * 0.5) return `switch ${n}`;
    }
    if (act.canTerastallize) { // a defensive Tera that turns the hit into a resist
      const best = foe.moveSlots.map(s => battle.dex.moves.get(s.id)).sort((a, b) => estimateDamage(battle, foe, me, b) - estimateDamage(battle, foe, me, a))[0];
      if (best && battle.dex.getEffectiveness(best.type, act.canTerastallize) < 0) {
        const top = usable.sort((a, b) => dmg(b) - dmg(a))[0];
        return `move ${top.i + 1} terastallize`;
      }
    }
    if (canSwitch && !kills.length) {
      const n = bestSwitch(battle, side, req);
      if (n && foeBest(battle, foe, side.pokemon[n - 1]) < side.pokemon[n - 1].hp * 0.6) return `switch ${n}`;
    }
  }
  // 3. Safe turn: recover when low, set up when the foe can't hurt much, else hit hardest.
  const safe = threat < me.hp * 0.3;
  const recover = usable.find(x => x.move.flags?.heal && x.move.category === 'Status');
  if (recover && me.hp < me.maxhp * 0.45 && threat < me.maxhp * 0.5) return `move ${recover.i + 1}`;
  const setup = usable.find(x => x.move.target === 'self' && x.move.boosts && !x.move.flags?.heal);
  const boosted = Object.values(me.boosts).reduce((a, b) => a + b, 0);
  if (setup && safe && boosted < 2 && me.hp > me.maxhp * 0.6) return `move ${setup.i + 1}`;
  const status = usable.find(x => x.move.status && !foe.status && statusScore(battle, me, foe, x.move, side) > 0);
  if (status && safe && foe.hp > foe.maxhp * 0.5) return `move ${status.i + 1}`;
  const top = usable.slice().sort((a, b) => dmg(b) - dmg(a))[0];
  if (dmg(top) < foe.maxhp * 0.1 && canSwitch) { // walled: bring in something better
    const n = bestSwitch(battle, side, req);
    if (n && matchup(battle, side.pokemon[n - 1], foe) > matchup(battle, me, foe) + 20) return `switch ${n}`;
  }
  // Offensive Tera when it turns this hit into a KO.
  const tera = act.canTerastallize && top.move.category !== 'Status' &&
    estimateDamage(battle, me, foe, top.move, act.canTerastallize) >= foe.hp && dmg(top) < foe.hp;
  return `move ${top.i + 1}${tera ? ' terastallize' : ''}`;
}

// difficulty: 'easy' (mostly random, never switches by choice), 'normal' (best-looking move each
// turn), 'hard' (damage maths, speed order, KO checks; see hardChoice).
function chooseCOM(battle, sideId, req, difficulty = 'normal') {
  const side = battle.getSide(sideId);
  if (req.teamPreview) return 'default';
  if (req.forceSwitch) {
    // Revival Blessing: bring back the fainted teammate with the best matchup.
    if (req.side.pokemon.some(p => p.reviving)) {
      const foe = side.foe.active[0];
      let pick = 0, best = -Infinity;
      req.side.pokemon.forEach((p, i) => {
        if (!/ fnt$|^0 fnt$/.test(p.condition)) return;
        const score = foe ? matchup(battle, side.pokemon[i], foe) : 0;
        if (score > best) { best = score; pick = i + 1; }
      });
      return pick ? `switch ${pick}` : 'pass';
    }
    const n = bestSwitch(battle, side, req);
    return n ? `switch ${n}` : 'pass';
  }
  if (!req.active) return 'default';
  if (difficulty === 'hard') return hardChoice(battle, side, req);
  const easy = difficulty === 'easy';
  const me = side.active[0];
  const foe = side.foe.active[0];
  const act = req.active[0];
  let pick = -1, pickScore = -1;
  act.moves.forEach((m, i) => {
    if (m.disabled || m.pp === 0) return;
    const move = battle.dex.moves.get(m.id);
    let score = move.category === 'Status' ? statusScore(battle, me, foe, move, side) : damageScore(battle, me, foe, move);
    if (move.priority > 0 && foe.hp / foe.maxhp < 0.25) score *= 1.5;
    score = easy ? 10 + score * Math.random() * 0.5 : score * (0.85 + Math.random() * 0.3);
    if (score > pickScore) { pickScore = score; pick = i; }
  });
  if (pick < 0) return 'move 1';
  if (easy) return `move ${pick + 1}`;
  // Nothing useful to do here: switch to something that matches up better.
  if (pickScore < 25 && !act.trapped && !act.maybeTrapped) {
    const n = bestSwitch(battle, side, req);
    if (n && matchup(battle, side.pokemon[n - 1], foe) > matchup(battle, me, foe) + 20) return `switch ${n}`;
  }
  const move = battle.dex.moves.get(act.moves[pick].id);
  const tera = act.canTerastallize && act.canTerastallize === move.type && move.category !== 'Status' &&
    me.hp / me.maxhp > 0.4 && Math.random() < 0.6;
  return `move ${pick + 1}${tera ? ' terastallize' : ''}`;
}

if (typeof module !== 'undefined') module.exports = {chooseCOM}; else globalThis.chooseCOM = chooseCOM;
