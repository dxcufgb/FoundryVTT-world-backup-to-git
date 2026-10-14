'use strict';
// Sends a notification e-mail to the recipients configured in admin.json (installer or admin page): the service
// uses it for failed backups, the auto-update scripts for their results.
//
//   node src/notify.js --service-env FILE --subject TEXT --message TEXT
//   node src/notify.js --admin-file FILE --subject TEXT --message TEXT
//
// --service-env is the service's env file: admin.json is its ADMIN_FILE, or admin.json next to its CONFIG_FILE (the
// same rule as the service). Exit 0 = sent, or nobody to notify (not configured is not an error); 1 = error.
// The SMTP password is never printed. No dependencies: built-in fs, path and os only.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadAdminSettings } = require('./admin.js');
const { sendMail } = require('./mailer.js');

/** KEY=value pairs of an env file (no shell expansion; surrounding quotes removed). */
function parseEnvFile(text) {
  const out = Object.create(null);
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/** admin.json named by an env file, resolved like the service does (relative paths from the env file's folder). */
function adminFileFromEnv(envFile) {
  const env = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
  const dir = path.dirname(envFile);
  if (env.ADMIN_FILE) return path.resolve(dir, env.ADMIN_FILE);
  const config = path.resolve(dir, env.CONFIG_FILE || './config.json');
  return path.join(path.dirname(config), 'admin.json');
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--service-env', '--admin-file', '--subject', '--message'].includes(key) || value === undefined) {
      throw new Error(`unexpected argument "${key}"`);
    }
    opts[key.slice(2)] = value;
    i++;
  }
  if (!opts['service-env'] && !opts['admin-file']) throw new Error('--service-env or --admin-file is required');
  if (!opts.subject) throw new Error('--subject is required');
  return opts;
}

async function notify(opts, { mailer = sendMail, log = console.log } = {}) {
  const adminFile = opts['admin-file'] || adminFileFromEnv(opts['service-env']);
  const { notify: settings } = loadAdminSettings(adminFile);
  if (!settings.recipients.length) {
    log('notify: no recipients configured; no e-mail sent');
    return 0;
  }
  const host = os.hostname();
  await mailer(settings.smtp, {
    to: settings.recipients,
    subject: `Foundry world backup (${host}): ${opts.subject}`,
    text: `${opts.message || opts.subject}\n\n-- \nFoundry world backup on ${host}\n` +
      'Change the recipients on the administration page of the backup service.\n',
  });
  log(`notify: e-mail sent to ${settings.recipients.length} recipient(s)`);
  return 0;
}

if (require.main === module) {
  (async () => {
    try {
      process.exitCode = await notify(parseArgs(process.argv.slice(2)));
    } catch (err) {
      console.error(`notify: ${err.message}`);
      process.exitCode = 1;
    }
  })();
}

module.exports = { notify, parseArgs, parseEnvFile, adminFileFromEnv };
