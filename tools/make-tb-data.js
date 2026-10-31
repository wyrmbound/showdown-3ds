// Writes the teambuilder's data: every Pokemon available in Gen 9 with its types, abilities and
// the moves it can learn there (own learnset plus its pre-evolutions' and base forme's), and the
// Gen 9 items, natures and types. Move lists are indexes into one shared move list to stay small.
// Usage: node tools/make-tb-data.js <pokemon-showdown dir> <out file>
'use strict';
const fs = require('fs');
const path = require('path');
const [src, out] = process.argv.slice(2).map(p => path.resolve(p));
const {Dex} = require(path.join(src, 'dist/sim'));
const dex = Dex.mod('gen9');
const toID = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

const moves = dex.moves.all().filter(m => !m.isNonstandard && !m.isZ && !m.isMax).map(m => m.name).sort();
const moveIndex = new Map(moves.map((m, i) => [toID(m), i]));

// Moves learnable in Gen 9 (sources starting with "9"), following pre-evolutions and base formes.
function learnable(species) {
  const found = new Set();
  const seen = new Set();
  const queue = [species];
  while (queue.length) {
    const s = queue.shift();
    if (!s?.exists || seen.has(s.id)) continue;
    seen.add(s.id);
    const ls = dex.species.getLearnsetData(s.id)?.learnset;
    for (const [move, sources] of Object.entries(ls || {})) {
      if (sources.some(x => x.startsWith('9')) && moveIndex.has(move)) found.add(moveIndex.get(move));
    }
    if (s.prevo) queue.push(dex.species.get(s.prevo));
    if (s.changesFrom) queue.push(dex.species.get(s.changesFrom));
    if (s.baseSpecies !== s.name && !ls) queue.push(dex.species.get(s.baseSpecies));
  }
  return [...found].sort((a, b) => a - b);
}

const species = {};
for (const s of dex.species.all()) {
  if (s.isNonstandard || s.battleOnly || s.forme === 'Gmax' || s.name.endsWith('-Totem')) continue;
  const ms = learnable(s);
  if (!ms.length) continue;
  species[s.name] = {t: s.types, a: Object.values(s.abilities), m: ms};
}
const items = dex.items.all().filter(i => !i.isNonstandard).map(i => i.name).sort();
const natures = dex.natures.all().map(n => [n.name, n.plus || '', n.minus || '']);
const types = dex.types.all().filter(t => !t.isNonstandard).map(t => t.name);

fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify({moves, species, items, natures, types}));
console.log(`teambuilder data: ${Object.keys(species).length} species, ${moves.length} moves, ${items.length} items, ${fs.statSync(out).size} bytes`);
