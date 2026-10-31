// Turns Showdown battle protocol lines into battle state plus one readable message per event.
// Same code for online battles (server lines) and COM battles (local sim lines).
'use strict';

const toID = s => ('' + s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const STAT = {atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed', accuracy: 'accuracy', evasion: 'evasiveness'};
const STATUS_ON = {
  brn: 'was burned!', par: 'is paralyzed! It may be unable to move!', slp: 'fell asleep!',
  frz: 'was frozen solid!', psn: 'was poisoned!', tox: 'was badly poisoned!',
};
const WEATHER = {
  RainDance: 'It started to rain!', SunnyDay: 'The sunlight turned harsh!', Sandstorm: 'A sandstorm kicked up!',
  Snowscape: 'It started to snow!', Snow: 'It started to snow!', DesolateLand: 'The sunlight turned extremely harsh!',
  PrimordialSea: 'A heavy rain began to fall!', DeltaStream: 'Mysterious strong winds are protecting Flying-type Pokemon!',
};
const effectName = s => (s || '').replace(/^(move|ability|item):\s*/, '');
// Protocol line -> battle animation. 'update' plays instantly; it just refreshes what's shown.
const ANIM_KIND = {
  switch: 'switch', drag: 'switch', move: 'move', faint: 'faint', '-damage': 'hit', '-heal': 'heal',
  '-boost': 'boost', '-unboost': 'drop', '-status': 'status',
  '-sethp': 'update', '-curestatus': 'update', '-terastallize': 'update', replace: 'update',
  detailschange: 'update', '-transform': 'update', '-clearboost': 'update', '-setboost': 'update',
  '-clearnegativeboost': 'update',
};

function parseHP(text) {
  // "123/300 par", "45/100", "0 fnt"
  const [hp, status] = (text || '').split(' ');
  if (hp === '0' || status === 'fnt') return {hp: 0, maxhp: 0, status: '', fainted: true};
  const [cur, max] = hp.split('/').map(Number);
  return {hp: cur, maxhp: max || 100, status: status || '', fainted: false};
}

function parseDetails(details) {
  const parts = details.split(', ');
  const mon = {species: parts[0], level: 100, shiny: false, gender: ''};
  for (const p of parts.slice(1)) {
    if (/^L\d+$/.test(p)) mon.level = +p.slice(1);
    else if (p === 'shiny') mon.shiny = true;
    else if (p === 'M' || p === 'F') mon.gender = p;
  }
  return mon;
}

class Tracker {
  constructor(spriteIds) {
    this.spriteIds = spriteIds || {};
    this.reset(null);
  }

  reset(mySide) {
    this.mySide = mySide;
    this.sides = {p1: this.newSide(), p2: this.newSide()};
    this.queue = [];
    this.log = [];
    this.msg = '';
    this.turn = 0;
    this.ended = false;
    this.winner = null;
    this.request = null;
    this.split = null;
    this.weather = '';
    this.choiceError = false;
    this.anims = [];
  }

  newSide() { return {name: '', mons: {}, active: null, preview: [], conditions: [], teamSize: 6}; }

  // Lines arrive in chunks; they are applied one message at a time by step() so the
  // screen can show each event with the state it produced.
  feed(text) {
    for (const line of text.split('\n')) {
      if (line.startsWith('|request|')) {
        const json = line.slice(9);
        if (json) this.setRequest(JSON.parse(json));
      } else if (line) {
        this.queue.push(line);
      }
    }
  }

  setRequest(req) {
    this.request = req;
    if (req.side && !this.mySide) this.mySide = req.side.id;
  }

  get busy() { return this.queue.length > 0; }

  // Applies queued lines until one produces a message. Returns false when nothing is left.
  step() {
    while (this.queue.length) {
      const line = this.queue.shift();
      this.skipped = false;
      const msg = this.apply(line);
      if (!this.skipped) this.animate(line);
      if (msg) {
        this.msg = msg;
        this.log.push(msg);
        if (this.log.length > 200) this.log.shift();
        return true;
      }
    }
    return false;
  }

  // Applies everything queued (used when the player skips ahead).
  flush() { while (this.step()); }

  // Records what the screen should animate for a line just applied, with a snapshot of that
  // side's Pokemon right after it, so the animation player can show HP etc. in step with it.
  animate(line) {
    const parts = line.slice(1).split('|');
    const cmd = parts[0], ident = parts[1] || '';
    const side = ident.slice(0, 2);
    if (!this.sides[side] || ident[2] === ':' || !ident.includes(':')) return; // only Pokemon (p1a: X)
    const kind = ANIM_KIND[cmd];
    if (!kind) return;
    const ev = {kind, side, snap: this.activeView(side)};
    if (kind === 'move') {
      if (parts.some(p => p.startsWith('[still]') || p.startsWith('[notarget]'))) return;
      const info = this.moveInfo ? this.moveInfo(toID(parts[2] || '')) : null;
      ev.type = info?.type || '???';
      ev.status = !!info?.status;
    }
    this.anims.push(ev);
  }

  sideOf(ident) { return ident.slice(0, 2); }
  isMine(ident) { return this.sideOf(ident) === this.mySide; }

  mon(ident, details) {
    const side = this.sides[this.sideOf(ident)];
    if (!side) return null;
    const name = ident.slice(ident.indexOf(':') + 1).trim();
    let mon = side.mons[name];
    if (!mon) {
      mon = side.mons[name] = {name, species: name, level: 100, shiny: false, hp: 100, maxhp: 100,
        status: '', fainted: false, boosts: {}, tera: '', volatiles: []};
    }
    if (details) Object.assign(mon, parseDetails(details));
    return mon;
  }

  who(ident, lower) {
    const name = ident.slice(ident.indexOf(':') + 1).trim();
    if (this.isMine(ident)) return name;
    return (lower ? 'the opposing ' : 'The opposing ') + name;
  }

  sideName(sideText, lower) {
    // "p1: Name" or "p1"
    const id = sideText.slice(0, 2);
    if (id === this.mySide) return lower ? 'your team' : 'Your team';
    return lower ? 'the opposing team' : 'The opposing team';
  }

  setHP(mon, text) {
    const before = mon.maxhp ? mon.hp / mon.maxhp : 0;
    const hp = parseHP(text);
    mon.hp = hp.hp;
    if (hp.maxhp) mon.maxhp = hp.maxhp;
    mon.fainted = hp.fainted;
    if (!hp.fainted) mon.status = hp.status;
    return Math.round(Math.abs(before - (mon.maxhp ? mon.hp / mon.maxhp : 0)) * 100);
  }

  apply(line) {
    if (!line.startsWith('|')) return '';
    const all = line.slice(1).split('|');
    const kw = {};
    while (all.length > 1 && /^\[\w+\]/.test(all[all.length - 1])) {
      const m = all.pop().match(/^\[(\w+)\]\s*(.*)$/);
      kw[m[1]] = m[2];
    }
    const [cmd, a = '', b = '', c = ''] = all;

    // |split|p1 is followed by a secret line (exact HP) and a public one (percent).
    if (cmd === 'split') { this.split = {side: a, n: 0}; return ''; }
    if (this.split) {
      const keepSecret = this.split.side === this.mySide;
      const isSecret = this.split.n++ === 0;
      if (this.split.n >= 2) this.split = null;
      if (isSecret !== keepSecret) { this.skipped = true; return ''; }
    }

    switch (cmd) {
    case 'player': if (b) this.sides[a].name = b; return '';
    case 'poke': this.sides[a].preview.push(parseDetails(b).species); return '';
    case 'teamsize': this.sides[a].teamSize = +b; return '';
    case 'teampreview': return 'Choose your lead.';
    case 'start': return 'The battle started!';
    case 'turn': this.turn = +a; return `Turn ${a}`;
    case 'win': this.ended = true; this.winner = a; return `${a} won the battle!`;
    case 'tie': this.ended = true; this.winner = ''; return 'The battle ended in a tie.';
    case 'switch': case 'drag': {
      const side = this.sides[this.sideOf(a)];
      if (side.active) { side.active.boosts = {}; side.active.volatiles = []; }
      const mon = this.mon(a, b);
      this.setHP(mon, c);
      side.active = mon;
      if (cmd === 'drag') return `${this.who(a)} was dragged out!`;
      return this.isMine(a) ? `Go! ${mon.name}!` : `${side.name || 'The opponent'} sent out ${mon.name}!`;
    }
    case 'replace': case 'detailschange': this.mon(a, b); return '';
    case 'move': return `${this.who(a)} used ${b}!`;
    case 'cant': {
      const why = effectName(b);
      if (why === 'slp') return `${this.who(a)} is fast asleep.`;
      if (why === 'par') return `${this.who(a)} is paralyzed! It can't move!`;
      if (why === 'frz') return `${this.who(a)} is frozen solid!`;
      if (why === 'flinch') return `${this.who(a)} flinched and couldn't move!`;
      if (why === 'recharge') return `${this.who(a)} must recharge!`;
      return `${this.who(a)} can't use ${c || 'its move'}! (${why})`;
    }
    case 'faint': { const m = this.mon(a); m.hp = 0; m.fainted = true; m.status = ''; return `${this.who(a)} fainted!`; }
    case '-damage': {
      const m = this.mon(a);
      const pct = this.setHP(m, b);
      if (kw.from) {
        const from = effectName(kw.from);
        if (from === 'psn' || from === 'tox') return `${this.who(a)} was hurt by poison!`;
        if (from === 'brn') return `${this.who(a)} was hurt by its burn!`;
        if (from === 'Recoil') return `${this.who(a)} is damaged by the recoil!`;
        if (from === 'confusion') return `${this.who(a)} hurt itself in its confusion!`;
        return `${this.who(a)} was hurt by ${from}!`;
      }
      return pct ? `${this.who(a)} lost ${pct}% of its health!` : '';
    }
    case '-heal': {
      const m = this.mon(a);
      this.setHP(m, b);
      if (kw.from) return `${this.who(a)} restored HP using ${effectName(kw.from)}!`;
      return `${this.who(a)} had its HP restored.`;
    }
    case '-sethp': this.setHP(this.mon(a), b); return '';
    case '-status': {
      const m = this.mon(a);
      m.status = b;
      return `${this.who(a)} ${STATUS_ON[b] || 'got a status condition!'}`;
    }
    case '-curestatus':
      this.mon(a).status = '';
      if (kw.msg === undefined) return '';
      if (b === 'slp') return `${this.who(a)} woke up!`;
      if (b === 'frz') return `${this.who(a)} thawed out!`;
      return `${this.who(a)} was cured of its ${b}.`;
    case '-cureteam': for (const m of Object.values(this.sides[this.sideOf(a)].mons)) m.status = ''; return 'The team was cured of its status conditions!';
    case '-boost': case '-unboost': {
      const m = this.mon(a);
      const n = +c * (cmd === '-boost' ? 1 : -1);
      m.boosts[b] = Math.max(-6, Math.min(6, (m.boosts[b] || 0) + n));
      if (!+c) return `${this.who(a)}'s ${STAT[b] || b} won't go any ${cmd === '-boost' ? 'higher' : 'lower'}!`;
      const how = Math.abs(n) >= 3 ? ' drastically' : Math.abs(n) === 2 ? ' sharply' : '';
      return `${this.who(a)}'s ${STAT[b] || b}${cmd === '-boost' ? ' rose' : ' fell'}${how}!`;
    }
    case '-setboost': this.mon(a).boosts[b] = +c; return '';
    case '-clearboost': case '-clearallboost': case '-clearnegativeboost':
      if (cmd === '-clearallboost') { for (const s of Object.values(this.sides)) if (s.active) s.active.boosts = {}; return 'All stat changes were eliminated!'; }
      this.mon(a).boosts = {}; return `${this.who(a)}'s stat changes were removed!`;
    case '-weather':
      if (kw.upkeep !== undefined) return '';
      this.weather = a === 'none' ? '' : a;
      return a === 'none' ? 'The weather cleared up.' : (WEATHER[a] || `${a} began.`);
    case '-fieldstart': return `${effectName(a)} started!`;
    case '-fieldend': return `${effectName(a)} ended.`;
    case '-sidestart': {
      const side = this.sides[a.slice(0, 2)];
      side.conditions.push(effectName(b));
      return `${effectName(b)} affects ${this.sideName(a, true)}!`;
    }
    case '-sideend': {
      const side = this.sides[a.slice(0, 2)];
      side.conditions = side.conditions.filter(x => x !== effectName(b));
      return `${effectName(b)} wore off for ${this.sideName(a, true)}.`;
    }
    case '-crit': return 'A critical hit!';
    case '-supereffective': return "It's super effective!";
    case '-resisted': return "It's not very effective...";
    case '-immune': return `It doesn't affect ${this.who(a, true)}...`;
    case '-miss': return b ? `${this.who(b)} avoided the attack!` : `${this.who(a)}'s attack missed!`;
    case '-fail': return 'But it failed!';
    case '-notarget': return 'But there was no target...';
    case '-hitcount': return `Hit ${b} time${b === '1' ? '' : 's'}!`;
    case '-ohko': return "It's a one-hit KO!";
    case '-item':
      if (b === 'Air Balloon' && !kw.from) return `${this.who(a)} floats in the air with its Air Balloon!`;
      return kw.from ? `${this.who(a)} has ${b} (${effectName(kw.from)}).` : `${this.who(a)} obtained ${b}.`;
    case '-enditem':
      if (kw.eat !== undefined) return `${this.who(a)} ate its ${b}!`;
      return kw.from ? `${this.who(a)} lost its ${b}!` : `${this.who(a)}'s ${b} was used up.`;
    case '-ability': return `[${this.who(a)}'s ${b}]`;
    case '-transform': return `${this.who(a)} transformed into ${b.slice(b.indexOf(':') + 1).trim()}!`;
    case '-terastallize': this.mon(a).tera = b; return `${this.who(a)} has Terastallized into the ${b} type!`;
    case '-mega': return `${this.who(a)} has Mega Evolved!`;
    case '-start': {
      const m = this.mon(a);
      const eff = effectName(b);
      if (eff === 'typechange') return `${this.who(a)} became the ${c} type!`;
      if (!m.volatiles.includes(eff)) m.volatiles.push(eff);
      if (eff === 'confusion') return `${this.who(a)} became confused!`;
      if (eff === 'Substitute') return `${this.who(a)} put in a substitute!`;
      const boosted = eff.match(/^(quarkdrive|protosynthesis)(\w+)$/);
      if (boosted) return `${this.who(a)}'s ${STAT[boosted[2]] || boosted[2]} was heightened!`;
      return kw.silent !== undefined ? '' : `${this.who(a)}: ${eff}!`;
    }
    case '-end': {
      const m = this.mon(a);
      const eff = effectName(b);
      m.volatiles = m.volatiles.filter(v => v !== eff);
      if (eff === 'Substitute') return `${this.who(a)}'s substitute faded!`;
      if (eff === 'confusion') return `${this.who(a)} snapped out of its confusion!`;
      return kw.silent !== undefined ? '' : `${this.who(a)}'s ${eff} ended.`;
    }
    case '-singleturn': case '-activate': {
      const eff = effectName(b);
      if (eff === 'Protect' || eff === 'Detect' || eff === "King's Shield" || eff === 'Spiky Shield' ||
        eff === 'Baneful Bunker' || eff === 'Silk Trap' || eff === 'Burning Bulwark') {
        return `${this.who(a)} protected itself!`;
      }
      if (eff === 'Substitute') return `The substitute took damage for ${this.who(a, true)}!`;
      return '';
    }
    case '-prepare': return `${this.who(a)} is preparing ${b}!`;
    case '-mustrecharge': return '';
    case 'message': case '-message': return a;
    case 'inactive': case 'inactiveoff': {
      // Battle timer: "Time left: 150 sec this turn | 300 sec total" while it runs.
      const left = cmd === 'inactive' && /Time left: (\d+) sec/.exec(a);
      if (left) { this.timerLeft = +left[1]; this.timerSeq = (this.timerSeq || 0) + 1; }
      if (/timer is (now )?OFF|turned off/i.test(a) || cmd === 'inactiveoff') this.timerLeft = null;
      if (/timer is (now )?ON|turned on/i.test(a)) this.timerOn = true;
      return a;
    }
    case 'error':
      if (/^\[(Invalid|Unavailable) choice\]/.test(a)) this.choiceError = true;
      return a.replace(/^\[[^\]]*\]\s*/, '');
    // Names carry a rank symbol in front (☆ for players in this battle, + @ % ... for staff).
    // \x01 marks chat so the screen can colour it apart from battle events.
    case 'c': case 'chat': return `\x01${a.trim().replace(/^[^A-Za-z0-9]/, '')}: ${b}`;
    case 'c:': return `\x01${b.trim().replace(/^[^A-Za-z0-9]/, '')}: ${c}`;
    case 'raw': case 'html': { const t = a.replace(/<[^>]*>/g, '').trim(); return t.length < 120 ? t : ''; }
    default: return '';
    }
  }

  // Display info for one side's active Pokemon.
  activeView(sideId) {
    const side = this.sides[sideId];
    const m = side.active;
    if (!m) return null;
    const mine = sideId === this.mySide;
    const pct = m.maxhp ? Math.max(0, Math.round(100 * m.hp / m.maxhp)) : 0;
    // One entry per changed stat ("+2 Attack"), shown as a vertical list next to the HP box.
    const boosts = Object.entries(m.boosts).filter(([, v]) => v)
      .map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${STAT[k] || k}`);
    return {
      name: m.name, species: m.species, level: m.level, status: m.fainted ? 'FNT' : m.status.toUpperCase(),
      hp: m.hp, maxhp: m.maxhp, pct, hpText: mine ? `${m.hp}/${m.maxhp}` : `${pct}%`,
      sprite: this.spritePath(m, mine), tera: m.tera, boosts,
    };
  }

  // Showdown's current sprites ("ani"); the C side falls back to its gen5 animation, then to the
  // still gen5 sprite, when one is missing. small = half-size sheet for party and team preview.
  spritePath(m, back, small) {
    const id = this.spriteIds[m.species] || toID(m.species);
    return `${small ? 's:' : ''}${this.spriteStyle || 'ani'}${back ? '-back' : ''}${m.shiny ? '-shiny' : ''}/${id}`;
  }
}

Tracker.toID = toID;
Tracker.parseHP = parseHP;
Tracker.parseDetails = parseDetails;
if (typeof module !== 'undefined') module.exports = Tracker; else globalThis.Tracker = Tracker;
