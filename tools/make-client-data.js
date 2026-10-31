// Writes the small lookup tables the online client needs without loading the sim:
// sprite ids (where not just toID(name)), move types and status moves, species types, the type
// chart, and display names for items and abilities.
// Usage: node tools/make-client-data.js <pokemon-showdown dir> <out file>
'use strict';
const fs = require('fs');
const path = require('path');
const [src, out] = process.argv.slice(2).map(p => path.resolve(p));
const {Dex} = require(path.join(src, 'dist/sim'));
const toID = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

const species = {}, types = {};
for (const s of Dex.species.all()) {
  if (s.spriteid !== toID(s.name)) species[s.name] = s.spriteid;
  types[s.name] = s.types;
}
const moves = {}, moveNames = {};
for (const m of Dex.moves.all()) { moves[m.id] = m.type; moveNames[m.id] = m.name; }
// Status moves animate as a glow on the user rather than a hit on the target.
const status = Dex.moves.all().filter(m => m.category === 'Status').map(m => m.id);
// chart[defending type][attacking type]: 0 normal, 1 super effective, 2 resisted, 3 no effect.
const chart = {};
for (const t of Dex.types.all()) {
  chart[t.name] = {};
  for (const [atk, v] of Object.entries(t.damageTaken)) if (v && /^[A-Z]/.test(atk)) chart[t.name][atk] = v;
}
const items = {}, abilities = {};
for (const i of Dex.items.all()) items[i.id] = i.name;
for (const a of Dex.abilities.all()) abilities[a.id] = a.name;

fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify({species, moves, moveNames, status, types, chart, items, abilities}));
console.log(`client data: ${Object.keys(types).length} species, ${Object.keys(moves).length} moves, ${fs.statSync(out).size} bytes`);
