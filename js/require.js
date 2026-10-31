// Minimal CommonJS loader so Showdown's compiled sim (dist/) runs in QuickJS.
// The host provides __readFile(path) -> string|null and __ROOT (folder holding dist files).
(function () {
  const ROOT = globalThis.__ROOT;
  const cache = Object.create(null);

  function norm(p) {
    const out = [];
    for (const s of p.split('/')) {
      if (!s || s === '.') continue;
      if (s === '..') out.pop(); else out.push(s);
    }
    return '/' + out.join('/');
  }
  const dirname = p => p.slice(0, p.lastIndexOf('/')) || '/';
  const path = {
    sep: '/',
    resolve: (...parts) => {
      let p = '';
      for (const part of parts) p = part.startsWith('/') ? part : p + '/' + part;
      return norm(p);
    },
    join: (...parts) => norm(parts.join('/')),
    dirname,
    basename: (p, ext) => {
      let b = p.slice(p.lastIndexOf('/') + 1);
      if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
      return b;
    },
    extname: p => { const b = p.slice(p.lastIndexOf('/') + 1); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
  };
  const notAvailable = name => new Proxy({}, {
    get: (_, k) => k === '__esModule' ? false : () => { throw new Error(`${name}.${String(k)} is not available on 3DS`); },
  });
  const builtins = {
    path,
    fs: {existsSync: () => false, readdirSync: () => [], readFileSync: () => { throw new Error('no fs'); }},
    'node:util': {inspect: v => String(v)},
    // Only used for battle seeds, so Math.random is good enough.
    crypto: {getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = Math.random() * 0x100000000; return a; }},
  };
  for (const n of ['child_process', 'cluster', 'http', 'https', 'net', 'repl', 'os']) builtins[n] = notAvailable(n);
  // Packages from node_modules the sim pulls in.
  const packages = {'ts-chacha20': '/node_modules/ts-chacha20/build/src/chacha20.js'};

  function notFound(id) {
    const e = new Error(`Cannot find module '${id}'`);
    e.code = 'MODULE_NOT_FOUND';
    return e;
  }

  function load(id) {
    for (const f of [id, id + '.js', id + '.json', id + '/index.js']) {
      if (cache[f]) return cache[f].exports;
      let fn = null, json = null;
      if (f.endsWith('.json')) {
        json = __readFile(ROOT + f);
        if (json == null) continue;
      } else if (globalThis.__loadModule) { // the console: compiled once, then cached as bytecode
        fn = __loadModule(ROOT + f);
        if (!fn) continue;
      } else {
        const src = __readFile(ROOT + f);
        if (src == null) continue;
        fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src + '\n//# sourceURL=' + f);
      }
      const module = cache[f] = {exports: {}};
      if (json != null) module.exports = JSON.parse(json);
      else fn(module.exports, makeRequire(dirname(f)), module, f, dirname(f));
      return module.exports;
    }
    throw notFound(id);
  }

  function makeRequire(dir) {
    return function require(id) {
      if (id.startsWith('node:') && builtins[id] === undefined) id = id.slice(5);
      if (builtins[id]) return builtins[id];
      if (packages[id]) return load(packages[id]);
      if (id.startsWith('/')) return load(norm(id));
      if (id.startsWith('.')) return load(norm(dir + '/' + id));
      throw notFound(id);
    };
  }

  globalThis.require = makeRequire('/');
  globalThis.global = globalThis;
  // Kept when it already exists so the same loader runs under node for tests.
  globalThis.process ||= {
    env: {}, argv: [], platform: '3ds', version: 'v22.0.0', versions: {node: '22.0.0'},
    cwd: () => '/', on() {}, exit() {}, uptime: () => 0,
    nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)),
    hrtime: Object.assign(() => [0, 0], {bigint: () => 0n}),
    memoryUsage: () => ({}),
  };
  if (!globalThis.setImmediate) globalThis.setImmediate = (f, ...a) => Promise.resolve().then(() => f(...a));
})();
