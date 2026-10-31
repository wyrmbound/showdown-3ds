// node tests/teambuilder-node.js : builds a team through the teambuilder's screens (as a player
// would), saves it, reloads it, and checks it with Showdown's real team validator (full data on
// the PC) for Gen 9 OU.
'use strict';
const path = require('path');
const cleanup = require('./boot-node')();
const {Teams, TeamValidator} = require(path.join(__dirname, '../vendor/pokemon-showdown/dist/sim'));

const app = new App();
app.tick(0);
const keyboard = answers => { for (const [cmd, tag] of app.takeCommands()) if (cmd === 'keyboard') app.keyboardDone(tag, answers[tag]); };
const pickLabel = label => {
  const p = app.tbPicker, i = p.options.findIndex(o => o.label === label);
  if (i < 0) throw new Error(`"${label}" not offered in ${p.title}`);
  p.page = Math.floor(i / 8);
  app.select(`opt-${i}`);
};
const search = (text, label) => { app.select('search'); keyboard({'tb-search': text}); pickLabel(label); };

app.select('teams');
app.select('new'); keyboard({'tb-new': 'Test Squad'});
app.select('format'); pickLabel('OU');
app.select('slot0');                                    // empty slot: goes straight to the Pokemon list
search('garch', 'Garchomp');
for (const [field, text, label] of [['item', 'scarf', 'Choice Scarf'], ['move1', 'earthq', 'Earthquake'],
  ['move2', 'outrage', 'Outrage'], ['move3', 'stoneedge', 'Stone Edge'], ['move4', 'firefang', 'Fire Fang']]) {
  app.select(field); search(text, label);
}
app.select('ability'); pickLabel('Rough Skin');
app.select('tera'); pickLabel('Fire');
app.select('nature'); pickLabel('Jolly');
app.select('evs'); pickLabel('Fast physical');
app.select('done');
app.select('save');
console.log('saved:', app.notice);

// Reload from disk and check what was written.
app.tbOpen();
const team = app.tbTeams.find(t => t.name === 'Test Squad');
if (!team || team.format !== 'gen9ou') throw new Error('team not found after saving');
console.log(team.text.trim().split('\n').join(' | '));
const sets = Teams.import(team.text);
const problems = TeamValidator.get('gen9ou').validateTeam(sets);
console.log(problems ? `FAIL validator: ${problems.join('; ')}` : 'ok   Showdown validator accepts the team for Gen 9 OU');

// Editing must not lose what the editor doesn't show (nickname, gender, shiny, IVs, level).
const text = 'Chompy (Garchomp) (F) @ Rocky Helmet\nAbility: Rough Skin\nShiny: Yes\nTera Type: Steel\n' +
  'EVs: 252 HP / 4 Atk / 252 Def\nImpish Nature\nIVs: 0 SpA\n- Stealth Rock\n- Earthquake\n- Dragon Tail\n- Spikes\n\n' +
  'Gholdengo @ Choice Scarf\nAbility: Good as Gold\nLevel: 50\nTera Type: Steel\nEVs: 252 SpA / 4 SpD / 252 Spe\n' +
  'Timid Nature\n- Make It Rain\n- Shadow Ball\n- Trick\n- Focus Blast\n\nRillaboom (M)\nAbility: Grassy Surge\n- Grassy Glide\n';
const before = Teams.import(text), after = Teams.import(tbExportSets(tbParseSets(text)));
const lost = before.flatMap((s, i) => Object.keys(s).filter(k => JSON.stringify(s[k]) !== JSON.stringify(after[i]?.[k])).map(k => `${s.species}.${k}`));
console.log(lost.length ? `FAIL round trip lost: ${lost.join(', ')}` : 'ok   editing keeps nickname, gender, shiny, IVs and level');

// Delete it again through the screens.
app.tbEdit(team);
app.select('delete'); app.select('yes');
console.log(app.tbAllTeams().some(t => t.name === 'Test Squad') ? 'FAIL team still there after delete' : 'ok   deleted');
cleanup();
process.exit(problems || lost.length ? 1 : 0);
