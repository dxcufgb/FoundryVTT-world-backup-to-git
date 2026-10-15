'use strict';
// The admin port: HTTPS with a self-signed certificate, plain HTTP redirected to https, only the admin page served,
// LAN names accepted, reverse-proxy headers trusted only when asked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { createApp } = require('../src/server.js');
const { hashPassword, parseAdminSettings, serializeAdminSettings, defaultNotify } = require('../src/admin.js');
const { parseConfig } = require('../src/config.js');
const { createSelfSigned, defaultNames, trustAnchor, outdated } = require('../src/selfsigned.js');

const PASSWORD = 'correct horse battery';

let hash;
let certs;

// Starts the admin listener; tls undefined = plain HTTP admin port.
async function start({ tls, trustProxy = false, hosts = [] } = {}) {
  hash = hash || (await hashPassword(PASSWORD));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-adminweb-'));
  const configFile = path.join(dir, 'config.json');
  const adminFile = path.join(dir, 'admin.json');
  fs.mkdirSync(path.join(dir, 'foundry', 'Data', 'worlds', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'foundry', 'Data', 'worlds', 'alpha', 'world.json'), '{"title":"Alpha"}');
  fs.writeFileSync(configFile, '{}');
  fs.writeFileSync(adminFile, serializeAdminSettings({ passwordHash: hash, notify: defaultNotify() }));
  const logs = [];
  const app = createApp({
    config: parseConfig('{}'),
    token: 'tok',
    configFile,
    dataDir: path.join(dir, 'foundry'),
    stateDir: dir,
    admin: { file: adminFile, settings: parseAdminSettings(fs.readFileSync(adminFile, 'utf8')), hosts, trustProxy },
    fetchImpl: async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    },
    log: (l) => logs.push(l),
  });
  const adminServer = app.createAdminServer(tls);
  await new Promise((r) => adminServer.listen(0, '127.0.0.1', r));
  return {
    port: adminServer.address().port,
    logs,
    close: async () => {
      await new Promise((r) => adminServer.close(r));
    },
  };
}

// One request over http or https (certificate pinned to ours); returns { status, headers, body }.
function request(scheme, port, pathname, { method = 'GET', headers = {}, body, ca } = {}) {
  return new Promise((resolve, reject) => {
    const mod = scheme === 'https' ? https : http;
    const req = mod.request(
      { host: '127.0.0.1', port, path: pathname, method, headers, ca, servername: 'localhost' },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Logs in with the test password (or opts.password); opts.headers/ca are passed through to request().
const login = (scheme, port, opts = {}) =>
  request(scheme, port, '/_admin/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: 'localhost', ...(opts.headers || {}) },
    body: JSON.stringify({ password: opts.password || PASSWORD }),
    ca: opts.ca,
  });

test('the self-signed certificate is valid X.509 for the given names, signed by its own authority', () => {
  const { cert, key, ca } = createSelfSigned(['localhost', '127.0.0.1', '::1', 'pi.local']);
  const x = new crypto.X509Certificate(cert); // the first of the chain: the page's certificate
  const root = new crypto.X509Certificate(ca);
  assert.equal(x.ca, false);
  assert.equal(x.verify(root.publicKey), true);
  assert.equal(x.checkIssued(root), true);
  assert.equal(root.ca, true);
  assert.equal(root.verify(root.publicKey), true);
  assert.match(root.subject, /CN=Foundry World Backup on pi\.local \(\d{4}-\d\d-\d\d\)/);
  assert.ok(cert.endsWith(ca));
  assert.equal(x.checkPrivateKey(crypto.createPrivateKey(key)), true);
  assert.equal(root.checkPrivateKey(crypto.createPrivateKey(key)), false);
  assert.equal(x.checkHost('pi.local'), 'pi.local');
  assert.equal(x.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(x.checkIP('::1'), '::1');
  assert.ok(new Date(x.validTo) > new Date(Date.now() + 365 * 24 * 3600 * 1000));
  const names = defaultNames(['admin.example.com']);
  assert.ok(names.includes('localhost') && names.includes('admin.example.com') && names.includes(os.hostname().toLowerCase()));
  // the authority to trust: only from such a chain, never a lone or a foreign certificate
  assert.equal(trustAnchor(cert), ca);
  assert.equal(trustAnchor(ca), null);
  assert.equal(trustAnchor(cert.slice(0, cert.length - ca.length)), null);
  assert.equal(trustAnchor(cert.slice(0, cert.length - ca.length) + createSelfSigned(['localhost']).ca), null);
  assert.equal(trustAnchor('nonsense'), null);
  assert.equal(outdated(cert), false);
});

test('a lone self-signed certificate of an older version is outdated (the installers renew it)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-cert-'));
  const file = path.join(dir, 'admin-tls.crt');
  // the old format, as test/fixtures/old-admin-tls.crt (made by version 0.2.3): one self-signed, non-CA certificate
  const old = fs.readFileSync(path.join(__dirname, 'fixtures', 'old-admin-tls.crt'), 'utf8');
  assert.equal(outdated(old), true);
  // the same, but someone else's (not the installer's own): left alone
  assert.equal(outdated(fs.readFileSync(path.join(__dirname, 'fixtures', 'other-self-signed.crt'), 'utf8')), false);
  const run = (f) => require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, '..', 'src', 'selfsigned.js'), '--outdated', f]).status;
  fs.writeFileSync(file, old);
  assert.equal(run(file), 0);
  fs.writeFileSync(file, createSelfSigned(['localhost']).cert);
  assert.equal(run(file), 1);
  assert.equal(run(path.join(dir, 'missing.crt')), 1);
});

test('the admin port serves the admin page over HTTPS and nothing else', async () => {
  certs = certs || createSelfSigned(['localhost', '127.0.0.1']);
  const s = await start({ tls: certs });
  try {
    const ca = certs.ca;
    let res = await request('https', s.port, '/', { headers: { Host: 'localhost' }, ca });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/_admin/');
    res = await request('https', s.port, '/_admin/', { headers: { Host: 'localhost' }, ca });
    assert.equal(res.status, 200);
    assert.match(res.body, /Foundry World Backup/);
    // nothing else is served
    res = await request('https', s.port, '/alpha/world.json', { headers: { Host: 'localhost' }, ca });
    assert.equal(res.status, 404);
    // HTTPS login: the session cookie is Secure
    res = await login('https', s.port, { ca });
    assert.equal(res.status, 200);
    assert.match(res.headers['set-cookie'][0], /; Secure/);
    // a plain-HTTP request on the same port is sent to https://
    res = await request('http', s.port, '/anything', { headers: { Host: 'pi.local:8484' } });
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, 'https://pi.local:8484/_admin/');
  } finally {
    await s.close();
  }
});

test('the certificate\'s own authority is offered for download (Chrome saves passwords only on a trusted page)', async () => {
  certs = certs || createSelfSigned(['localhost', '127.0.0.1']);
  const s = await start({ tls: certs });
  try {
    const ca = certs.ca;
    let res = await request('https', s.port, '/_admin/certificate.crt', { headers: { Host: 'localhost' }, ca });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/x-x509-ca-cert');
    assert.match(res.headers['content-disposition'], /^attachment; filename="foundry-world-backup\.crt"$/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body, certs.ca);
    assert.doesNotMatch(res.body, /PRIVATE KEY/);
    res = await request('https', s.port, '/_admin/certificate.crt', { method: 'HEAD', headers: { Host: 'localhost' }, ca });
    assert.equal(res.status, 200);
    res = await request('https', s.port, '/_admin/certificate.crt', { method: 'POST', headers: { Host: 'localhost' }, ca });
    assert.equal(res.status, 405);
    res = await request('https', s.port, '/_admin/certificate.crt', { headers: { Host: 'evil.example' }, ca });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
  // a lone certificate (an older self-signed one, or a real one without its chain): nothing to download
  const lone = createSelfSigned(['localhost']);
  const leafOnly = await start({ tls: { cert: lone.cert.slice(0, lone.cert.length - lone.ca.length), key: lone.key } });
  try {
    const res = await request('https', leafOnly.port, '/_admin/certificate.crt', { headers: { Host: 'localhost' }, ca: lone.ca });
    assert.equal(res.status, 404);
  } finally {
    await leafOnly.close();
  }
  // no certificate (plain HTTP behind a reverse proxy): nothing to download
  const plain = await start();
  try {
    const res = await request('http', plain.port, '/_admin/certificate.crt', { headers: { Host: 'localhost' } });
    assert.equal(res.status, 404);
  } finally {
    await plain.close();
  }
});

test('the admin port accepts this machine\'s own names and addresses, not foreign ones', async () => {
  certs = certs || createSelfSigned(['localhost', '127.0.0.1']);
  const s = await start({ tls: certs });
  try {
    const ca = certs.ca;
    const status = async (host) => (await request('https', s.port, '/_admin/', { headers: { Host: host }, ca })).status;
    assert.equal(await status(`${os.hostname().toLowerCase()}:8484`), 200);
    const ipv4 = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4');
    if (ipv4) assert.equal(await status(`${ipv4.address}:8484`), 200);
    assert.equal(await status('evil.example'), 403);
  } finally {
    await s.close();
  }
});

test('behind a trusted reverse proxy: X-Forwarded-Proto makes the cookie Secure, X-Forwarded-For is the client', async () => {
  const s = await start({ trustProxy: true, hosts: ['admin.example.com'] });
  try {
    const fwd = { Host: 'admin.example.com', 'X-Forwarded-Proto': 'https' };
    let res = await request('http', s.port, '/_admin/', { headers: fwd });
    assert.equal(res.status, 200);
    res = await login('http', s.port, { headers: fwd });
    assert.match(res.headers['set-cookie'][0], /; Secure/);
    // lockout follows the forwarded client address, not the proxy's
    for (let i = 0; i < 5; i++) {
      await login('http', s.port, { password: 'wrong wrong', headers: { ...fwd, 'X-Forwarded-For': '203.0.113.7' } });
    }
    res = await login('http', s.port, { headers: { ...fwd, 'X-Forwarded-For': '203.0.113.7' } });
    assert.equal(res.status, 429);
    res = await login('http', s.port, { headers: { ...fwd, 'X-Forwarded-For': '198.51.100.9' } });
    assert.equal(res.status, 200);
    assert.ok(s.logs.some((l) => l === 'admin: failed login from 203.0.113.7'));
  } finally {
    await s.close();
  }
});

test('without ADMIN_TRUST_PROXY forwarded headers are ignored', async () => {
  const s = await start({ hosts: ['admin.example.com'] });
  try {
    const res = await login('http', s.port, {
      headers: { Host: 'admin.example.com', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7' },
    });
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.headers['set-cookie'][0], /Secure/);
  } finally {
    await s.close();
  }
});

test('forwarded headers count only from the listed proxy addresses', async () => {
  // the test client connects from 127.0.0.1, which is not the listed proxy
  const s = await start({ trustProxy: ['192.0.2.9'], hosts: ['admin.example.com'] });
  try {
    const fwd = { Host: 'admin.example.com', 'X-Forwarded-Proto': 'https' };
    const res = await login('http', s.port, { headers: fwd });
    assert.doesNotMatch(res.headers['set-cookie'][0], /Secure/);
    for (let i = 0; i < 5; i++) {
      await login('http', s.port, { password: 'wrong wrong', headers: { ...fwd, 'X-Forwarded-For': `203.0.113.${i}` } });
    }
    // a faked X-Forwarded-For per attempt does not dodge the per-address lockout
    assert.equal((await login('http', s.port, { headers: { ...fwd, 'X-Forwarded-For': '198.51.100.1' } })).status, 429);
  } finally {
    await s.close();
  }
  // a listed address (here the loopback the test connects from) is trusted
  const t = await start({ trustProxy: ['127.0.0.1'], hosts: ['admin.example.com'] });
  try {
    const res = await login('http', t.port, { headers: { Host: 'admin.example.com', 'X-Forwarded-Proto': 'https' } });
    assert.match(res.headers['set-cookie'][0], /; Secure/);
  } finally {
    await t.close();
  }
});

test('too many failed logins from many addresses pause all logins', async () => {
  const s = await start({ trustProxy: true });
  try {
    for (let i = 0; i < 50; i++) {
      await login('http', s.port, { password: 'wrong wrong', headers: { 'X-Forwarded-For': `203.0.113.${i}` } });
    }
    const res = await login('http', s.port, { headers: { 'X-Forwarded-For': '198.51.100.1' } });
    assert.equal(res.status, 429);
  } finally {
    await s.close();
  }
});
