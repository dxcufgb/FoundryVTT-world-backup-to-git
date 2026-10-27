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
const { createSelfSigned, defaultNames } = require('../src/selfsigned.js');

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
function request(scheme, port, pathname, { method = 'GET', headers = {}, body, ca, rejectUnauthorized } = {}) {
  return new Promise((resolve, reject) => {
    const mod = scheme === 'https' ? https : http;
    const req = mod.request(
      { host: '127.0.0.1', port, path: pathname, method, headers, ca, rejectUnauthorized, servername: 'localhost' },
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

test('the self-signed certificate is valid X.509 for the given names and matches its key', () => {
  const { cert, key } = createSelfSigned(['localhost', '127.0.0.1', '::1', 'pi.local']);
  const x = new crypto.X509Certificate(cert);
  assert.equal(x.verify(x.publicKey), true);
  assert.equal(x.checkPrivateKey(crypto.createPrivateKey(key)), true);
  assert.equal(x.checkHost('pi.local'), 'pi.local');
  assert.equal(x.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(x.checkIP('::1'), '::1');
  assert.ok(new Date(x.validTo) > new Date(Date.now() + 365 * 24 * 3600 * 1000));
  const names = defaultNames(['admin.example.com']);
  assert.ok(names.includes('localhost') && names.includes('admin.example.com') && names.includes(os.hostname().toLowerCase()));
});

test('the admin port serves the admin page over HTTPS and nothing else', async () => {
  certs = certs || createSelfSigned(['localhost', '127.0.0.1']);
  const s = await start({ tls: certs });
  try {
    const ca = certs.cert;
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

test('the admin port offers its self-signed certificate (never the key) so browsers can be told to trust it', async () => {
  certs = certs || createSelfSigned(['localhost', '127.0.0.1']);
  const s = await start({ tls: certs });
  try {
    const ca = certs.cert;
    let res = await request('https', s.port, '/_admin/certificate.crt', { headers: { Host: 'localhost' }, ca });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/x-x509-ca-cert');
    assert.match(res.headers['content-disposition'], /attachment; filename="foundry-world-backup.crt"/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(new crypto.X509Certificate(res.body).fingerprint256, new crypto.X509Certificate(certs.cert).fingerprint256);
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
});

test('a certificate that is not self-signed (a real CA\'s) is not offered for download', async () => {
  const own = createSelfSigned(['localhost', '127.0.0.1']);
  // same names, but the signature no longer matches its own key: as for a certificate signed by someone else
  const der = Buffer.from(own.cert.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  der[der.length - 1] ^= 0x01;
  const b64 = der.toString('base64').replace(/.{1,64}/g, '$&\n');
  const cert = `-----BEGIN CERTIFICATE-----\n${b64}-----END CERTIFICATE-----\n`;
  const s = await start({ tls: { cert, key: own.key } });
  try {
    const res = await request('https', s.port, '/_admin/certificate.crt', {
      headers: { Host: 'localhost' },
      rejectUnauthorized: false,
    });
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

test('a plain-HTTP admin port (behind a reverse proxy) offers no certificate', async () => {
  const s = await start({});
  try {
    const res = await request('http', s.port, '/_admin/certificate.crt', { headers: { Host: 'localhost' } });
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

test('the admin port accepts this machine\'s own names and addresses, not foreign ones', async () => {
  certs = certs || createSelfSigned(['localhost', '127.0.0.1']);
  const s = await start({ tls: certs });
  try {
    const ca = certs.cert;
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
    // during the flood a wrong password is refused ...
    assert.equal((await login('http', s.port, { password: 'wrong wrong', headers: { 'X-Forwarded-For': '198.51.100.1' } })).status, 429);
    // ... but the right one still gets in: other addresses' failures cannot lock the administrator out
    assert.equal((await login('http', s.port, { headers: { 'X-Forwarded-For': '198.51.100.2' } })).status, 200);
  } finally {
    await s.close();
  }
});
