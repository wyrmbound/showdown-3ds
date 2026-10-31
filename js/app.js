// The whole app's logic. The C side only draws `app.view`, forwards input and runs the
// commands the app queues (websocket, HTTP, keyboard). Host functions it relies on:
// __readFile(path) -> string|null, __writeFile(path, text), __listDir(path) -> string[]|null, __DATA (SD folder).
'use strict';

const FORMATS = [
  {id: 'gen9randombattle', name: 'Random Battle', random: true},
  {id: 'gen9ou', name: 'OU', tier: 'OU'},
  {id: 'gen9ubers', name: 'Ubers', tier: 'Uber'},
  // Lower tiers: Battle Factory has sets for each, so rentals and the COM work the same way.
  {id: 'gen9uu', name: 'UU', tier: 'UU'},
  {id: 'gen9ru', name: 'RU', tier: 'RU'},
  {id: 'gen9nu', name: 'NU', tier: 'NU'},
  {id: 'gen9pu', name: 'PU', tier: 'PU'},
];
const DEFAULT_SERVER = 'sim3.psim.us:8000';
const DEFAULT_LOGIN = 'http://play.pokemonshowdown.com/action.php'; // unregistered names only
const LOGIN_API = 'https://play.pokemonshowdown.com/api/'; // passwords and sessions: HTTPS only
// Milliseconds per battle animation (moves, hits, ...); 0 = just refresh the display.
const ANIM_MS = {switch: 450, move: 550, hit: 450, heal: 400, faint: 650, boost: 400, drop: 400, status: 400, update: 0};
const effectHint = m => ({4: 'x4', 2: 'x2', 0.5: 'x1/2', 0.25: 'x1/4', 0: 'no effect'})[m] || '';
// Settings: config.txt key -> the values a tap cycles through (first = default) and their labels.
const SETTINGS = {
  anim: {label: 'Animations', values: ['normal', 'fast', 'off'], names: ['Normal', 'Fast', 'Off']},
  sprites: {label: 'Sprites', values: ['ani', 'gen5ani', 'gen5'], names: ['Current (3D)', '2D animated', 'Still']},
  difficulty: {label: 'COM', values: ['normal', 'hard', 'easy'], names: ['Normal', 'Hard', 'Easy']},
  sound: {label: 'Sound', values: ['on', 'off'], names: ['On', 'Off']},
};
const ANIM_SPEED = {normal: 1, fast: 0.5, off: 0};
const PAGE = 3; // teams per page; fits the bottom screen with Rental + More + Back
const TYPE_COLORS = {
  Normal: 0xA8A878, Fire: 0xF08030, Water: 0x6890F0, Electric: 0xF8D030, Grass: 0x78C850, Ice: 0x98D8D8,
  Fighting: 0xC03028, Poison: 0xA040A0, Ground: 0xE0C068, Flying: 0xA890F0, Psychic: 0xF85888, Bug: 0xA8B820,
  Rock: 0xB8A038, Ghost: 0x705898, Dragon: 0x7038F8, Dark: 0x705848, Steel: 0xB8B8D0, Fairy: 0xEE99AC,
  Stellar: 0x40B5A5, '???': 0x68A090,
};

function parseConfig(text) {
  const cfg = {};
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) cfg[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return cfg;
}

// Showdown "export" text. A file may hold several teams under "=== [gen9ou] Name ===" headers.
function parseTeamFile(file, text) {
  const teams = [];
  let cur = null;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const h = line.match(/^===\s*(?:\[([^\]]+)\]\s*)?(.*?)\s*===\s*$/);
    if (h) {
      cur = {name: h[2] || file, format: h[1] || '', text: ''};
      teams.push(cur);
    } else {
      if (!cur) { cur = {name: file.replace(/\.txt$/i, ''), format: '', text: ''}; teams.push(cur); }
      cur.text += line + '\n';
    }
  }
  return teams.filter(t => t.text.trim());
}

class OfflineBattle {
  constructor(sim, tracker, format, p1, p2) {
    this.tracker = tracker;
    this.comReq = null;
    this.battle = new sim.Battle({formatid: format, send: (t, d) => this.onSend(t, d)});
    this.battle.setPlayer('p1', p1);
    this.battle.setPlayer('p2', p2);
    this.pump();
  }

  onSend(type, data) {
    if (type === 'update') { this.tracker.feed(data.join('\n')); return; }
    if (type !== 'sideupdate') return;
    const nl = data.indexOf('\n');
    const side = data.slice(0, nl), msg = data.slice(nl + 1);
    if (side === 'p1') this.tracker.feed(msg);
    else if (msg.startsWith('|request|')) this.comReq = JSON.parse(msg.slice(9));
  }

  choose(choice) {
    this.battle.choose('p1', choice);
    this.pump();
  }

  forfeit() { this.battle.forceWin('p2'); this.pump(); }

  pump() {
    this.battle.sendUpdates();
    for (let guard = 0; this.comReq && guard < 20; guard++) {
      const req = this.comReq;
      this.comReq = null;
      if (req.wait || this.battle.ended) continue;
      let choice = 'default';
      try { choice = chooseCOM(this.battle, 'p2', req, this.difficulty); } catch (e) { console.log('COM error: ' + e); }
      if (!this.battle.choose('p2', choice)) this.battle.choose('p2', 'default');
      this.battle.sendUpdates();
    }
  }
}

class App {
  constructor() {
    this.cfg = parseConfig(__readFile(__DATA + '/config.txt'));
    const client = JSON.parse(__readFile(globalThis.__CLIENT_DATA) || '{"species":{},"moves":{}}');
    this.moveTypes = client.moves;
    this.statusMoves = new Set(client.status || []);
    this.client = client; // types, type chart, item and ability names
    this.tracker = new Tracker(client.species);
    this.applySettings();
    this.tracker.moveInfo = id => ({type: this.moveType(id), status: this.isStatusMove(id)});
    this.resetAnims();
    this.cmds = [];
    this.jobs = [];
    this.ticks = 0;
    this.sim = null;
    this.notice = '';
    this.net = null; // online session state
    this.offline = null;
    this.flow = null; // what we are setting up: {mode, action, format, target, page}
    this.go('menu');
  }

  // ---- host interface ----
  takeCommands() { const c = this.cmds; this.cmds = []; return c; }

  tick(now) {
    this.ticks++;
    this.now = now;
    const job = this.jobs[0];
    if (job && job.after <= this.ticks) {
      this.jobs.shift();
      try { job.fn(); } catch (e) { this.fail(e); }
    }
    if (this.screen === 'battle') this.battleTick();
    this.reconnectTick(now);
    this.view = this.buildView();
  }

  select(id) {
    const btn = (this.view?.buttons || []).find(b => b.id === id);
    if (btn && btn.enabled === false) return;
    try { this.onSelect(id); } catch (e) { this.fail(e); }
    this.view = this.buildView();
  }

  back() {
    const b = (this.view?.buttons || []).find(x => x.id === 'back' || x.id === 'cancel');
    if (b) this.select(b.id);
    else if (this.screen === 'battle' && this.battleMode === 'party') this.select('back');
  }

  keyboardDone(tag, text) {
    try { this.onKeyboard(tag, text); } catch (e) { this.fail(e); }
    this.view = this.buildView();
  }

  httpDone(tag, status, body, cookies) {
    try {
      if (tag === 'assert') this.onAssertion(status, body);
      else if (tag === 'login' || tag === 'upkeep') this.onLoginReply(tag, status, body, cookies);
      else if (tag === 'paste') this.onPaste(status, body);
    } catch (e) { this.fail(e); }
  }

  netEvent(type, data) {
    try {
      if (type === 'open') this.status = 'Connected. Logging in...';
      else if (type === 'message') this.onServer(data);
      else if (type === 'closed') this.onNetClosed(data);
    } catch (e) { this.fail(e); }
  }

  // ---- helpers ----
  later(fn) { this.jobs.push({fn, after: this.ticks + 2}); }
  cmd(...c) { this.cmds.push(c); }
  send(text) { this.cmd('ws_send', text); }

  fail(e) {
    console.log('error: ' + (e && e.stack || e));
    this.notice = 'Error: ' + (e && e.message || e);
    if (this.offline) this.offline = null;
    this.go(this.net ? 'lobby' : 'menu');
  }

  go(screen) {
    this.screen = screen;
    if (screen !== 'battle') this.battleMode = null;
  }

  saveConfig() {
    __writeFile(__DATA + '/config.txt', Object.entries(this.cfg).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  }

  loadSim() {
    if (!this.sim) this.sim = require('/sim/index.js');
    return this.sim;
  }

  teamsFor(formatId) {
    const out = [];
    const dir = __DATA + '/teams';
    for (const f of (__listDir(dir) || []).sort()) {
      if (!/\.txt$/i.test(f)) continue;
      for (const t of parseTeamFile(f, __readFile(dir + '/' + f) || '')) {
        if (!t.format || t.format === formatId) out.push(t);
      }
    }
    return out;
  }

  // Resolves the team the player picked into sets (needs the sim's team code).
  playerSets(flow) {
    const {Teams} = this.loadSim();
    if (flow.format.random) return Teams.generate(flow.format.id);
    if (flow.team === 'rental') return this.factoryTeam(flow.format);
    const sets = Teams.import(flow.team.text);
    if (!sets || !sets.length) throw new Error(`Couldn't read team "${flow.team.name}"`);
    return sets;
  }

  // Battle Factory sets, minus anything the target format bans (e.g. Tera Blast in OU).
  factoryTeam(format) {
    const {Teams, Dex} = this.loadSim();
    const rules = Dex.formats.getRuleTable(Dex.formats.get(format.id));
    const banned = (kind, name) => name && rules.isBanned(`${kind}:${Tracker.toID(name)}`);
    for (let tries = 0; ; tries++) {
      const gen = Teams.getGenerator('gen9battlefactory');
      gen.factoryTier = format.tier;
      const team = gen.randomFactoryTeam();
      if (tries < 20 && team.some(s => banned('ability', s.ability) || banned('pokemon', s.species))) continue;
      for (const set of team) {
        set.moves = set.moves.filter(m => !banned('move', m));
        if (banned('item', set.item)) set.item = '';
      }
      return team;
    }
  }

  // ---- input ----
  onSelect(id) {
    const s = this.screen;
    if (s.startsWith('tb-')) return this.tbSelect(id);
    if (s === 'menu') {
      this.notice = '';
      if (id === 'online') this.startOnline();
      else if (id === 'com') { this.flow = {mode: 'com', action: 'battle'}; this.go('format'); }
      else if (id === 'account') this.go('account');
      else if (id === 'settings') { this.notice = ''; this.go('settings'); }
      else if (id === 'teams') this.tbOpen();
      else if (id === 'exit') this.cmd('exit');
    } else if (s === 'settings') {
      if (id === 'back') this.go('menu');
      else if (id === 'server') this.cmd('keyboard', 'server', 'Server (host:port)', this.cfg.server || DEFAULT_SERVER, 60);
      else if (id === 'clearcache') { this.cmd('clear_cache'); this.notice = 'Sprite and engine caches cleared.'; }
      else if (SETTINGS[id]) {
        const opt = SETTINGS[id], i = opt.values.indexOf(this.setting(id));
        this.cfg[id] = opt.values[(i + 1) % opt.values.length];
        this.saveConfig();
        this.applySettings();
      }
    } else if (s === 'account') {
      if (id === 'back') this.go('menu');
      else if (id === 'changename') this.askName('name');
      else if (id === 'loginpw') { this.notice = ''; if (this.cfg.name) this.askPassword(); else this.askName('name'); }
      else if (id === 'logout') {
        delete this.cfg.sid; // the session only lives on this console; the password was never saved
        this.saveConfig();
        this.notice = 'Logged out on this console.';
      }
    } else if (s === 'format') {
      if (id === 'back') { this.go(this.flow.mode === 'com' ? 'menu' : 'lobby'); return; }
      this.flow.format = FORMATS.find(f => f.id === id);
      if (this.flow.format.random) this.flowReady(); else this.showTeams();
    } else if (s === 'team') {
      if (id === 'back') { this.go(this.flow.action === 'accept' ? 'lobby' : 'format'); return; }
      if (id === 'more') { this.flow.page++; return; }
      if (id === 'import') { this.notice = ''; this.cmd('keyboard', 'paste', 'pokepast.es link or ID', 'https://pokepast.es/', 80); return; }
      this.flow.team = id === 'rental' ? 'rental' : this.flow.teams[+id.slice(5)];
      this.flowReady();
    } else if (s === 'connecting' || s === 'lobby') {
      if (id === 'cancel' || id === 'back') { this.cmd('ws_close'); this.net = null; this.go('menu'); }
      else if (id === 'search') { this.notice = ''; this.flow = {mode: 'online', action: 'search'}; this.go('format'); }
      else if (id === 'challenge') { this.notice = ''; this.cmd('keyboard', 'challenge', 'Player to challenge', '', 18); }
      else if (id === 'messages') { this.notice = ''; this.go('messages'); }
    } else if (s === 'messages') {
      if (id === 'back') this.go('lobby');
      else if (id === 'newpm') this.cmd('keyboard', 'pm-to', 'Send a message to', '', 18);
      else if (id.startsWith('conv-')) this.openConversation(id.slice(5));
    } else if (s === 'conversation') {
      if (id === 'back') this.go('messages');
      else if (id === 'reply') this.cmd('keyboard', 'pm', `Message to ${this.convName()}`, '', 150);
    } else if (s === 'searching') {
      if (id === 'cancel') this.send('|/cancelsearch');
    } else if (s === 'challenging') {
      if (id === 'cancel') this.send(`|/cancelchallenge ${this.flow.target}`);
    } else if (s === 'challenged') {
      const ch = this.net.challengedBy;
      if (id === 'decline') { this.send(`|/reject ${ch.user}`); this.net.challengedBy = null; this.go('lobby'); }
      else if (id === 'accept') {
        const format = FORMATS.find(f => f.id === ch.format);
        this.flow = {mode: 'online', action: 'accept', format, target: ch.user};
        if (format.random) this.flowReady(); else this.showTeams();
      }
    } else if (s === 'battle') {
      this.onBattleSelect(id);
    }
  }

  showTeams() {
    this.flow.teams = this.teamsFor(this.flow.format.id);
    this.flow.page = 0;
    this.go('team');
  }

  askName(tag) { this.cmd('keyboard', tag, 'Your Showdown name', this.cfg.name || '', 18); }

  onKeyboard(tag, text) {
    if (tag.startsWith('tb-')) return this.tbKeyboard(tag, text);
    text = (text || '').trim();
    if (tag === 'password') {
      if (!text) { // cancelled: offer a different name instead
        if (this.net && !this.net.named) this.askName('name');
        return;
      }
      this.password = text;
      if (this.net && this.net.challstr) this.login(); else this.startOnline();
      return;
    }
    if (tag === 'name' || tag === 'name-online') {
      if (!text || !Tracker.toID(text)) { if (tag === 'name-online') this.go('menu'); return; }
      if (Tracker.toID(text) !== Tracker.toID(this.cfg.name || '')) delete this.cfg.sid; // the session belonged to the old name
      this.cfg.name = text.slice(0, 18);
      this.saveConfig();
      if (tag === 'name-online') this.startOnline();
      else if (this.net && this.net.challstr) this.login();
    } else if (tag === 'challenge' && text) {
      this.flow = {mode: 'online', action: 'challenge', target: text};
      this.go('format');
    } else if (tag === 'pm-to' && Tracker.toID(text)) {
      this.conversation(text).name = text;
      this.openConversation(Tracker.toID(text));
      this.cmd('keyboard', 'pm', `Message to ${text}`, '', 150);
    } else if (tag === 'pm' && text && this.net) {
      this.send(`|/pm ${this.convName()}, ${text}`); // the server echoes it back; it's stored then
    } else if (tag === 'server') {
      if (text && /^[\w.-]+(:\d+)?$/.test(text)) { this.cfg.server = text; this.saveConfig(); this.notice = `Server set to ${text}.`; }
      else if (text) this.notice = 'Use host or host:port, e.g. sim3.psim.us:8000';
    } else if (tag === 'paste' && text) {
      const id = /([0-9a-f]{16})/i.exec(text);
      if (!id) { this.notice = "That doesn't look like a pokepast.es link."; return; }
      this.notice = 'Downloading the team...';
      this.cmd('https', 'paste', `https://pokepast.es/${id[1].toLowerCase()}/json`, '', '');
    } else if (tag === 'chat' && text && this.net && this.room) {
      this.send(`${this.room}|${text}`);
    }
  }

  // pokepast.es JSON: {title, author, notes, paste}. Saved as a team for the format being chosen.
  onPaste(status, body) {
    let data = null;
    try { data = status === 200 ? JSON.parse(body) : null; } catch {}
    const text = (data?.paste || '').replace(/\r/g, '');
    if (!text.trim()) {
      this.notice = status === 404 ? 'No team found at that link.' : status ? `Couldn't read that paste (${status}).` : `Download failed: ${body || 'no connection'}`;
      return;
    }
    const name = (data.title || 'Imported team').replace(/[=[\]\r\n]/g, '').trim().slice(0, 40) || 'Imported team';
    const file = `${name.replace(/[^\w -]/g, '').trim() || 'team'}-${Date.now() % 100000}.txt`;
    const format = this.flow?.format?.id || '';
    __writeFile(`${__DATA}/teams/${file}`, `=== ${format ? `[${format}] ` : ''}${name} ===\n\n${text.trim()}\n`);
    this.notice = `Imported "${name}".`;
    if (this.screen === 'team') this.showTeams();
  }

  // ---- private messages ----
  conversation(name) {
    const id = Tracker.toID(name);
    return this.net.pms[id] ||= {name, lines: [], unread: 0};
  }

  openConversation(id) {
    this.convId = id;
    this.net.pms[id].unread = 0;
    this.go('conversation');
  }

  convName() { return this.net.pms[this.convId]?.name || this.convId; }

  // Everything chosen: start the battle / search / challenge. Loading teams can take a few
  // seconds on the console, so it runs as a job after a "Loading" frame has been drawn.
  flowReady() {
    const flow = this.flow;
    this.busyText = flow.mode === 'com' ? 'Loading the battle engine...' : 'Preparing your team...';
    this.go('busy');
    this.later(() => {
      if (flow.mode === 'com') return this.startCOM(flow);
      const packed = flow.format.random ? 'null' : this.loadSim().Teams.pack(this.playerSets(flow));
      this.send(`|/utm ${packed}`);
      if (flow.action === 'search') this.send(`|/search ${flow.format.id}`);
      else if (flow.action === 'challenge') this.send(`|/challenge ${flow.target}, ${flow.format.id}`);
      else if (flow.action === 'accept') { this.send(`|/accept ${flow.target}`); this.net.challengedBy = null; }
      // Show the waiting screen right away so "Find a battle" can't be pressed twice.
      this.status = '';
      this.go(flow.action === 'search' ? 'searching' : flow.action === 'challenge' ? 'challenging' : 'lobby');
    });
  }

  // ---- COM battles ----
  startCOM(flow) {
    const sim = this.loadSim();
    const comTeam = flow.format.random ? sim.Teams.generate(flow.format.id) : this.factoryTeam(flow.format);
    this.tracker.reset('p1');
    this.resetAnims();
    this.room = null;
    this.answered = null;
    this.go('battle');
    this.offline = new OfflineBattle(sim, this.tracker, flow.format.id,
      {name: this.cfg.name || 'You', team: this.playerSets(flow)}, {name: 'COM', team: comTeam});
    this.offline.difficulty = this.setting('difficulty');
  }

  // ---- online ----
  startOnline() {
    if (!this.cfg.name) { this.askName('name-online'); return; }
    const [host, port] = (this.cfg.server || DEFAULT_SERVER).split(':');
    this.net = {challstr: '', named: false, userName: '', challengedBy: null, pms: {}};
    this.status = `Connecting to ${host}...`;
    this.go('connecting');
    this.cmd('ws_open', host, +port || 8000, '/showdown/websocket');
  }

  // Order: a password just typed in, then the saved session, then the unregistered-name route.
  login() {
    const login = this.cfg.login ?? DEFAULT_LOGIN;
    this.status = `Logging in as ${this.cfg.name}...`;
    if (!login) { this.send(`|/trn ${this.cfg.name},0,`); return; } // local test servers with no login server
    const challstr = encodeURIComponent(this.net.challstr);
    if (this.password) {
      const body = `name=${encodeURIComponent(this.cfg.name)}&pass=${encodeURIComponent(this.password)}&challstr=${challstr}`;
      this.password = null; // used once over HTTPS, never stored
      this.cmd('https', 'login', `${LOGIN_API}login`, body, '');
    } else if (this.cfg.sid) {
      this.cmd('https', 'upkeep', `${LOGIN_API}upkeep?challstr=${challstr}`, '', `sid=${this.cfg.sid}`);
    } else {
      this.cmd('http_get', 'assert', `${login}?act=getassertion&userid=${Tracker.toID(this.cfg.name)}&challstr=${challstr}`);
    }
  }

  setting(key) { return SETTINGS[key].values.includes(this.cfg[key]) ? this.cfg[key] : SETTINGS[key].values[0]; }

  applySettings() {
    this.tracker.spriteStyle = this.setting('sprites');
    this.animSpeed = ANIM_SPEED[this.setting('anim')];
  }

  askPassword() { this.cmd('keyboard', 'password', `Password for ${this.cfg.name}`, '', 64, 'password'); }

  // Replies from Showdown's login API start with "]" followed by JSON.
  onLoginReply(tag, status, body, cookies) {
    let data = null;
    if (status === 200 && body && body.startsWith(']')) {
      try { data = JSON.parse(body.slice(1)); } catch {}
    }
    const assertion = data && typeof data.assertion === 'string' && !data.assertion.startsWith(';') ? data.assertion : '';
    if (tag === 'upkeep') {
      if (data?.loggedin && assertion) { this.send(`|/trn ${data.username},0,${assertion}`); return; }
      if (!status) { this.notice = `Login server unreachable: ${body || 'no connection'}`; this.cmd('ws_close'); return; }
      delete this.cfg.sid; // session expired or revoked
      this.saveConfig();
      this.notice = 'Your saved login has expired.';
      this.login();
      return;
    }
    if (data?.actionsuccess && assertion) {
      // sid = "userid,session,hash"; unregistered names get session 0, which upkeep won't accept.
      const sid = /(?:^|; )sid=([^;]+)/.exec(cookies || '');
      if (sid && decodeURIComponent(sid[1]).split(',')[1] !== '0') { this.cfg.sid = sid[1]; this.saveConfig(); }
      this.notice = '';
      this.send(`|/trn ${data.curuser?.username || this.cfg.name},0,${assertion}`);
      return;
    }
    if (!status) this.notice = `Login failed: ${body || 'no connection'}`;
    else this.notice = data?.assertion?.startsWith(';;') ? data.assertion.slice(2) : 'Wrong name or password.';
    this.askPassword();
  }

  onAssertion(status, body) {
    body = (body || '').trim();
    if (status !== 200 || !body || body.startsWith(';;')) {
      this.notice = body.startsWith(';;') ? body.slice(2) : `Login server error (${status})`;
      this.cmd('ws_close');
      return;
    }
    if (body === ';') { // registered name: needs its password
      this.notice = `"${this.cfg.name}" is registered. Enter its password, or cancel to pick another name.`;
      this.askPassword();
      return;
    }
    this.send(`|/trn ${this.cfg.name},0,${body}`);
  }

  onNetClosed(reason) {
    const wasOnline = !!this.net;
    this.net = null;
    if (!wasOnline) return;
    // Mid-battle (dropped Wi-Fi, woke from sleep): Showdown keeps the battle going, so reconnect
    // and it sends the battle back. Gives up after about a minute.
    if (this.screen === 'battle' && !this.offline && !this.tracker.ended) {
      const tries = (this.reconnect?.tries || 0) + 1;
      if (tries <= 12) {
        this.reconnect = {tries, at: (this.now || 0) + (tries === 1 ? 1000 : 5000)};
        return;
      }
      this.reconnect = null;
      this.tracker.ended = true;
    }
    if (!this.notice) this.notice = reason ? `Disconnected: ${reason}` : 'Disconnected from the server.';
    if (this.screen !== 'battle' || this.offline) this.go('menu');
  }

  reconnectTick(now) {
    if (!this.reconnect || this.net || now < this.reconnect.at) return;
    const [host, port] = (this.cfg.server || DEFAULT_SERVER).split(':');
    this.net = {challstr: '', named: false, userName: '', challengedBy: null, pms: {}};
    this.cmd('ws_open', host, +port || 8000, '/showdown/websocket');
  }

  onServer(text) {
    let room = '';
    if (text.startsWith('>')) {
      const nl = text.indexOf('\n');
      room = text.slice(1, nl < 0 ? undefined : nl);
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    if (room.startsWith('battle-')) return this.onBattleRoom(room, text);
    for (const line of text.split('\n')) {
      if (!line.startsWith('|')) continue;
      const parts = line.slice(1).split('|');
      const cmd = parts[0];
      if (cmd === 'challstr') { this.net.challstr = parts.slice(1).join('|'); this.login(); }
      else if (cmd === 'updateuser') {
        this.net.userName = parts[1].trim().replace(/@!$/, '');
        this.net.named = parts[2] === '1';
        if (this.net.named && this.screen === 'connecting') { this.status = ''; this.go('lobby'); }
      } else if (cmd === 'nametaken') {
        // While reconnecting, the server may still hold our name from the dead connection: retry.
        if (this.reconnect) { this.cmd('ws_close'); return; }
        this.notice = parts[2] || 'That name is taken.';
        this.askName('name');
      } else if (cmd === 'popup') {
        this.notice = parts.slice(1).join('|').replace(/\|\|/g, '\n').replace(/<[^>]*>/g, '');
        // The server is the only full legality check; a rejected rental just gets re-rolled.
        const flow = this.flow;
        if (flow && flow.team === 'rental' && /team was rejected/.test(this.notice) && (flow.retries = (flow.retries || 0) + 1) <= 3) {
          this.notice = '';
          this.flowReady();
          continue;
        }
        if (this.screen === 'challenging' || this.screen === 'searching') this.go('lobby');
      } else if (cmd === 'updatesearch') {
        const s = JSON.parse(parts.slice(1).join('|'));
        if (s.searching && s.searching.length) { this.status = ''; this.go('searching'); }
        else if (this.screen === 'searching') this.go('lobby');
      } else if (cmd === 'pm') {
        this.onPM(parts[1], parts[2], parts.slice(3).join('|'));
      }
    }
  }

  onPM(from, to, msg) {
    // The server reports some refusals as a PM from "~", e.g. its anti-spam block on
    // challenges from unregistered names on some internet providers.
    if (from.trim() === '~' || to.trim() === '~') {
      const m = msg.match(/^\/(?:error|text) (.*)/s);
      if (m) {
        this.notice = m[1].replace(/<[^>]*>/g, '');
        if (this.screen === 'challenging' || this.screen === 'searching') this.go('lobby');
      }
      return;
    }
    if (!msg.startsWith('/challenge')) return this.onChatPM(from, to, msg);
    const format = msg.slice(11).split('|')[0].trim();
    const fromId = Tracker.toID(from), meId = Tracker.toID(this.net.userName);
    if (fromId === meId) {
      if (format) { this.flow.target = to.trim(); this.go('challenging'); }
      else if (this.screen === 'challenging') { this.notice = 'The challenge ended.'; this.go('lobby'); }
      return;
    }
    if (!format) {
      if (this.screen === 'challenged') { this.net.challengedBy = null; this.notice = 'The challenge was cancelled.'; this.go('lobby'); }
      return;
    }
    const user = from.trim().replace(/^[^\w]/, '');
    if (!FORMATS.some(f => f.id === format)) {
      this.send(`|/reject ${user}`);
      this.notice = `${user} challenged you to ${format}, which the 3DS can't play yet.`;
      return;
    }
    if (this.screen === 'battle' || this.screen === 'busy') { this.send(`|/reject ${user}`); return; }
    this.net.challengedBy = {user, format};
    this.go('challenged');
  }

  onChatPM(from, to, msg) {
    const clean = n => n.trim().replace(/^[^\w]/, '').replace(/@!$/, '');
    const sender = clean(from), other = Tracker.toID(sender) === Tracker.toID(this.net.userName) ? clean(to) : sender;
    let text;
    if (msg.startsWith('//')) text = msg.slice(1);
    else if (msg.startsWith('/me ')) text = `* ${sender} ${msg.slice(4)}`;
    else if (/^\/(raw|html) /.test(msg)) text = `* ${msg.replace(/^\/\w+ /, '').replace(/<[^>]*>/g, '')}`; // server notice, not a quote
    else if (msg.startsWith('/error ')) { // e.g. "X is offline": the server answers inside the PM
      this.conversation(other).lines.push(`(${msg.slice(7)})`);
      this.notice = msg.slice(7);
      return;
    }
    else if (msg.startsWith('/')) return; // other client commands (invites, notifications)
    else text = msg;
    if (!text.startsWith('* ')) text = `${sender}: ${text}`;
    const conv = this.conversation(other);
    conv.lines.push(text);
    if (conv.lines.length > 50) conv.lines.shift();
    const reading = this.screen === 'conversation' && this.convId === Tracker.toID(other);
    if (sender !== other || reading) return; // our own echo, or already on screen
    conv.unread++;
    if (this.screen === 'battle') this.tracker.log.push(`[PM] ${text}`);
    else this.notice = `New message from ${other}`;
  }

  onBattleRoom(room, text) {
    if (text.startsWith('|init|battle')) {
      if (this.screen === 'battle' && this.room && this.room !== room) { this.send(`|/leave ${room}`); return; }
      const rejoin = !!this.reconnect && room === this.room;
      this.reconnect = null;
      this.room = room;
      this.offline = null;
      this.tracker.reset(null);
      this.resetAnims();
      this.answered = null;
      this.go('battle');
      if (rejoin) { // the server resends the whole battle: show where it is now, don't replay it
        this.tracker.feed(text);
        this.tracker.flush();
        this.skipAnims();
        return;
      }
    }
    if (room !== this.room) return;
    if (text.startsWith('|deinit')) return;
    this.tracker.feed(text);
  }

  // ---- battle ----
  battleTick() {
    const t = this.tracker;
    t.flush(); // every event goes straight into the log; no waiting or pressing A
    if (t.timerSeq !== this.timerSeq) { this.timerSeq = t.timerSeq; this.timerAt = this.now; }
    if (t.choiceError) { t.choiceError = false; this.answered = null; }
    this.playAnims(this.now);
  }

  // ---- battle animations ----
  // The log is complete right away; the top screen replays the turn one event at a time from the
  // tracker's snapshots, so HP bars drain in step with the hits.
  resetAnims() {
    this.disp = {p1: null, p2: null};
    this.playing = null;
  }

  get animating() { return !!this.playing || this.tracker.anims.length > 0; }

  playAnims(now) {
    for (;;) {
      const p = this.playing;
      if (p) {
        if (now - p.start < p.dur) return;
        if (p.ev.kind === 'faint') this.disp[p.ev.side] = null; // gone once it has sunk out of view
        this.playing = null;
      }
      const ev = this.tracker.anims.shift();
      if (!ev) return;
      const before = this.disp[ev.side];
      this.playing = {id: this.animSeq = (this.animSeq || 0) + 1, ev, start: now, dur: (ANIM_MS[ev.kind] || 0) * (this.animSpeed ?? 1), fromPct: before ? before.pct : ev.snap?.pct};
      if (ev.kind !== 'move' && ev.kind !== 'faint') this.disp[ev.side] = ev.snap;
    }
  }

  skipAnims() {
    for (const ev of [this.playing?.ev, ...this.tracker.anims].filter(Boolean)) {
      if (ev.kind === 'faint') this.disp[ev.side] = null;
      else if (ev.kind !== 'move') this.disp[ev.side] = ev.snap;
    }
    this.tracker.anims.length = 0;
    this.playing = null;
  }

  // What the top screen shows for one side right now, HP tweened during hits and heals.
  shownMon(side) {
    const d = this.disp[side], p = this.playing;
    if (!d) return null;
    if (!p || p.ev.side !== side || !p.dur || (p.ev.kind !== 'hit' && p.ev.kind !== 'heal')) return d;
    const k = Math.min(1, (this.now - p.start) / p.dur);
    return {...d, pct: Math.round(p.fromPct + (d.pct - p.fromPct) * k)};
  }

  // The effect being played, for the renderer: who it's on, how far along (0..1000), its colour.
  animFx(mySide) {
    const p = this.playing;
    if (!p || !p.dur) return null;
    return {
      id: p.id, kind: p.ev.kind, who: p.ev.side === mySide ? 'me' : 'foe',
      t: Math.min(1000, Math.round(1000 * (this.now - p.start) / p.dur)),
      color: TYPE_COLORS[p.ev.type] ?? TYPE_COLORS['???'], status: !!p.ev.status,
    };
  }

  get pendingRequest() {
    const t = this.tracker;
    if (t.busy || t.ended || this.animating || !t.request || t.request.wait || this.answered === t.request) return null;
    return t.request;
  }

  choose(choice) {
    this.answered = this.tracker.request;
    this.battleMode = null;
    if (this.offline) {
      this.thinking = true;
      this.later(() => { this.thinking = false; this.offline.choose(choice); });
    } else {
      this.send(`${this.room}|/choose ${choice}|${this.tracker.request.rqid}`);
    }
  }

  onBattleSelect(id) {
    const t = this.tracker;
    if (id === 'skip') { this.skipAnims(); return; }
    if (id === 'continue') {
      if (this.room && this.net) this.send(`|/leave ${this.room}`);
      this.room = null;
      const wasCom = !!this.offline;
      this.offline = null;
      this.go(this.net && !wasCom ? 'lobby' : 'menu');
      return;
    }
    if (id === 'forfeit') { this.battleMode = this.battleMode === 'forfeit' ? null : 'forfeit'; return; }
    if (id === 'timer') { this.send(`${this.room}|/timer on`); this.tracker.timerOn = true; return; }
    if (id === 'chat') { this.cmd('keyboard', 'chat', 'Say something in the battle', '', 150); return; }
    if (id === 'forfeit-yes') {
      this.battleMode = null;
      if (this.offline) this.later(() => this.offline.forfeit());
      else this.send(`${this.room}|/forfeit`);
      return;
    }
    if (id === 'back') { this.battleMode = null; return; }
    const req = this.pendingRequest;
    if (!req) return;
    if (id === 'tera') { this.tera = !this.tera; return; }
    if (id === 'switch') { this.battleMode = 'party'; return; }
    if (id.startsWith('move')) this.choose(`move ${id.slice(4)}${this.tera ? ' terastallize' : ''}`);
    else if (id.startsWith('mon')) this.choose(`${req.teamPreview ? 'team' : 'switch'} ${id.slice(3)}`);
    this.tera = false;
  }

  unreadText() {
    const n = Object.values(this.net?.pms || {}).reduce((a, c) => a + c.unread, 0);
    return n ? `${n} unread` : '';
  }

  chatButton() { return this.offline || !this.net ? [] : [{id: 'chat', label: 'Chat', small: true}]; }

  // Damage multiplier of a move type against a Pokemon as the screen knows it (its Tera type once
  // it has Terastallized). Abilities like Levitate aren't known in advance, so this is a hint.
  effectiveness(type, mon) {
    const defTypes = mon.tera && mon.tera !== 'Stellar' ? [mon.tera] : this.client.types?.[mon.species] || [];
    let mult = 1;
    for (const d of defTypes) mult *= [1, 2, 0.5, 0][this.client.chart?.[d]?.[type] || 0];
    return mult;
  }

  // Shown on the top screen while a party member is highlighted: item, ability, Tera, moves.
  monDetail(p) {
    const c = this.client;
    const parts = [c.items?.[p.item] || (p.item ? p.item : 'No item'), c.abilities?.[p.ability || p.baseAbility] || p.ability || ''];
    if (p.teraType) parts.push(`Tera ${p.teraType}`);
    return parts.filter(Boolean).join(' / ') + '\n' + (p.moves || []).map(m => c.moveNames?.[m] || m).join(', ');
  }

  // Team dots by the HP boxes: one per team member, 'ok' | 'status' | 'fnt', and 'unknown' for the
  // opponent's Pokemon not seen yet.
  teamDots(mons, size = mons?.length || 0) {
    if (!mons) return [];
    const dots = mons.slice(0, 6).map(m => m.fainted ? 'fnt' : m.status ? 'status' : 'ok');
    while (dots.length < Math.min(size, 6)) dots.push('unknown');
    return dots;
  }

  isStatusMove(id) {
    return this.offline ? this.offline.battle.dex.moves.get(id).category === 'Status' : this.statusMoves.has(id);
  }

  moveType(id) {
    if (this.offline) return this.offline.battle.dex.moves.get(id).type;
    if (id.startsWith('hiddenpower')) {
      const t = id.slice(11).replace(/\d+$/, '');
      return t ? t[0].toUpperCase() + t.slice(1) : 'Normal';
    }
    return this.moveTypes[id] || '???';
  }

  battleButtons() {
    const t = this.tracker;
    if (this.animating && this.battleMode !== 'forfeit') {
      return {layout: 'log', title: '', buttons: [{id: 'skip', label: 'Skip', small: true}, ...this.chatButton()]};
    }
    if (t.ended) return {layout: 'list', title: t.winner === '' ? 'Tie!' : `${t.winner} won!`, buttons: [{id: 'continue', label: 'Continue'}]};
    if (this.battleMode === 'forfeit') {
      return {layout: 'list', title: 'Forfeit this battle?', buttons: [{id: 'forfeit-yes', label: 'Yes, forfeit'}, {id: 'back', label: 'Keep playing'}]};
    }
    const req = this.pendingRequest;
    if (!req) {
      const title = this.reconnect ? 'Connection lost, reconnecting...' : t.busy ? '' : this.thinking ? 'COM is thinking...' : 'Waiting for the opponent...';
      // Timer: makes a stalling opponent move (Showdown forfeits them when it runs out).
      const timer = !this.offline && this.net && !t.timerOn ? [{id: 'timer', label: 'Timer', small: true}] : [];
      return {layout: 'log', title, buttons: [...timer, ...this.chatButton(), {id: 'forfeit', label: 'Forfeit', small: true}]};
    }
    const party = req.side.pokemon;
    // Revival Blessing: the forced "switch" picks a fainted Pokemon to bring back.
    const reviving = !!req.forceSwitch && party.some(p => p.reviving);
    if (req.teamPreview || req.forceSwitch || this.battleMode === 'party') {
      const buttons = party.map((p, i) => {
        const hp = Tracker.parseHP(p.condition);
        const species = Tracker.parseDetails(p.details).species;
        const canPick = req.teamPreview || (reviving ? hp.fainted : !p.active && !hp.fainted);
        return {
          id: `mon${i + 1}`, label: p.ident.slice(p.ident.indexOf(':') + 1).trim(),
          sub: hp.fainted ? 'Fainted' : `${hp.hp}/${hp.maxhp}${hp.status ? ' ' + hp.status.toUpperCase() : ''}${p.active && !req.teamPreview ? ' (in battle)' : ''}`,
          sprite: this.tracker.spritePath({species, shiny: / shiny/.test(p.details)}, false, true),
          enabled: canPick, pct: hp.maxhp ? Math.round(100 * hp.hp / hp.maxhp) : 0,
          detail: this.monDetail(p),
        };
      });
      if (this.battleMode === 'party' && !req.forceSwitch) buttons.push({id: 'back', label: 'Back', small: true});
      return {layout: 'party', title: req.teamPreview ? 'Choose your lead' : reviving ? 'Choose a Pokemon to revive' : req.forceSwitch ? 'Choose a Pokemon to send in' : 'Switch to...', buttons};
    }
    const act = req.active[0];
    const foe = t.sides[t.mySide === 'p2' ? 'p1' : 'p2'].active;
    const buttons = act.moves.map((m, i) => {
      const type = this.moveType(m.id);
      const hint = foe && !this.isStatusMove(m.id) ? effectHint(this.effectiveness(type, foe)) : '';
      return {id: `move${i + 1}`, label: m.move, sub: `${type}${m.maxpp ? `  ${m.pp}/${m.maxpp}` : ''}${hint ? `  ${hint}` : ''}`,
        color: TYPE_COLORS[type] ?? TYPE_COLORS['???'], enabled: !m.disabled && m.pp !== 0};
    });
    if (act.canTerastallize) buttons.push({id: 'tera', label: this.tera ? `Tera ${act.canTerastallize}: ON` : `Tera ${act.canTerastallize}`, small: true, color: this.tera ? TYPE_COLORS[act.canTerastallize] : undefined});
    buttons.push({id: 'switch', label: 'Switch', small: true, enabled: !act.trapped});
    buttons.push(...this.chatButton(), {id: 'forfeit', label: 'Forfeit', small: true});
    return {layout: 'moves', title: `What will ${t.sides[t.mySide].active?.name || 'you'} do?`, buttons};
  }

  // ---- view ----
  buildView() {
    const s = this.screen;
    const v = {screen: s, title: '', text: this.notice || '', layout: 'list', buttons: [], top: null, log: [],
      sound: this.setting('sound') === 'on'};
    const fmt = this.flow?.format;
    if (s.startsWith('tb-')) this.tbView(v);
    else if (s === 'menu') {
      v.title = 'Showdown 3DS';
      v.buttons = [
        {id: 'online', label: 'Play online'},
        {id: 'com', label: 'Play vs COM'},
        {id: 'account', label: `Account: ${this.cfg.name || '(no name)'}`, sub: this.cfg.sid ? 'Logged in' : ''},
        {id: 'teams', label: 'Teams'},
        {id: 'settings', label: 'Settings', small: true},
        {id: 'exit', label: 'Exit', small: true},
      ];
    } else if (s === 'settings') {
      v.title = 'Settings';
      v.buttons = Object.entries(SETTINGS).map(([id, opt]) =>
        ({id, label: `${opt.label}: ${opt.names[opt.values.indexOf(this.setting(id))]}`}));
      v.buttons.push({id: 'server', label: 'Server', small: true}, {id: 'clearcache', label: 'Clear caches', small: true},
        {id: 'back', label: 'Back', small: true});
      if (!v.text) v.text = `Server: ${this.cfg.server || DEFAULT_SERVER}`;
      v.textColor = 0xc8d2e8;
    } else if (s === 'account') {
      v.title = `Account: ${this.cfg.name || '(no name)'}`;
      v.buttons = [
        {id: 'changename', label: 'Change name'},
        {id: 'loginpw', label: 'Log in with password', sub: 'For registered Showdown accounts'},
      ];
      if (this.cfg.sid) v.buttons.push({id: 'logout', label: 'Log out'});
      v.buttons.push({id: 'back', label: 'Back', small: true});
      if (!v.text) v.text = this.cfg.sid ? 'Logged in: you stay logged in on this console until you log out.'
        : 'Registered accounts can chat, send private messages and challenge players.';
      v.textColor = 0xc8d2e8;
    } else if (s === 'format') {
      v.title = this.flow.mode === 'com' ? 'Battle the COM' : this.flow.action === 'challenge' ? `Challenge ${this.flow.target}` : 'Find a battle';
      v.layout = 'grid'; // seven formats: two columns
      v.buttons = FORMATS.map(f => ({id: f.id, label: f.name})).concat({id: 'back', label: 'Back', small: true});
      if (!v.text) { v.text = 'All formats are Gen 9 singles.'; v.textColor = 0xc8d2e8; }
    } else if (s === 'team') {
      const teams = this.flow.teams;
      const page = this.flow.page % Math.max(1, Math.ceil(teams.length / PAGE));
      v.title = `${fmt.name} team`;
      v.buttons = [{id: 'rental', label: 'Rental team', sub: 'A ready-made competitive team'}];
      teams.slice(page * PAGE, page * PAGE + PAGE).forEach((t, i) => v.buttons.push({id: `team-${page * PAGE + i}`, label: t.name, sub: t.format || 'any format'}));
      if (teams.length > PAGE) v.buttons.push({id: 'more', label: 'More', small: true});
      v.buttons.push({id: 'import', label: 'Import link', small: true}, {id: 'back', label: 'Back', small: true});
      if (!teams.length && !v.text) v.text = 'Import a team from a pokepast.es link, or save Showdown team exports as .txt files in /3ds/showdown3ds/teams/';
    } else if (s === 'busy') {
      v.title = this.busyText;
    } else if (s === 'connecting') {
      v.title = 'Online';
      v.text = [this.status, this.notice].filter(Boolean).join('\n');
      v.buttons = [{id: 'cancel', label: 'Cancel'}];
    } else if (s === 'lobby') {
      v.title = `Online as ${this.net?.userName || this.cfg.name}`;
      v.text = [this.status, this.notice].filter(Boolean).join('\n');
      v.buttons = [
        {id: 'search', label: 'Find a battle'},
        {id: 'challenge', label: 'Challenge a player'},
        {id: 'messages', label: 'Messages', sub: this.unreadText()},
        {id: 'back', label: 'Disconnect', small: true},
      ];
    } else if (s === 'messages') {
      v.title = 'Messages';
      const convs = Object.entries(this.net.pms).slice(-4);
      v.buttons = convs.map(([id, c]) => ({id: `conv-${id}`, label: c.name,
        sub: c.unread ? `${c.unread} new` : (c.lines[c.lines.length - 1] || '').slice(0, 34)}));
      v.buttons.push({id: 'newpm', label: 'New message', small: true}, {id: 'back', label: 'Back', small: true});
      if (!convs.length) v.text = 'No messages yet.';
    } else if (s === 'conversation') {
      const c = this.net.pms[this.convId];
      v.title = c.name;
      v.text = c.lines.slice(-9).join('\n') || 'No messages yet.';
      v.textColor = 0xffffff; // conversation text, not a warning
      v.buttons = [{id: 'reply', label: 'Reply', small: true}, {id: 'back', label: 'Back', small: true}];
    } else if (s === 'searching') {
      v.title = 'Searching for an opponent...';
      v.buttons = [{id: 'cancel', label: 'Cancel search'}];
    } else if (s === 'challenging') {
      v.title = `Waiting for ${this.flow.target}...`;
      v.buttons = [{id: 'cancel', label: 'Cancel challenge'}];
    } else if (s === 'challenged') {
      const ch = this.net.challengedBy;
      v.title = `${ch.user} wants to battle!`;
      v.text = FORMATS.find(f => f.id === ch.format).name;
      v.buttons = [{id: 'accept', label: 'Accept'}, {id: 'decline', label: 'Decline'}];
    } else if (s === 'battle') {
      const t = this.tracker;
      const foeSide = t.mySide === 'p2' ? 'p1' : 'p2';
      Object.assign(v, this.battleButtons());
      v.text = '';
      v.log = t.log.slice(-7);
      v.top = {
        me: t.mySide ? this.shownMon(t.mySide) : null,
        foe: this.shownMon(foeSide),
        fx: this.animFx(t.mySide || 'p1'),
        myTeam: this.teamDots(t.request?.side?.pokemon.map(p => Tracker.parseHP(p.condition))),
        foeTeam: this.teamDots(Object.values(t.sides[foeSide].mons), t.sides[foeSide].teamSize),
        myName: t.mySide ? t.sides[t.mySide].name : '',
        foeName: t.sides[foeSide].name,
        msg: t.msg, turn: t.turn, weather: t.weather,
        timer: t.timerLeft == null ? -1 : Math.max(0, Math.ceil(t.timerLeft - (this.now - this.timerAt) / 1000)),
        preview: t.request?.teamPreview && !t.sides[foeSide].active
          ? t.sides[foeSide].preview.map(sp => ({name: sp, sprite: t.spritePath({species: sp}, false, true)})) : [],
      };
    }
    for (const b of v.buttons) if (b.enabled === undefined) b.enabled = true;
    return v;
  }
}

if (typeof module !== 'undefined') module.exports = {App, parseTeamFile, FORMATS}; else globalThis.App = App;
