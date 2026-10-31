// Copies the parts of Showdown's compiled sim that a gen9 random battle needs into romfs/ps,
// with a formats list trimmed to the formats the 3DS app offers.
// Usage: node tools/stage-sim.js <pokemon-showdown dir> <out dir>
'use strict';
const fs = require('fs');
const path = require('path');

const [src, out] = process.argv.slice(2).map(p => path.resolve(p));
const dist = path.join(src, 'dist');
const FORMATS = ['[Gen 9] Random Battle', '[Gen 9] OU', '[Gen 9] Ubers', '[Gen 9] UU', '[Gen 9] RU', '[Gen 9] NU',
  '[Gen 9] PU', '[Gen 9] Battle Factory'];
// Hooks we drop: Battle Factory is only used to generate COM / rental teams, never battled in.
const DROP = {'[Gen 9] Battle Factory': ['onBegin']};
// Big files the battle engine never reads during a random battle; replaced by empty tables.
const STUBS = {
  'data/learnsets.js': 'exports.Learnsets = {};',
  'data/random-battles/gen9/1v1-factory-sets.json': '{}',
  'data/random-battles/gen9/bss-factory-sets.json': '{}',
  'data/random-battles/gen9/doubles-sets.json': '{}',
  'data/random-battles/gen9/draft-factory-matchups.json': '{}',
};
const FILES = [
  'data/abilities.js', 'data/aliases.js', 'data/conditions.js', 'data/formats-data.js', 'data/items.js',
  'data/moves.js', 'data/natures.js', 'data/pokedex.js', 'data/pokemongo.js', 'data/rulesets.js',
  'data/scripts.js', 'data/tags.js', 'data/typechart.js',
  'data/random-battles/gen9/sets.json', 'data/random-battles/gen9/factory-sets.json', 'data/random-battles/gen9/teams.js',
  'lib/dashycode.js', 'lib/fs.js', 'lib/index.js', 'lib/net.js', 'lib/process-manager.js', 'lib/repl.js',
  'lib/sql.js', 'lib/streams.js', 'lib/utils.js', 'lib/crashlogger.js',
  'sim/battle-actions.js', 'sim/battle-queue.js', 'sim/battle-stream.js', 'sim/battle.js',
  'sim/dex-abilities.js', 'sim/dex-conditions.js', 'sim/dex-data.js', 'sim/dex-formats.js', 'sim/dex-items.js',
  'sim/dex-moves.js', 'sim/dex-species.js', 'sim/dex-text.js', 'sim/dex.js', 'sim/field.js', 'sim/index.js',
  'sim/pokemon.js', 'sim/prng.js', 'sim/side.js', 'sim/state.js', 'sim/team-validator.js', 'sim/teams.js',
];

fs.rmSync(out, {recursive: true, force: true});
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(out, rel)), {recursive: true});
  fs.writeFileSync(path.join(out, rel), text);
};
// Source map comments point at files we don't ship.
for (const f of FILES) write(f, fs.readFileSync(path.join(dist, f), 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n'));
for (const [f, text] of Object.entries(STUBS)) write(f, text);
write('node_modules/ts-chacha20/build/src/chacha20.js',
  fs.readFileSync(path.join(src, 'node_modules/ts-chacha20/build/src/chacha20.js'), 'utf8'));

const all = require(path.join(dist, 'config/formats.js')).Formats;
const picked = FORMATS.map(name => {
  const f = all.find(x => x.name === name);
  if (!f) throw new Error(`format not found: ${name}`);
  const copy = {...f};
  for (const k of DROP[name] || []) delete copy[k];
  for (const [k, v] of Object.entries(copy)) if (typeof v === 'function') throw new Error(`${name}.${k} is a function`);
  return copy;
});
write('config/formats.js', `exports.Formats = ${JSON.stringify(picked, null, '\t')};\n`);

let bytes = 0;
const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) e.isDirectory() ? walk(path.join(d, e.name)) : bytes += fs.statSync(path.join(d, e.name)).size; };
walk(out);
console.log(`staged ${(bytes / 1048576).toFixed(1)} MB into ${out}`);
