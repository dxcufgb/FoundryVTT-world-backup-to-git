'use strict';
// Self-signed TLS certificate for the browser-facing admin page (like Webmin's): ECDSA P-256 keys and X.509 v3
// certificates built with node:crypto only (no openssl needed, the same on Linux and Windows). Browsers warn about it
// until it is trusted; for a public address use a real certificate (ADMIN_TLS_CERT / ADMIN_TLS_KEY) or a reverse proxy.
//
// It is a pair: a certificate authority of its own, made for this one certificate, signs the page's certificate and
// its private key is thrown away at once (never written, so it can sign nothing else). Browsers accept a page's
// certificate only from a trusted authority (Chrome refuses a lone self-signed one imported as trusted), and Chrome
// saves and fills passwords only on a page whose certificate it trusts; the admin page offers the authority for
// download (/_admin/certificate.crt) so it can be added to a computer's trusted certificates.
//
//   node src/selfsigned.js CERT_FILE KEY_FILE [NAME_OR_IP ...]
//
// writes the page's certificate followed by the authority's to CERT_FILE and the page's key to KEY_FILE (mode 600),
// for this machine's host name, host name.local, localhost, every local IP address and the extra names given.
//
//   node src/selfsigned.js --outdated CERT_FILE
//
// exit 0 when CERT_FILE is a lone self-signed certificate made by an older version (it cannot be trusted that way;
// the installers make a new one), 1 when not.
//
//   node src/selfsigned.js --fingerprint CERT_FILE
//
// prints the SHA-256 fingerprint of the authority to trust (the first certificate's when there is none). No dependencies: built-in crypto, fs and os only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');

const VALID_DAYS = 3650;
const ORGANIZATION = 'Foundry World Backup';
// The organization names in the certificates of older versions (--outdated); the first ones were made with the
// proxy's name.
const LEGACY_ORGANIZATIONS = ['Foundry World Backup', 'Foundry Release Proxy'];
const OID = {
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

// ---- minimal DER encoder --------------------------------------------------------------------------------------------

// A single DER tag-length-value: tag byte, length (short or long form) and the content.
function tlv(tag, content) {
  const len = content.length;
  let head;
  if (len < 0x80) head = Buffer.from([tag, len]);
  else {
    const bytes = [];
    for (let n = len; n > 0; n >>= 8) bytes.unshift(n & 0xff);
    head = Buffer.from([tag, 0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([head, content]);
}
// DER constructors for the ASN.1 types this certificate needs (SEQUENCE, SET, OCTET STRING, BIT STRING, BOOLEAN,
// UTF8String, and a context-specific [n] EXPLICIT tag).
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const octets = (buf) => tlv(0x04, buf);
const bits = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, inner) => tlv(0xa0 + n, inner);

// DER INTEGER: strips redundant leading 0x00 bytes, then adds one back if the high bit would flip the sign.
function integer(buf) {
  let b = buf;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

// DER OBJECT IDENTIFIER from its dotted string form.
function oid(text) {
  const parts = text.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    for (let n = p >> 7; n > 0; n >>= 7) chunk.unshift(0x80 | (n & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

// UTCTime up to 2049, GeneralizedTime after (RFC 5280 4.1.2.5).
function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

// Raw address bytes for a subjectAltName iPAddress entry (4 bytes for IPv4, 16 for IPv6).
function ipBytes(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  // IPv6: expand "::" and write 8 groups of 16 bits
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const buf = Buffer.alloc(16);
  groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g, 16), i * 2));
  return buf;
}

// ---- certificate ----------------------------------------------------------------------------------------------------

/** Names for the certificate: host name, host name.local, localhost, local IPs and extras (zone ids dropped). */
function defaultNames(extra = []) {
  const names = new Set(['localhost', '127.0.0.1', '::1']);
  const host = os.hostname().toLowerCase();
  if (/^[a-z0-9.-]+$/.test(host)) {
    names.add(host);
    if (!host.includes('.')) names.add(`${host}.local`);
  }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) names.add(a.address.replace(/%.*$/, ''));
  }
  for (const e of extra) if (e) names.add(String(e).trim().toLowerCase().replace(/^\[|\]$/g, ''));
  return [...names];
}

// One signed X.509 v3 certificate as DER.
function certificate({ subject, issuer, publicKey, signingKey, notBefore, notAfter, extensions }) {
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const algorithm = seq(oid(OID.ecdsaWithSHA256));
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    issuer,
    seq(time(notBefore), time(notAfter)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions)),
  );
  return seq(tbs, algorithm, bits(crypto.sign('sha256', tbs, signingKey)));
}

const pem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`;
const name = (cn) => seq(set(seq(oid(OID.organization), utf8(ORGANIZATION))), set(seq(oid(OID.commonName), utf8(cn))));
const keyId = (publicKey) => crypto.createHash('sha1').update(publicKey.export({ type: 'spki', format: 'der' })).digest();

/**
 * Returns { cert, key, ca } as PEM text for the given DNS names / IP addresses: cert is the page's certificate
 * followed by the authority's (the chain the server sends), key the page's private key, ca the authority alone.
 */
function createSelfSigned(names, { days = VALID_DAYS, now = new Date() } = {}) {
  const authority = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const page = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cn = names.find((n) => !net.isIP(n) && n !== 'localhost') || 'localhost';
  const alt = [];
  for (const n of names) {
    if (net.isIP(n)) alt.push(tlv(0x87, ipBytes(n)));
    else if (/^[A-Za-z0-9.-]+$/.test(n)) alt.push(tlv(0x82, Buffer.from(n, 'ascii')));
  }
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(now.getTime() + days * 24 * 3600 * 1000);
  // the authority's name says where it belongs and when it was made, so it can be told apart in a certificate store
  const caName = name(`${ORGANIZATION} on ${cn} (${now.toISOString().slice(0, 10)})`.slice(0, 64));
  const caId = keyId(authority.publicKey);
  const caDer = certificate({
    subject: caName,
    issuer: caName,
    publicKey: authority.publicKey,
    signingKey: authority.privateKey,
    notBefore,
    notAfter,
    extensions: [
      // CA, no further authorities below it
      seq(oid(OID.basicConstraints), bool(true), octets(seq(bool(true), integer(Buffer.from([0]))))),
      // keyCertSign, cRLSign
      seq(oid(OID.keyUsage), bool(true), octets(tlv(0x03, Buffer.from([0x01, 0x06])))),
      seq(oid(OID.subjectKeyIdentifier), octets(octets(caId))),
    ],
  });
  const pageDer = certificate({
    subject: name(cn),
    issuer: caName,
    publicKey: page.publicKey,
    signingKey: authority.privateKey,
    notBefore,
    notAfter,
    extensions: [
      seq(oid(OID.basicConstraints), bool(true), octets(seq())),
      // digitalSignature
      seq(oid(OID.keyUsage), bool(true), octets(tlv(0x03, Buffer.from([0x07, 0x80])))),
      seq(oid(OID.extKeyUsage), octets(seq(oid(OID.serverAuth)))),
      seq(oid(OID.subjectAltName), octets(seq(...alt))),
      seq(oid(OID.subjectKeyIdentifier), octets(octets(keyId(page.publicKey)))),
      seq(oid(OID.authorityKeyIdentifier), octets(seq(tlv(0x80, caId)))),
    ],
  });
  return {
    cert: pem(pageDer) + pem(caDer),
    key: page.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    ca: pem(caDer),
  };
}

/** Every certificate in PEM text, as crypto.X509Certificate objects (unreadable ones left out). */
function parseCertificates(text) {
  const out = [];
  for (const block of String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []) {
    try {
      out.push(new crypto.X509Certificate(block));
    } catch {
      // not a certificate
    }
  }
  return out;
}

const selfSigned = (x) => x.subject === x.issuer && x.verify(x.publicKey);

/**
 * The certificate authority to trust for a certificate chain (PEM), as PEM: the last certificate when it is a
 * self-signed authority that signed the one before it; null for anything else (a real certificate, whose root
 * browsers already have, or a lone self-signed one).
 */
function trustAnchor(text) {
  const chain = parseCertificates(text);
  if (chain.length < 2) return null;
  const root = chain[chain.length - 1];
  if (!root.ca || !selfSigned(root) || !chain[chain.length - 2].verify(root.publicKey)) return null;
  return root.toString();
}

/** True for a lone self-signed certificate of an older version (it cannot be trusted as an authority). */
function outdated(text) {
  const chain = parseCertificates(text);
  if (chain.length !== 1 || chain[0].ca || !selfSigned(chain[0])) return false;
  const org = /^O=(.*)$/m.exec(chain[0].subject);
  return Boolean(org) && LEGACY_ORGANIZATIONS.includes(org[1]);
}

// CLI entry point: writes CERT_FILE/KEY_FILE for the given names and prints the authority's fingerprint, or answers
// --outdated / --fingerprint CERT_FILE.
function cli(argv) {
  if (argv[0] === '--fingerprint') {
    try {
      const text = fs.readFileSync(argv[1], 'utf8');
      const anchor = trustAnchor(text);
      const x = anchor ? new crypto.X509Certificate(anchor) : parseCertificates(text)[0];
      if (!x) throw new Error('no certificate');
      console.log(x.fingerprint256);
      return 0;
    } catch {
      console.error('usage: node src/selfsigned.js --fingerprint CERT_FILE (a readable certificate file)');
      return 1;
    }
  }
  if (argv[0] === '--outdated') {
    if (!argv[1]) {
      console.error('usage: node src/selfsigned.js --outdated CERT_FILE');
      return 2;
    }
    try {
      return outdated(fs.readFileSync(argv[1], 'utf8')) ? 0 : 1;
    } catch {
      return 1;
    }
  }
  const [certFile, keyFile, ...extra] = argv;
  if (!certFile || !keyFile) {
    console.error('usage: node src/selfsigned.js CERT_FILE KEY_FILE [NAME_OR_IP ...]');
    return 2;
  }
  const names = defaultNames(extra);
  const { cert, key, ca } = createSelfSigned(names);
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  fs.writeFileSync(certFile, cert, { mode: 0o644 });
  const fp = new crypto.X509Certificate(ca).fingerprint256;
  console.log(`self-signed certificate for ${names.join(', ')}`);
  console.log(`SHA-256 fingerprint of its certificate authority (the one to trust): ${fp}`);
  return 0;
}

if (require.main === module) process.exitCode = cli(process.argv.slice(2));

module.exports = { createSelfSigned, defaultNames, trustAnchor, outdated };
