// Builds the rental teams offered for OU, Ubers, UU, RU, NU and PU: Showdown's Battle Factory sets
// for each tier, minus anything the format bans, kept only if Showdown's validator accepts the
// team. Stored packed, ready for /utm, so the console never needs the battle engine.
// Usage: node tools/make-rentals.js <pokemon-showdown dir> <out file> [teams per format]
'use strict';
const fs = require('fs');
const path = require('path');
const [src, out] = process.argv.slice(2, 4).map(p => path.resolve(p));
const perFormat = +process.argv[4] || 40;
const {Dex, Teams, TeamValidator} = require(path.join(src, 'dist/sim'));
const toID = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const TIERS = {gen9ou: 'OU', gen9ubers: 'Uber', gen9uu: 'UU', gen9ru: 'RU', gen9nu: 'NU', gen9pu: 'PU'};
const rentals = {};
for (const [format, tier] of Object.entries(TIERS)) {
  const rules = Dex.formats.getRuleTable(Dex.formats.get(format));
  const banned = (kind, name) => name && rules.isBanned(`${kind}:${toID(name)}`);
  const validator = TeamValidator.get(format);
  const teams = new Set();
  for (let tries = 0; teams.size < perFormat && tries < perFormat * 20; tries++) {
    const gen = Teams.getGenerator('gen9battlefactory');
    gen.factoryTier = tier;
    const team = gen.randomFactoryTeam();
    for (const set of team) {
      set.moves = set.moves.filter(m => !banned('move', m));
      if (banned('item', set.item)) set.item = '';
    }
    if (!validator.validateTeam(team)) teams.add(Teams.pack(team));
  }
  if (teams.size < perFormat / 2) throw new Error(`only ${teams.size} valid rental teams for ${format}`);
  rentals[format] = [...teams];
}
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify(rentals));
console.log(`rentals: ${Object.entries(rentals).map(([f, t]) => `${f} ${t.length}`).join(', ')}, ${fs.statSync(out).size} bytes`);
