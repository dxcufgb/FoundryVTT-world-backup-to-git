'use strict';
// Minimal SMTP client for the notification e-mails (failed backups, auto-update results, the admin page's test mail).
// No dependencies: built-in net, tls, os and crypto only. Supports implicit TLS (port 465), STARTTLS (587) and plain
// SMTP without authentication (a local relay). The password is only ever sent over TLS, with AUTH PLAIN or LOGIN.

const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

const TIMEOUT_MS = 20000;
const MAX_LINE_BYTES = 64 * 1024;
const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SECURITY = new Set(['starttls', 'tls', 'none']);

class MailError extends Error {}

/** True for a plain address (no display name) that is safe to put in a header and an SMTP command. */
function isEmail(text) {
  return typeof text === 'string' && text.length <= 254 && EMAIL_RE.test(text);
}

/** Checks SMTP settings; returns an error message or '' when they are usable for sending. */
function smtpProblem(smtp) {
  if (!smtp || !smtp.host) return 'no SMTP server configured';
  if (!HOST_RE.test(smtp.host)) return 'invalid SMTP host';
  if (!Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535) return 'invalid SMTP port';
  if (!SECURITY.has(smtp.security)) return 'SMTP security must be starttls, tls or none';
  if (!isEmail(smtp.from)) return 'invalid sender address';
  if (smtp.user && smtp.security === 'none') return 'refusing to send the SMTP password without TLS';
  return '';
}

/** RFC 2047 encoded-word for non-ASCII header text; CR/LF are removed so nothing can be injected. */
function encodeHeader(text) {
  const clean = String(text).replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** The full message (headers + base64 body). Base64 lines never start with ".", so no dot-stuffing is needed. */
function buildMessage({ from, to, subject, text, date = new Date() }) {
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n');
  const domain = from.slice(from.indexOf('@') + 1);
  return [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/** Reads SMTP replies (one or more "NNN-..." lines ending with "NNN ...") from a socket. */
function replyReader(socket) {
  let buffer = '';
  let lines = [];
  const replies = [];
  const waiters = [];
  let failure = null;

  const deliver = () => {
    while (waiters.length && (replies.length || failure)) {
      const w = waiters.shift();
      if (replies.length) w.resolve(replies.shift());
      else w.reject(failure);
    }
  };
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > MAX_LINE_BYTES) {
      failure = new MailError('SMTP server sent an over-long reply');
      socket.destroy();
      return deliver();
    }
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      lines.push(line);
      if (!/^\d{3}-/.test(line)) {
        replies.push({ code: Number(line.slice(0, 3)) || 0, text: lines.join('\n') });
        lines = [];
      }
    }
    deliver();
  };
  const onEnd = (err) => {
    failure = failure || new MailError(err ? `SMTP connection failed: ${err.message}` : 'SMTP connection closed');
    deliver();
  };
  const attach = (s) => {
    s.on('data', onData);
    s.on('error', onEnd);
    s.on('close', () => onEnd());
  };
  attach(socket);
  return {
    next: () => new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      deliver();
    }),
    /** Stop reading the plain socket before STARTTLS hands it to TLS. */
    detach() {
      socket.removeListener('data', onData);
      buffer = '';
      lines = [];
    },
    /** Continue on the TLS socket after STARTTLS. */
    rebind(s) {
      attach(s);
      socket = s;
    },
  };
}

function connectSocket({ host, port, security, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const s = security === 'tls'
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
      : net.connect({ host, port });
    s.setTimeout(timeoutMs, () => s.destroy(new Error('timed out')));
    s.once(security === 'tls' ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', (err) => reject(new MailError(`cannot connect to ${host}:${port}: ${err.message}`)));
  });
}

function upgradeToTls(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: net.isIP(host) ? undefined : host });
    s.setTimeout(timeoutMs, () => s.destroy(new Error('timed out')));
    s.once('secureConnect', () => resolve(s));
    s.once('error', (err) => reject(new MailError(`STARTTLS failed: ${err.message}`)));
  });
}

/**
 * Sends one plain-text mail. smtp: { host, port, security: 'starttls'|'tls'|'none', user, password, from }.
 * Error messages never contain the password.
 */
async function sendMail(smtp, { to, subject, text }, { timeoutMs = TIMEOUT_MS } = {}) {
  const problem = smtpProblem(smtp);
  if (problem) throw new MailError(problem);
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length || !recipients.every(isEmail)) throw new MailError('invalid recipient address');

  let socket = await connectSocket({ ...smtp, timeoutMs });
  const reader = replyReader(socket);
  const write = (line) => socket.write(`${line}\r\n`);
  const expect = async (codes, what) => {
    const reply = await reader.next();
    if (!codes.includes(reply.code)) {
      // Only the server's first line: some servers echo parts of the command.
      throw new MailError(`SMTP ${what} failed: ${reply.text.split('\n')[0].slice(0, 200)}`);
    }
    return reply;
  };
  const command = (line, codes, what) => {
    write(line);
    return expect(codes, what);
  };

  try {
    await expect([220], 'greeting');
    const name = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
    let ehlo = await command(`EHLO ${name}`, [250], 'EHLO');
    if (smtp.security === 'starttls') {
      if (!/^250[ -]STARTTLS\b/im.test(ehlo.text)) throw new MailError('SMTP server does not offer STARTTLS');
      await command('STARTTLS', [220], 'STARTTLS');
      reader.detach();
      socket = await upgradeToTls(socket, smtp.host, timeoutMs);
      reader.rebind(socket);
      ehlo = await command(`EHLO ${name}`, [250], 'EHLO');
    }
    if (smtp.user) {
      const auth = (/^250[ -]AUTH\b(.*)$/im.exec(ehlo.text) || [])[1] || '';
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        const plain = Buffer.from(`\0${smtp.user}\0${smtp.password || ''}`, 'utf8').toString('base64');
        await command(`AUTH PLAIN ${plain}`, [235], 'login');
      } else {
        await command('AUTH LOGIN', [334], 'login');
        await command(Buffer.from(smtp.user, 'utf8').toString('base64'), [334], 'login');
        await command(Buffer.from(smtp.password || '', 'utf8').toString('base64'), [235], 'login');
      }
    }
    await command(`MAIL FROM:<${smtp.from}>`, [250], 'MAIL FROM');
    for (const rcpt of recipients) await command(`RCPT TO:<${rcpt}>`, [250, 251], 'RCPT TO');
    await command('DATA', [354], 'DATA');
    socket.write(buildMessage({ from: smtp.from, to: recipients, subject, text }));
    await command('.', [250], 'sending the message');
    // The mail is accepted; a server that drops the line instead of saying goodbye changes nothing.
    await command('QUIT', [221], 'QUIT').catch(() => {});
  } finally {
    socket.end();
    socket.destroy();
  }
}

module.exports = { sendMail, buildMessage, encodeHeader, isEmail, smtpProblem, MailError };
