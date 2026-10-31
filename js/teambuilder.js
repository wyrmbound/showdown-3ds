// Teambuilder: create and edit teams on the console. Teams are plain Showdown export text in
// sdmc:/3ds/showdown3ds/teams/, the same files the rest of the app (and the website) reads.
// Adds methods to App; app.js routes screens starting with "tb-" here.
'use strict';

const TB_PER_PAGE = 8;
const EV_PRESETS = [
  ['252 Atk / 4 SpD / 252 Spe', 'Fast physical'],
  ['252 SpA / 4 SpD / 252 Spe', 'Fast special'],
  ['252 HP / 252 Atk / 4 SpD', 'Bulky physical attacker'],
  ['252 HP / 252 SpA / 4 SpD', 'Bulky special attacker'],
  ['252 HP / 252 Def / 4 SpD', 'Physical wall'],
  ['252 HP / 4 Def / 252 SpD', 'Special wall'],
];
const STAT_SHORT = {atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe'};

// ---- Showdown export text <-> editable sets ----

function tbParseSets(text) {
  const sets = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length || lines[0].startsWith('===')) continue;
    const [head, item = ''] = lines[0].split(' @ ');
    // "Nickname (Species) (M)" or "Species (F)" or "Species"
    const gender = (/\s*\((M|F)\)\s*$/.exec(head) || [])[1] || '';
    const parts = head.replace(/\s*\((M|F)\)\s*$/, '').match(/^(.*?)(?:\s*\(([^()]+)\))?$/);
    const set = {nickname: parts[2] ? parts[1] : '', species: parts[2] || parts[1], gender, item: item.trim(),
      ability: '', tera: '', nature: '', evs: '', moves: [], extra: []};
    for (const l of lines.slice(1)) {
      if (l.startsWith('- ')) set.moves.push(l.slice(2).trim());
      else if (l.startsWith('Ability:')) set.ability = l.slice(8).trim();
      else if (l.startsWith('Tera Type:')) set.tera = l.slice(10).trim();
      else if (l.startsWith('EVs:')) set.evs = l.slice(4).trim();
      else if (/ Nature$/.test(l)) set.nature = l.slice(0, -7).trim();
      else set.extra.push(l); // IVs, Level, Shiny, ... kept as they were
    }
    sets.push(set);
  }
  return sets;
}

function tbExportSets(sets) {
  return sets.filter(s => s.species).map(s => {
    const out = [`${s.nickname ? `${s.nickname} (${s.species})` : s.species}${s.gender ? ` (${s.gender})` : ''}${s.item ? ` @ ${s.item}` : ''}`];
    if (s.ability) out.push(`Ability: ${s.ability}`);
    if (s.tera) out.push(`Tera Type: ${s.tera}`);
    if (s.evs) out.push(`EVs: ${s.evs}`);
    if (s.nature) out.push(`${s.nature} Nature`);
    out.push(...s.extra);
    for (const m of s.moves) if (m) out.push(`- ${m}`);
    return out.join('\n');
  }).join('\n\n');
}

Object.assign(App.prototype, {
  tbData() {
    return this.tbCache ||= JSON.parse(__readFile(__CLIENT_DATA.replace('client.json', 'tb.json')) || '{"species":{},"moves":[],"items":[],"natures":[],"types":[]}');
  },

  // Every team in every file, remembering where it lives so it can be saved back in place.
  tbAllTeams() {
    const dir = __DATA + '/teams', out = [];
    for (const file of (__listDir(dir) || []).filter(f => /\.txt$/i.test(f)).sort()) {
      parseTeamFile(file, __readFile(`${dir}/${file}`) || '').forEach((t, index) => out.push({...t, file, index}));
    }
    return out;
  },

  tbOpen() {
    this.tbTeams = this.tbAllTeams();
    this.tbPage = 0;
    this.notice = '';
    this.go('tb-teams');
  },

  tbEdit(team) {
    this.tbTeam = {name: team.name, format: team.format, file: team.file, index: team.index,
      sets: tbParseSets(team.text).slice(0, 6)};
    while (this.tbTeam.sets.length < 6) this.tbTeam.sets.push(null);
    this.tbDirty = false;
    this.go('tb-team');
  },

  // Writes the team back into its file (other teams in the same file are kept).
  tbSave() {
    const t = this.tbTeam, dir = __DATA + '/teams';
    if (!t.file) t.file = `${t.name.replace(/[^\w -]/g, '').trim() || 'team'}-${Date.now() % 100000}.txt`;
    const teams = parseTeamFile(t.file, __readFile(`${dir}/${t.file}`) || '');
    const block = {name: t.name, format: t.format, text: tbExportSets(t.sets.filter(Boolean)) + '\n'};
    if (t.index != null && t.index < teams.length) teams[t.index] = block;
    else { t.index = teams.length; teams.push(block); }
    __writeFile(`${dir}/${t.file}`, teams.map(x => `=== ${x.format ? `[${x.format}] ` : ''}${x.name} ===\n\n${x.text.trim()}\n`).join('\n'));
    this.tbDirty = false;
    this.notice = `Saved "${t.name}".`;
  },

  tbDelete() {
    const t = this.tbTeam, dir = __DATA + '/teams';
    if (t.file) {
      const teams = parseTeamFile(t.file, __readFile(`${dir}/${t.file}`) || '').filter((_, i) => i !== t.index);
      if (teams.length) __writeFile(`${dir}/${t.file}`, teams.map(x => `=== ${x.format ? `[${x.format}] ` : ''}${x.name} ===\n\n${x.text.trim()}\n`).join('\n'));
      else __removeFile(`${dir}/${t.file}`);
    }
    this.tbOpen();
    this.notice = `Deleted "${t.name}".`;
  },

  // ---- picking a value from a list (species, item, move, ...) ----
  // options: [{id, label, sub}]; onPick(id). search: show a Search button (keyboard filter).
  tbPick(title, options, onPick, search = false) {
    this.tbPicker = {title, all: options, options, onPick, search, page: 0, back: this.screen};
    this.go('tb-pick');
  },

  tbFilter(text) {
    const p = this.tbPicker, q = Tracker.toID(text || '');
    p.options = q ? p.all.filter(o => Tracker.toID(o.label).includes(q)) : p.all;
    p.page = 0;
  },

  tbSet() { return this.tbTeam.sets[this.tbSlot]; },

  tbSpeciesOptions() {
    return Object.keys(this.tbData().species).sort().map(n => ({id: n, label: n, sub: this.tbData().species[n].t.join('/')}));
  },

  tbField(id) {
    const d = this.tbData(), set = this.tbSet(), info = d.species[set.species] || {t: [], a: [], m: []};
    const done = () => { this.tbDirty = true; this.go('tb-mon'); };
    if (id === 'species') {
      this.tbPick('Pokemon', this.tbSpeciesOptions(), name => {
        const s = d.species[name];
        Object.assign(set, {species: name, ability: s.a[0], tera: s.t[0], moves: set.moves.filter(m => s.m.some(i => d.moves[i] === m))});
        done();
      }, true);
    } else if (id === 'item') {
      this.tbPick('Item', [{id: '', label: '(none)'}, ...d.items.map(n => ({id: n, label: n}))], v => { set.item = v; done(); }, true);
    } else if (id === 'ability') {
      this.tbPick('Ability', info.a.map(n => ({id: n, label: n})), v => { set.ability = v; done(); });
    } else if (id === 'tera') {
      this.tbPick('Tera Type', d.types.map(n => ({id: n, label: n})), v => { set.tera = v; done(); });
    } else if (id === 'nature') {
      this.tbPick('Nature', d.natures.map(([n, plus, minus]) => ({id: n, label: n,
        sub: plus ? `+${STAT_SHORT[plus]} -${STAT_SHORT[minus]}` : 'neutral'})), v => { set.nature = v; done(); });
    } else if (id === 'evs') {
      this.tbPick('EV spread', EV_PRESETS.map(([evs, name]) => ({id: evs, label: name, sub: evs})), v => { set.evs = v; done(); });
    } else if (id.startsWith('move')) {
      const n = +id.slice(4) - 1;
      const taken = new Set(set.moves.filter((m, i) => i !== n));
      const options = info.m.map(i => d.moves[i]).filter(m => !taken.has(m)).map(m => ({id: m, label: m}));
      this.tbPick(`Move ${n + 1}`, [{id: '', label: '(none)'}, ...options], v => {
        set.moves[n] = v;
        set.moves = set.moves.filter((m, i) => m || i < 4).slice(0, 4);
        done();
      }, true);
    }
  },

  // ---- input ----
  tbSelect(id) {
    const s = this.screen;
    if (s === 'tb-teams') {
      if (id === 'back') this.go('menu');
      else if (id === 'more') this.tbPage++;
      else if (id === 'new') this.cmd('keyboard', 'tb-new', 'Team name', 'New team', 40);
      else if (id.startsWith('team-')) this.tbEdit(this.tbTeams[+id.slice(5)]);
    } else if (s === 'tb-team') {
      if (id === 'back') { if (this.tbDirty) this.tbSave(); this.tbOpen(); }
      else if (id === 'save') this.tbSave();
      else if (id === 'rename') this.cmd('keyboard', 'tb-rename', 'Team name', this.tbTeam.name, 40);
      else if (id === 'delete') { this.notice = ''; this.go('tb-delete'); }
      else if (id === 'format') {
        this.tbPick('Format', [{id: '', label: 'Any format'}, ...FORMATS.filter(f => !f.random).map(f => ({id: f.id, label: f.name}))],
          v => { this.tbTeam.format = v; this.tbDirty = true; this.go('tb-team'); });
      } else if (id.startsWith('slot')) {
        this.tbSlot = +id.slice(4);
        if (this.tbTeam.sets[this.tbSlot]) this.go('tb-mon');
        else { // empty slot: choose the Pokemon first
          this.tbTeam.sets[this.tbSlot] = {nickname: '', species: '', item: '', ability: '', tera: '', nature: '', evs: '', moves: [], extra: []};
          this.go('tb-mon');
          this.tbField('species');
          this.tbPicker.back = 'tb-team';
          this.tbPicker.cancel = () => { this.tbTeam.sets[this.tbSlot] = null; };
        }
      }
    } else if (s === 'tb-delete') {
      if (id === 'yes') this.tbDelete(); else this.go('tb-team');
    } else if (s === 'tb-mon') {
      if (id === 'done') this.go('tb-team');
      else if (id === 'remove') { this.tbTeam.sets[this.tbSlot] = null; this.tbDirty = true; this.go('tb-team'); }
      else this.tbField(id);
    } else if (s === 'tb-pick') {
      const p = this.tbPicker;
      if (id === 'back') { p.cancel?.(); this.go(p.back); }
      else if (id === 'more') p.page++;
      else if (id === 'search') this.cmd('keyboard', 'tb-search', `Search ${p.title.toLowerCase()}`, '', 30);
      else if (id.startsWith('opt-')) p.onPick(p.options[+id.slice(4)].id);
    }
  },

  tbKeyboard(tag, text) {
    text = (text || '').trim();
    if (tag === 'tb-search' && this.screen === 'tb-pick') this.tbFilter(text);
    else if (tag === 'tb-new' && text) {
      this.tbTeam = {name: text.slice(0, 40), format: '', file: null, index: null, sets: [null, null, null, null, null, null]};
      this.tbDirty = true;
      this.go('tb-team');
    } else if (tag === 'tb-rename' && text) { this.tbTeam.name = text.slice(0, 40); this.tbDirty = true; }
  },

  // ---- view ----
  tbView(v) {
    const s = this.screen;
    v.layout = 'grid';
    v.textColor = 0xc8d2e8;
    if (s === 'tb-teams') {
      const teams = this.tbTeams, pages = Math.max(1, Math.ceil(teams.length / 6)), page = this.tbPage % pages;
      v.title = 'Teams';
      v.buttons = teams.slice(page * 6, page * 6 + 6).map((t, i) => ({id: `team-${page * 6 + i}`, label: t.name,
        sub: `${FORMATS.find(f => f.id === t.format)?.name || 'Any format'}  ${tbParseSets(t.text).length}/6`}));
      v.buttons.push({id: 'new', label: 'New team', small: true});
      if (pages > 1) v.buttons.push({id: 'more', label: `More (${page + 1}/${pages})`, small: true});
      v.buttons.push({id: 'back', label: 'Back', small: true});
      if (!teams.length && !v.text) v.text = 'No teams yet: make one with New team.';
    } else if (s === 'tb-team') {
      const t = this.tbTeam;
      v.title = `${t.name}${this.tbDirty ? ' *' : ''}`;
      v.buttons = t.sets.map((set, i) => set
        ? {id: `slot${i}`, label: set.species, sub: set.item || 'No item', sprite: this.tracker.spritePath({species: set.species}, false, true)}
        : {id: `slot${i}`, label: '(empty)', sub: 'Add a Pokemon'});
      v.buttons.push({id: 'format', label: FORMATS.find(f => f.id === t.format)?.name || 'Any format', small: true},
        {id: 'rename', label: 'Rename', small: true}, {id: 'save', label: 'Save', small: true},
        {id: 'delete', label: 'Delete', small: true}, {id: 'back', label: 'Back', small: true});
    } else if (s === 'tb-delete') {
      v.layout = 'list';
      v.title = `Delete "${this.tbTeam.name}"?`;
      v.buttons = [{id: 'yes', label: 'Yes, delete it'}, {id: 'no', label: 'Keep it'}];
    } else if (s === 'tb-mon') {
      const set = this.tbSet(), info = this.tbData().species[set.species];
      v.title = set.species || 'New Pokemon';
      v.buttons = [
        {id: 'species', label: set.species || 'Choose Pokemon', sub: info ? info.t.join('/') : ''},
        {id: 'item', label: set.item || 'No item', sub: 'Item'},
        {id: 'ability', label: set.ability || '(ability)', sub: 'Ability'},
        {id: 'tera', label: set.tera || '(Tera type)', sub: 'Tera Type'},
        {id: 'nature', label: set.nature || '(nature)', sub: 'Nature'},
        {id: 'evs', label: (EV_PRESETS.find(p => p[0] === set.evs) || [, set.evs ? 'Custom' : '(EVs)'])[1], sub: set.evs || 'EV spread'},
        ...[0, 1, 2, 3].map(i => ({id: `move${i + 1}`, label: set.moves[i] || '(empty)', sub: `Move ${i + 1}`,
          color: set.moves[i] ? TYPE_COLORS[this.moveType(Tracker.toID(set.moves[i]))] : undefined})),
        {id: 'remove', label: 'Remove', small: true}, {id: 'done', label: 'Done', small: true},
      ];
      for (const b of v.buttons) if (['ability', 'tera', 'nature', 'evs'].includes(b.id) || b.id.startsWith('move')) b.enabled = !!set.species;
    } else if (s === 'tb-pick') {
      const p = this.tbPicker, pages = Math.max(1, Math.ceil(p.options.length / TB_PER_PAGE)), page = p.page % pages;
      v.title = p.title;
      v.buttons = p.options.slice(page * TB_PER_PAGE, page * TB_PER_PAGE + TB_PER_PAGE)
        .map((o, i) => ({id: `opt-${page * TB_PER_PAGE + i}`, label: o.label, sub: o.sub}));
      if (p.search) v.buttons.push({id: 'search', label: 'Search', small: true});
      if (pages > 1) v.buttons.push({id: 'more', label: `More ${page + 1}/${pages}`, small: true});
      v.buttons.push({id: 'back', label: 'Back', small: true});
      if (!p.options.length) v.text = 'Nothing matches. Try another search.';
    }
  },
});

if (typeof module !== 'undefined') module.exports = {tbParseSets, tbExportSets};
else Object.assign(globalThis, {tbParseSets, tbExportSets});
