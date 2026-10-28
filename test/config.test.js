'use strict';
// config.json validation and serialization, the per-world defaults, and the scheduler's slots.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { parseConfig, serializeConfig, defaultConfig, worldRepo, effectiveSettings, ConfigError } = require('../src/config.js');
const { lastSlot, nextSlot, createScheduler } = require('../src/scheduler.js');
const { listWorlds, worldsDir, folderSize, formatSize, WorldsError } = require('../src/worlds.js');

test('an empty config gives the defaults and the file written back is minimal', () => {
  const c = parseConfig('{}');
  assert.deepEqual(c, defaultConfig());
  assert.equal(serializeConfig(c), JSON.stringify({
    schedule: { frequency: 'daily', time: '04:00', weekday: 0, everyHours: 6 },
    github: { repoPrefix: 'foundry-world-', createRepos: true },
    whenActive: 'backup',
    worlds: {},
  }, null, 2) + '\n');
  assert.equal(parseConfig('').worlds['x'], undefined);
});

test('Foundry\'s address: unset falls back to FOUNDRY_URL, "" turns the check off, a URL is kept', () => {
  assert.equal(parseConfig('{}').foundry.url, null);
  assert.equal(parseConfig('{"foundry":{}}').foundry.url, null);
  assert.equal(parseConfig('{"foundry":{"url":""}}').foundry.url, '');
  const c = parseConfig('{"foundry":{"url":" https://foundry.example:30000/game "}}');
  assert.equal(c.foundry.url, 'https://foundry.example:30000/game');
  assert.deepEqual(JSON.parse(serializeConfig(c)).foundry, { url: 'https://foundry.example:30000/game' });
  assert.deepEqual(JSON.parse(serializeConfig(parseConfig('{"foundry":{"url":""}}'))).foundry, { url: '' });
  assert.equal(JSON.parse(serializeConfig(parseConfig('{}'))).foundry, undefined, 'not written while unset');
});

test('github.releases is off by default and only written to the file when on', () => {
  assert.equal(parseConfig('{}').github.releases, false);
  const on = parseConfig('{"github":{"releases":true}}');
  assert.equal(on.github.releases, true);
  assert.deepEqual(JSON.parse(serializeConfig(on)).github, { repoPrefix: 'foundry-world-', createRepos: true, releases: true });
  assert.deepEqual(JSON.parse(serializeConfig(parseConfig('{"github":{"releases":false}}'))).github,
    { repoPrefix: 'foundry-world-', createRepos: true });
});

test('world settings fall back to the global ones field by field', () => {
  const c = parseConfig(JSON.stringify({
    schedule: { frequency: 'weekly', weekday: 6, time: '23:30' },
    github: { repoPrefix: 'fvtt-' },
    worlds: {
      alpha: { enabled: false },
      beta: { repo: 'someone/else', schedule: { frequency: 'hourly', everyHours: 2 }, whenActive: 'skip' },
      gamma: { repo: '', schedule: null, whenActive: '' },
    },
  }));
  assert.equal(worldRepo(c, 'alpha', 'me'), 'me/fvtt-alpha');
  assert.equal(worldRepo(c, 'beta', 'me'), 'someone/else');
  assert.equal(worldRepo(c, 'unknown', null), '/fvtt-unknown');
  assert.deepEqual(effectiveSettings(c, 'alpha'), { enabled: false, schedule: c.schedule, whenActive: 'backup', custom: false });
  assert.deepEqual(effectiveSettings(c, 'beta'), {
    enabled: true, schedule: { frequency: 'hourly', time: '04:00', weekday: 0, everyHours: 2 }, whenActive: 'skip', custom: true,
  });
  assert.deepEqual(effectiveSettings(c, 'gamma'), { enabled: true, schedule: c.schedule, whenActive: 'backup', custom: false });
  assert.deepEqual(effectiveSettings(c, 'new-world'), { enabled: true, schedule: c.schedule, whenActive: 'backup', custom: false });
  // round trip: only what differs from the defaults is written (gamma, all defaults, disappears without effect)
  const again = parseConfig(serializeConfig(c));
  assert.equal(JSON.parse(serializeConfig(c)).worlds.gamma, undefined);
  delete c.worlds.gamma;
  assert.deepEqual(again, c);
});

test('malformed configs are refused with a clear message', () => {
  const bad = [
    ['[]', /top level must be an object/],
    ['{"x":1}', /unknown key "x"/],
    ['{"schedule":{"frequency":"sometimes"}}', /frequency must be hourly, daily or weekly/],
    ['{"schedule":{"time":"25:00"}}', /time must be HH:MM/],
    ['{"schedule":{"weekday":7}}', /weekday must be 0/],
    ['{"schedule":{"everyHours":5}}', /everyHours must divide 24/],
    ['{"github":{"repoPrefix":"a b"}}', /repoPrefix/],
    ['{"github":{"createRepos":"yes"}}', /createRepos must be true or false/],
    ['{"github":{"releases":1}}', /releases must be true or false/],
    ['{"whenActive":"maybe"}', /whenActive must be backup or skip/],
    ['{"worlds":{"../x":{}}}', /invalid world id/],
    ['{"worlds":{"a":{"repo":"noslash"}}}', /repo must be owner\/name/],
    ['{"worlds":{"a":{"repo":"o/.."}}}', /repo must be owner\/name/],
    ['{"worlds":{"a":{"repo":"o/."}}}', /repo must be owner\/name/],
    ['{"worlds":{"a":{"enabled":1}}}', /enabled must be true or false/],
    ['{"worlds":{"a":{"other":1}}}', /unknown key "other"/],
    ['{"worlds":{"__proto__":{}}}', /invalid world id/],
    ['{"foundry":"http://x"}', /"foundry" must be an object/],
    ['{"foundry":{"host":"x"}}', /unknown key "host"/],
    ['{"foundry":{"url":30000}}', /url must be a string/],
    ['{"foundry":{"url":"localhost:30000"}}', /must start with http/],
    ['{"foundry":{"url":"not a url"}}', /not a valid address/],
    ['{"foundry":{"url":"http://user:pw@foundry:30000"}}', /user name or password/],
    ['{"foundry":{"url":"http://foundry:30000/?x=1"}}', /"\?" or "#"/],
    ['nope', /not valid JSON/],
  ];
  for (const [text, re] of bad) assert.throws(() => parseConfig(text), re, text);
  assert.throws(() => parseConfig('{"x":1}'), ConfigError);
});

test('scheduler slots: daily, weekly and every N hours, in local time', () => {
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);
  const daily = { frequency: 'daily', time: '04:00', weekday: 0, everyHours: 6 };
  assert.deepEqual(lastSlot(daily, at(2026, 10, 14, 10, 0)), at(2026, 10, 14, 4, 0));
  assert.deepEqual(lastSlot(daily, at(2026, 10, 14, 3, 59)), at(2026, 10, 13, 4, 0));
  assert.deepEqual(nextSlot(daily, at(2026, 10, 14, 3, 59)), at(2026, 10, 14, 4, 0));
  assert.deepEqual(nextSlot(daily, at(2026, 10, 14, 4, 0)), at(2026, 10, 15, 4, 0));
  // 14 Oct 2026 is a Wednesday (3)
  const weekly = { frequency: 'weekly', time: '22:15', weekday: 1, everyHours: 6 };
  assert.deepEqual(lastSlot(weekly, at(2026, 10, 14, 10, 0)), at(2026, 10, 12, 22, 15));
  assert.deepEqual(nextSlot(weekly, at(2026, 10, 14, 10, 0)), at(2026, 10, 19, 22, 15));
  assert.deepEqual(lastSlot(weekly, at(2026, 10, 12, 22, 14)), at(2026, 10, 5, 22, 15));
  assert.deepEqual(nextSlot(weekly, at(2026, 10, 12, 22, 14)), at(2026, 10, 12, 22, 15));
  const hourly = { frequency: 'hourly', time: '04:00', weekday: 0, everyHours: 6 };
  assert.deepEqual(lastSlot(hourly, at(2026, 10, 14, 10, 0)), at(2026, 10, 14, 6, 0));
  assert.deepEqual(lastSlot(hourly, at(2026, 10, 14, 0, 30)), at(2026, 10, 14, 0, 0));
  assert.deepEqual(nextSlot(hourly, at(2026, 10, 14, 10, 0)), at(2026, 10, 14, 12, 0));
  assert.deepEqual(nextSlot(hourly, at(2026, 10, 14, 23, 0)), at(2026, 10, 15, 0, 0));
  const every24 = { ...hourly, everyHours: 24 };
  assert.deepEqual(lastSlot(every24, at(2026, 10, 14, 23, 0)), at(2026, 10, 14, 0, 0));
  assert.deepEqual(nextSlot(every24, at(2026, 10, 14, 23, 0)), at(2026, 10, 15, 0, 0));
});

test('the scheduler queues enabled, readable worlds whose latest slot has not run, once', () => {
  const config = parseConfig('{"worlds":{"off":{"enabled":false},"custom":{"schedule":{"frequency":"hourly","everyHours":1}}}}');
  const statuses = { done: { lastScheduled: '2099-01-01T00:00:00.000Z' } };
  const queued = [];
  const backups = {
    worlds: () => ['alpha', 'off', 'custom', 'done', 'broken'].map((id) => ({ id, readable: id !== 'broken' })),
    statusOf: (id) => statuses[id] || {},
    enqueue: (id, opts) => {
      if (queued.some((q) => q.id === id)) return { queued: false, reason: 'already' };
      queued.push({ id, opts });
      return { queued: true };
    },
  };
  const logs = [];
  const clock = new Date(2026, 9, 14, 10, 30);
  const s = createScheduler({ backups, getConfig: () => config, now: () => clock, log: (l) => logs.push(l) });
  assert.deepEqual(s.check(), ['alpha', 'custom']);
  assert.equal(queued[0].opts.scheduled, new Date(2026, 9, 14, 4, 0).toISOString());
  assert.equal(queued[1].opts.scheduled, new Date(2026, 9, 14, 10, 0).toISOString());
  assert.match(queued[0].opts.reason, /scheduled run/);
  // the same slot is not queued twice; once it ran, nothing is due until the next slot
  assert.deepEqual(s.check(), []);
  statuses.alpha = { lastScheduled: queued[0].opts.scheduled };
  statuses.custom = { lastScheduled: queued[1].opts.scheduled };
  queued.length = 0;
  assert.deepEqual(s.check(), []);
  assert.equal(s.nextRun('alpha'), new Date(2026, 9, 15, 4, 0).toISOString());
  assert.equal(s.nextRun('custom'), new Date(2026, 9, 14, 11, 0).toISOString());
  // a listing failure is logged, not thrown
  backups.worlds = () => { throw new Error('no data folder'); };
  assert.deepEqual(s.check(), []);
  assert.match(logs.at(-1), /cannot list the worlds \(no data folder\)/);
});

test('worlds are found under Data/worlds, whichever folder FOUNDRY_DATA names, with their world.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-worlds-'));
  const worlds = path.join(dir, 'Data', 'worlds');
  fs.mkdirSync(path.join(worlds, 'alpha', 'packs'), { recursive: true });
  fs.mkdirSync(path.join(worlds, 'not-a-world'), { recursive: true });
  fs.mkdirSync(path.join(worlds, 'bad json'), { recursive: true });
  fs.mkdirSync(path.join(worlds, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(worlds, 'alpha', 'world.json'), JSON.stringify({ title: 'Alpha', system: 'dnd5e', compatibility: { verified: '13.348' } }));
  fs.writeFileSync(path.join(worlds, 'alpha', 'packs', 'a.ldb'), Buffer.alloc(1500));
  fs.writeFileSync(path.join(worlds, 'alpha', 'x.txt'), 'hello');
  fs.writeFileSync(path.join(worlds, 'broken', 'world.json'), 'not json');
  fs.writeFileSync(path.join(worlds, 'bad json', 'world.json'), '{}');
  for (const given of [dir, path.join(dir, 'Data'), worlds]) {
    assert.equal(worldsDir(given), worlds);
    const list = listWorlds(given);
    assert.deepEqual(list.map((w) => w.id), ['alpha', 'broken']);
    assert.equal(list[0].title, 'Alpha');
    assert.equal(list[0].system, 'dnd5e');
    assert.equal(list[0].coreVersion, '13.348');
    assert.equal(list[1].title, 'broken');
    assert.equal(list[0].readable, true);
  }
  assert.throws(() => worldsDir(path.join(dir, 'Data', 'nothing')), WorldsError);
  assert.equal(await folderSize(path.join(worlds, 'alpha')), 1505 + JSON.stringify({ title: 'Alpha', system: 'dnd5e', compatibility: { verified: '13.348' } }).length);
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(1505), '1.5 kB');
  assert.equal(formatSize(348 * 1000 * 1000), '348 MB');
  assert.equal(formatSize(1.2e9), '1.2 GB');
});
