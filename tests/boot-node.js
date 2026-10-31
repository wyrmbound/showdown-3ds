// Loads the app's scripts into this node process the same way the 3DS does (global scripts),
// with host functions backed by a temporary SD folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const slash = p => p.split(path.sep).join('/');

module.exports = function boot() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sd3ds-'));
  fs.mkdirSync(path.join(data, 'teams'));
  fs.copyFileSync(path.join(__dirname, 'fixtures/teams.txt'), path.join(data, 'teams/teams.txt'));
  Object.assign(globalThis, {
    __ROOT: slash(path.join(root, 'romfs/ps')),
    __DATA: slash(data),
    __CLIENT_DATA: path.join(root, 'romfs/data/client.json'),
    __readFile: p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    __writeFile: (p, t) => fs.writeFileSync(p, t),
    __listDir: p => { try { return fs.readdirSync(p); } catch { return null; } },
    __removeFile: p => { try { fs.rmSync(p); return true; } catch { return false; } },
  });
  for (const f of ['js/require.js', 'js/tracker.js', 'js/ai.js', 'js/app.js', 'js/teambuilder.js', 'tests/drive.js']) {
    vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), {filename: f});
  }
  return () => fs.rmSync(data, {recursive: true, force: true});
};
