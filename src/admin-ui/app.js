'use strict';
// Administration page of the Foundry world backup. Plain DOM code, no libraries; every value from the server is put
// into the page with textContent, never as HTML. One HTML page with several views, chosen by the address's
// fragment: #/ (worlds), #/schedule, #/foundry, #/github, #/notifications, #/password (the settings menu links to
// them).

(() => {
  const $ = (sel) => document.querySelector(sel);
  let csrf = '';
  let state = null;
  let recipients = [];
  let editing = null; // the world being edited in the dialog
  let update = null; // the last GET update answer
  let watching = null; // timer while waiting for an update to restart the service
  let polling = null; // timer refreshing the worlds while a backup runs
  const PAGES = {
    worlds: 'Worlds',
    schedule: 'Schedule',
    foundry: 'Foundry',
    github: 'GitHub',
    notifications: 'Notifications',
    password: 'Admin password',
  };
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const HOURS = [1, 2, 3, 4, 6, 8, 12, 24];

  function toast(message, bad = false) {
    const el = $('#toast');
    el.textContent = message;
    el.className = bad ? 'bad' : '';
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 3500);
  }

  async function call(method, path, body) {
    const headers = {};
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = csrf;
    }
    const res = await fetch(`/_admin/api/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // keep the empty object
    }
    if (res.status === 401 && path !== 'login') {
      showLogin();
      throw new Error('Your session has ended; please log in again.');
    }
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    if (data.csrf) csrf = data.csrf;
    return data;
  }

  function showLogin() {
    closeMenu();
    stopPolling();
    $('#app-view').hidden = true;
    $('#top-actions').hidden = true;
    $('#app-footer').hidden = true;
    $('#login-view').hidden = false;
    document.body.classList.add('logged-out');
    document.title = 'Foundry World Backup';
    $('#login-form').password.focus();
  }

  function showApp(data) {
    document.body.classList.remove('logged-out');
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#top-actions').hidden = false;
    $('#app-footer').hidden = false;
    render(data);
    showPage();
    checkUpdate();
  }

  // The view named by the address's fragment (#/schedule ...); anything unknown is the worlds page.
  function currentPage() {
    const name = location.hash.replace(/^#\/?/, '');
    return Object.hasOwn(PAGES, name) ? name : 'worlds';
  }

  function showPage() {
    const page = currentPage();
    for (const section of document.querySelectorAll('.page')) section.hidden = section.dataset.page !== page;
    for (const item of document.querySelectorAll('#settings-menu a')) {
      if (item.getAttribute('href') === `#/${page}`) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    document.title = page === 'worlds' ? 'Foundry World Backup' : `${PAGES[page]} – Foundry World Backup`;
    closeMenu();
  }

  // Settings menu (the cogwheel): opens below the button, closes on Escape, a click outside or a choice.
  function menuItems() {
    return [...document.querySelectorAll('#settings-menu [role="menuitem"]')];
  }

  function openMenu(focusIndex = 0) {
    $('#settings-menu').hidden = false;
    $('#settings-button').setAttribute('aria-expanded', 'true');
    const items = menuItems();
    if (items[focusIndex]) items[focusIndex].focus();
  }

  function closeMenu(returnFocus = false) {
    if ($('#settings-menu').hidden) return;
    $('#settings-menu').hidden = true;
    $('#settings-button').setAttribute('aria-expanded', 'false');
    if (returnFocus) $('#settings-button').focus();
  }

  function menuKeys(e) {
    const items = menuItems();
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(i + step + items.length) % items.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of children) node.append(child);
    return node;
  }

  function formatSize(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '…';
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1000 && i < units.length - 1) {
      n /= 1000;
      i++;
    }
    return `${i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  function relativeTime(iso) {
    if (!iso) return '';
    const diff = Date.now() - Date.parse(iso);
    const abs = Math.abs(diff);
    const future = diff < 0;
    const units = [['day', 86400000], ['hour', 3600000], ['minute', 60000]];
    for (const [name, ms] of units) {
      if (abs >= ms) {
        const n = Math.floor(abs / ms);
        return future ? `in ${n} ${name}${n === 1 ? '' : 's'}` : `${n} ${name}${n === 1 ? '' : 's'} ago`;
      }
    }
    return future ? 'in under a minute' : 'just now';
  }

  function describeSchedule(s) {
    if (s.frequency === 'hourly') return s.everyHours === 24 ? 'daily at 00:00' : s.everyHours === 1 ? 'every hour' : `every ${s.everyHours} hours`;
    if (s.frequency === 'daily') return `daily at ${s.time}`;
    return `${WEEKDAYS[s.weekday]}s at ${s.time}`;
  }

  // The frequency / time / weekday / every-N-hours fields of a schedule form, built once per container.
  function buildScheduleFields(container) {
    container.replaceChildren(
      el('label', { text: 'Frequency ' }, [
        el('select', { name: 'frequency', onchange: () => updateScheduleFields(container) }, [
          el('option', { value: 'daily', text: 'Every day' }),
          el('option', { value: 'weekly', text: 'Every week' }),
          el('option', { value: 'hourly', text: 'Every few hours' }),
        ]),
      ]),
      el('label', { text: 'Weekday ', 'data-for': 'weekly' }, [
        el('select', { name: 'weekday' }, WEEKDAYS.map((d, i) => el('option', { value: String(i), text: d }))),
      ]),
      el('label', { text: 'Time ', 'data-for': 'daily weekly' }, [el('input', { name: 'time', type: 'time', required: '', value: '04:00' })]),
      el('label', { text: 'Every ', 'data-for': 'hourly' }, [
        el('select', { name: 'everyHours' }, HOURS.map((h) => el('option', { value: String(h), text: h === 1 ? 'hour' : `${h} hours` }))),
        el('small', { text: 'counted from midnight' }),
      ]),
    );
  }

  function updateScheduleFields(container) {
    const frequency = container.querySelector('[name="frequency"]').value;
    for (const label of container.querySelectorAll('label[data-for]')) {
      label.hidden = !label.dataset.for.split(' ').includes(frequency);
    }
  }

  function fillSchedule(container, s) {
    container.querySelector('[name="frequency"]').value = s.frequency;
    container.querySelector('[name="weekday"]').value = String(s.weekday);
    container.querySelector('[name="time"]').value = s.time;
    container.querySelector('[name="everyHours"]').value = String(s.everyHours);
    updateScheduleFields(container);
  }

  function readSchedule(container) {
    return {
      frequency: container.querySelector('[name="frequency"]').value,
      weekday: Number(container.querySelector('[name="weekday"]').value),
      time: container.querySelector('[name="time"]').value,
      everyHours: Number(container.querySelector('[name="everyHours"]').value),
    };
  }

  function render(data) {
    state = data;
    renderWorlds();
    renderSchedule();
    renderFoundry();
    renderToken();
    renderGithub();
    renderVersion();
    renderNotify();
  }

  // The footer: installed version, the latest release, and why "Update now" is unavailable (if it is).
  function renderVersion(note) {
    let text = `Foundry World Backup ${state.version || '(version unknown)'}`;
    const notes = [];
    let bad = false;
    if (update) {
      if (update.latest) {
        text += update.newer === true ? ` · version ${update.latest} is available`
          : update.newer === false ? ' · up to date' : ` · latest release ${update.latest}`;
      } else if (update.latestProblem) {
        notes.push(`Latest release unknown: ${update.latestProblem}.`);
      }
      if (update.problem) {
        notes.push(`"Update now" is not available: ${update.problem}`);
        bad = true;
      }
    }
    if (note) notes.push(note);
    $('#version-status').textContent = text;
    $('#version-status').className = update && update.newer ? 'newer' : '';
    const noteEl = $('#version-note');
    noteEl.textContent = notes.join(' ');
    noteEl.hidden = notes.length === 0;
    noteEl.className = bad ? 'small error' : 'small';
    $('#update-now').disabled = Boolean(watching) || !update || !update.canUpdate;
  }

  async function checkUpdate(e) {
    const button = $('#update-check');
    button.disabled = true;
    try {
      update = await call('GET', 'update');
      renderVersion();
      if (e) toast(update.newer ? `Version ${update.latest} is available.` : 'Checked for updates.');
    } catch (err) {
      if (e) toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  }

  // After "Update now": the service restarts when a newer release was installed (and then needs a new login).
  function watchUpdate(before) {
    const started = Date.now();
    clearInterval(watching);
    watching = setInterval(async () => {
      if (Date.now() - started > 5 * 60 * 1000) {
        clearInterval(watching);
        watching = null;
        renderVersion('No restart within 5 minutes: there was no newer release, or the update failed (see the ' +
          'notification e-mail or the update log).');
        return;
      }
      try {
        const data = await call('GET', 'state');
        if (data.version !== before) {
          clearInterval(watching);
          watching = null;
          render(data);
          toast(`Updated to ${data.version}.`);
        }
      } catch (err) {
        if (!$('#login-view').hidden) {
          // the session ended: the service restarted, most likely with the new version
          clearInterval(watching);
          watching = null;
          $('#login-error').textContent = 'The service restarted (after the update); please log in again.';
          $('#login-error').hidden = false;
        }
        // otherwise the service is restarting: keep waiting
      }
    }, 5000);
  }

  async function updateNow(e) {
    const what = update && update.newer ? `version ${update.latest}` : 'the latest release (if it is newer)';
    if (!confirm(`Install ${what} now?\nThe service restarts (a running backup is interrupted and retried later) and you log in again.`)) return;
    const button = e.currentTarget;
    button.disabled = true;
    try {
      await call('POST', 'update', {});
      watchUpdate(state.version);
      renderVersion('Update requested; waiting for the service to restart…');
      toast('Update started.');
    } catch (err) {
      toast(err.message, true);
      renderVersion();
    }
  }

  function renderToken() {
    const t = state.token;
    const status = $('#token-status');
    status.className = t.canChange ? '' : 'error';
    const whose = t.owner ? ` of ${t.owner}` : '';
    status.textContent = t.canChange
      ? `In use: a ${t.kind}${whose}. A new one is saved to ${t.file}.`
      : `In use: a ${t.kind || 'GitHub token'}${whose}. It cannot be changed here: ${t.file ? `${t.file}: ` : ''}${t.problem}`;
    $('#token-save').disabled = !t.canChange;
  }

  function renderGithub() {
    const form = $('#github-form');
    form.repoPrefix.value = state.settings.github.repoPrefix;
    form.createRepos.checked = state.settings.github.createRepos;
  }

  function renderSchedule() {
    const form = $('#schedule-form');
    fillSchedule(form.querySelector('[data-schedule="global"]'), state.settings.schedule);
    form.querySelector(`[name="whenActive"][value="${state.settings.whenActive}"]`).checked = true;
    $('#schedule-link').textContent = describeSchedule(state.settings.schedule);
  }

  // The Foundry page: the address asked for /api/status, saved here or from the installer (FOUNDRY_URL), or off.
  function renderFoundry() {
    const f = state.settings.foundry;
    const form = $('#foundry-form');
    const off = f.inUse === '';
    form.url.value = f.inUse || f.defaultUrl || '';
    form.off.checked = off;
    form.url.disabled = off;
    const from = f.url !== null ? 'saved on this page' : 'FOUNDRY_URL from the installer';
    $('#foundry-status').textContent = off
      ? `Off (${from}): Foundry is not asked, so a world is backed up even while it is active.`
      : `In use: ${f.inUse} (${from}).`;
    $('#foundry-url-hint').textContent = f.defaultUrl
      ? `FOUNDRY_URL from the installer: ${f.defaultUrl}.` : 'The installer set no address (FOUNDRY_URL is empty).';
    $('#foundry-reset').hidden = f.url === null;
  }

  function foundryFormUrl() {
    const form = $('#foundry-form');
    return form.off.checked ? '' : form.url.value.trim();
  }

  async function saveFoundry(e) {
    e.preventDefault();
    const url = foundryFormUrl();
    if (!url && !$('#foundry-form').off.checked) {
      toast('Enter Foundry\'s address, or tick "Do not ask Foundry".', true);
      return;
    }
    try {
      render(await call('PUT', 'settings', { foundry: { url } }));
      toast('Foundry settings saved.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function resetFoundry() {
    try {
      render(await call('PUT', 'settings', { foundry: { url: null } }));
      toast('The installer\'s address is used again.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function testFoundry(e) {
    const button = e.currentTarget;
    button.disabled = true;
    const list = $('#foundry-results');
    list.replaceChildren(el('li', { text: 'Testing…' }));
    list.hidden = false;
    try {
      const r = await call('POST', 'foundry-test', { url: foundryFormUrl() });
      list.replaceChildren(el('li', { class: r.status }, [
        el('span', { class: 'mark', 'aria-hidden': 'true', text: MARK[r.status] || '?' }),
        el('strong', { text: 'Foundry:' }),
        el('span', { text: ` ${r.message}` }),
      ]));
    } catch (err) {
      list.hidden = true;
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  }

  const MARK = { ok: '✓', warn: '!', bad: '✗' };

  function showResults(r) {
    const list = $('#setup-results');
    list.replaceChildren();
    const line = (status, title, message) => el('li', { class: status }, [
      el('span', { class: 'mark', 'aria-hidden': 'true', text: MARK[status] || '?' }),
      el('strong', { text: title }),
      el('span', { text: ` ${message}` }),
    ]);
    list.append(line(r.token.status, r.tested === 'typed' ? 'Typed token:' : 'Token in use:', r.token.message));
    for (const c of r.checks) {
      const title = c.kind === 'world' ? `${c.name} (${c.repo}):` : c.repo ? `${c.name} (${c.repo}):` : `${c.name}:`;
      list.append(line(c.status, title, c.message));
    }
    if (r.token.status === 'bad') {
      list.append(line('bad', 'Repositories:', 'not checked, GitHub did not accept the token.'));
    }
    list.hidden = false;
  }

  async function testSetup(e) {
    const button = e.currentTarget;
    button.disabled = true;
    const list = $('#setup-results');
    list.replaceChildren(el('li', { text: 'Testing…' }));
    list.hidden = false;
    try {
      const r = await call('POST', 'setup-test', { token: $('#token-form').token.value.trim() });
      showResults(r);
      const bad = r.token.status === 'bad' || r.checks.some((c) => c.status === 'bad');
      toast(bad ? 'Test setup found problems (see the list).' : 'Test setup finished.', bad);
      render(await call('GET', 'state'));
    } catch (err) {
      list.hidden = true;
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function saveToken(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const button = $('#token-save');
    button.disabled = true;
    try {
      render(await call('PUT', 'token', { token: form.token.value.trim() }));
      form.reset();
      toast('Token saved and in use. Delete the old one on GitHub when you no longer need it.');
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = !state.token.canChange;
    }
  }

  async function saveGithub(e) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      render(await call('PUT', 'settings', { github: { repoPrefix: form.repoPrefix.value.trim(), createRepos: form.createRepos.checked } }));
      toast('GitHub settings saved.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function saveSchedule(e) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      render(await call('PUT', 'settings', {
        schedule: readSchedule(form.querySelector('[data-schedule="global"]')),
        whenActive: form.whenActive.value,
      }));
      toast('Schedule saved.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // "Backed up" column: the state of the last run, in words and colour.
  function backedUp(w) {
    if (!w.readable) return { class: 'bad', text: 'Not readable', detail: w.problem };
    if (!w.enabled) return { class: 'off', text: 'Off', detail: 'Turned off in its settings' };
    if (w.running) return { class: 'busy', text: 'Backing up…', detail: '' };
    if (w.queued) return { class: 'busy', text: 'Queued', detail: '' };
    if (w.lastResult === 'ok') return { class: 'good', text: 'Yes', detail: w.changed === false ? 'No changes since the backup before' : w.wasActive ? 'The world was active during the backup' : '' };
    if (w.lastResult === 'error') return { class: 'bad', text: 'Failed', detail: w.lastError };
    if (w.lastResult === 'skipped') return { class: 'warn', text: 'Skipped', detail: w.lastError };
    return { class: 'warn', text: 'Not yet', detail: `First run ${relativeTime(w.nextRun)}` };
  }

  function renderWorlds() {
    const body = $('#worlds tbody');
    body.replaceChildren();
    const problem = $('#worlds-problem');
    problem.textContent = state.worldsProblem ? `The worlds cannot be listed: ${state.worldsProblem}` : '';
    problem.hidden = !state.worldsProblem;
    let active = false;
    for (const w of state.worlds) {
      active = active || w.running || w.queued;
      const b = backedUp(w);
      const last = w.lastSuccess
        ? [el('span', { text: relativeTime(w.lastSuccess), title: new Date(w.lastSuccess).toLocaleString() }),
          el('span', { class: 'status', text: w.enabled && w.nextRun ? `Next: ${new Date(w.nextRun).toLocaleString()}` : '' })]
        : [el('span', { class: 'muted', text: 'Never' }),
          el('span', { class: 'status', text: w.enabled && w.nextRun ? `Next: ${new Date(w.nextRun).toLocaleString()}` : '' })];
      const row = el('tr', { class: w.enabled ? '' : 'disabled' }, [
        el('td', { class: 'check-col' }, [
          el('input', { type: 'checkbox', 'aria-label': `Back up ${w.title}`, title: w.enabled ? 'Backed up: clear to turn off' : 'Not backed up: tick to turn on',
            onchange: (e) => setEnabled(w, e.currentTarget) }),
        ]),
        el('td', {}, [
          el('strong', { text: w.title }),
          el('span', { class: 'status', text: w.id + (w.system ? ` · ${w.system}` : '') + (w.customSchedule ? ` · ${describeSchedule(w.schedule)}` : '') }),
        ]),
        el('td', {}, [
          el('span', { class: `badge ${b.class}`, text: b.text }),
          el('span', { class: `status${b.class === 'bad' ? ' bad' : ''}`, text: b.detail }),
        ]),
        el('td', {}, last),
        el('td', {}, [el('span', { text: formatSize(w.size), title: w.sizeAt ? `summed ${new Date(w.sizeAt).toLocaleString()}` : '' })]),
        el('td', { class: 'repo' }, [w.repo.startsWith('/')
          ? el('code', { text: `(token owner)${w.repo}` })
          : el('a', { href: `https://github.com/${w.repo}`, target: '_blank', rel: 'noopener', text: w.repo })]),
        el('td', {}, [el('div', { class: 'actions' }, [
          el('button', { type: 'button', class: 'small', text: 'Back up now', disabled: '', onclick: () => backupNow(w) }),
          el('button', { type: 'button', class: 'icon-button small secondary', 'aria-label': `Settings of ${w.title}`,
            title: 'Settings', onclick: () => openWorld(w) }, [gearIcon()]),
        ])]),
      ]);
      row.querySelector('input[type="checkbox"]').checked = w.enabled;
      const button = row.querySelector('button');
      button.disabled = !w.enabled || !w.readable || w.running || w.queued;
      body.append(row);
    }
    $('#worlds').hidden = state.worlds.length === 0;
    $('#no-worlds').hidden = state.worlds.length !== 0 || Boolean(state.worldsProblem);
    $('#backup-all').disabled = !state.worlds.some((w) => w.enabled && w.readable && !w.running && !w.queued);
    if (active || state.busy) startPolling();
    else stopPolling();
  }

  // The checkbox of a row: turns the world on or off and keeps its other settings.
  async function setEnabled(w, box) {
    box.disabled = true;
    try {
      render(await call('PUT', `worlds/${encodeURIComponent(w.id)}`, {
        enabled: box.checked,
        repo: w.ownRepo || '',
        schedule: w.customSchedule ? w.schedule : null,
        whenActive: w.ownWhenActive || '',
      }));
      toast(box.checked ? `${w.title} is backed up again.` : `${w.title} is no longer backed up.`);
    } catch (err) {
      box.checked = !box.checked;
      box.disabled = false;
      toast(err.message, true);
    }
  }

  function gearIcon() {
    const gear = $('#settings-button svg').cloneNode(true);
    gear.setAttribute('width', '16');
    gear.setAttribute('height', '16');
    return gear;
  }

  // While a backup runs the table is refreshed every few seconds.
  function startPolling() {
    if (polling) return;
    polling = setInterval(async () => {
      try {
        render(await call('GET', 'state'));
      } catch {
        stopPolling();
      }
    }, 4000);
  }

  function stopPolling() {
    clearInterval(polling);
    polling = null;
  }

  async function backupNow(w) {
    try {
      render(await call('POST', `worlds/${encodeURIComponent(w.id)}/backup`, {}));
      toast(`Backup of ${w.title} started.`);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function backupAll() {
    const todo = state.worlds.filter((w) => w.enabled && w.readable && !w.running && !w.queued);
    if (!todo.length) return;
    if (!confirm(`Back up ${todo.length} world(s) now, one after the other?`)) return;
    let data = null;
    for (const w of todo) {
      try {
        data = await call('POST', `worlds/${encodeURIComponent(w.id)}/backup`, {});
      } catch (err) {
        toast(`${w.title}: ${err.message}`, true);
      }
    }
    if (data) render(data);
    toast(`Queued ${todo.length} backup(s).`);
  }

  async function rescan(e) {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      render(await call('POST', 'worlds/rescan', {}));
      toast('Worlds rescanned; sizes are being summed.');
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function openWorld(w) {
    editing = w;
    const form = $('#world-form');
    form.reset();
    $('#world-dialog-title').textContent = w.title;
    $('#world-dialog-info').textContent = `${w.id}${w.system ? ` · ${w.system}` : ''}${w.coreVersion ? ` · Foundry ${w.coreVersion}` : ''}` +
      (w.readable ? '' : ` · ${w.problem}`);
    $('#world-error').hidden = true;
    form.enabled.checked = w.enabled;
    form.repo.value = w.ownRepo || '';
    $('#world-repo-hint').textContent = `Empty = ${defaultRepo(w) || `(token owner)/${state.settings.github.repoPrefix}${w.id}`}.`;
    form.querySelector(`[name="scheduleMode"][value="${w.customSchedule ? 'custom' : 'global'}"]`).checked = true;
    const fields = form.querySelector('[data-schedule="world"]');
    fillSchedule(fields, w.schedule);
    fields.hidden = !w.customSchedule;
    form.querySelector(`[name="whenActive"][value="${w.ownWhenActive || ''}"]`).checked = true;
    $('#world-forget').hidden = w.readable;
    $('#world-dialog').showModal();
  }

  function defaultRepo(w) {
    return state.token.owner ? `${state.token.owner}/${state.settings.github.repoPrefix}${w.id}` : '';
  }

  async function saveWorld(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const custom = form.scheduleMode.value === 'custom';
    const body = {
      enabled: form.enabled.checked,
      repo: form.repo.value.trim(),
      schedule: custom ? readSchedule(form.querySelector('[data-schedule="world"]')) : null,
      whenActive: form.whenActive.value,
    };
    try {
      const data = await call('PUT', `worlds/${encodeURIComponent(editing.id)}`, body);
      $('#world-dialog').close();
      render(data);
      toast(`Saved ${editing.title}.`);
    } catch (err) {
      $('#world-error').textContent = err.message;
      $('#world-error').hidden = false;
    }
  }

  async function forgetWorld() {
    if (!confirm(`Forget "${editing.title}" (${editing.id})?\nIts settings, status and local git copy are removed; the GitHub repository stays.`)) return;
    try {
      const data = await call('DELETE', `worlds/${encodeURIComponent(editing.id)}`);
      $('#world-dialog').close();
      render(data);
      toast(`Forgot ${editing.title}.`);
    } catch (err) {
      $('#world-error').textContent = err.message;
      $('#world-error').hidden = false;
    }
  }

  function renderRecipients() {
    const list = $('#recipients');
    list.replaceChildren();
    if (!recipients.length) list.append(el('li', { class: 'empty', text: 'No recipients: no e-mails are sent.' }));
    recipients.forEach((address, i) => {
      list.append(el('li', {}, [
        el('span', { text: address }),
        el('button', { type: 'button', title: `Remove ${address}`, 'aria-label': `Remove ${address}`, text: '×',
          onclick: () => { recipients.splice(i, 1); renderRecipients(); } }),
      ]));
    });
  }

  function renderNotify() {
    const { smtp } = state.notify;
    recipients = [...state.notify.recipients];
    renderRecipients();
    const form = $('#notify-form');
    for (const key of ['host', 'port', 'security', 'from', 'user']) form[key].value = smtp[key] ?? '';
    form.password.value = '';
    form.password.placeholder = smtp.passwordSet ? '(stored; type to replace)' : '(none)';
    form.clearPassword.checked = false;
    $('#clear-password-row').hidden = !smtp.passwordSet;
  }

  function addRecipient() {
    const input = $('#recipient-input');
    const address = input.value.trim();
    if (!address) return;
    if (!input.checkValidity() || !address.includes('.')) {
      toast(`"${address}" is not an e-mail address.`, true);
      return;
    }
    if (!recipients.some((r) => r.toLowerCase() === address.toLowerCase())) recipients.push(address);
    input.value = '';
    renderRecipients();
  }

  async function saveNotify(e) {
    e.preventDefault();
    if ($('#recipient-input').value.trim()) addRecipient();
    const form = e.currentTarget;
    const body = {
      recipients,
      smtp: {
        host: form.host.value.trim(),
        port: Number(form.port.value),
        security: form.security.value,
        from: form.from.value.trim(),
        user: form.user.value.trim(),
        password: form.password.value,
        clearPassword: form.clearPassword.checked,
      },
    };
    try {
      render(await call('PUT', 'notify', body));
      toast('Notification settings saved.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function testNotify(e) {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      await call('POST', 'notify/test', {});
      toast('Test e-mail sent (to the saved addresses).');
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    const form = e.currentTarget;
    if (form.password.value !== form.repeat.value) {
      toast('The new passwords do not match.', true);
      return;
    }
    try {
      render(await call('PUT', 'password', { current: form.current.value, password: form.password.value }));
      form.reset();
      toast('Password changed. Other sessions were logged out.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function login(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const error = $('#login-error');
    error.hidden = true;
    try {
      const data = await call('POST', 'login', { password: form.password.value });
      form.reset();
      showApp(data);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  }

  async function logout() {
    try {
      await call('POST', 'logout', {});
    } catch {
      // logged out either way
    }
    csrf = '';
    showLogin();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    for (const container of document.querySelectorAll('.schedule-fields')) buildScheduleFields(container);
    $('#login-form').addEventListener('submit', login);
    $('#logout').addEventListener('click', logout);
    $('#settings-button').addEventListener('click', () => {
      if ($('#settings-menu').hidden) openMenu();
      else closeMenu();
    });
    $('#settings-button').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu(e.key === 'ArrowDown' ? 0 : menuItems().length - 1);
      }
    });
    $('#settings-menu').addEventListener('keydown', menuKeys);
    $('#settings-menu').addEventListener('click', () => closeMenu());
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-wrap')) closeMenu();
    });
    window.addEventListener('hashchange', () => {
      if (!$('#app-view').hidden) {
        showPage();
        window.scrollTo(0, 0);
      }
    });
    $('#backup-all').addEventListener('click', backupAll);
    $('#rescan').addEventListener('click', rescan);
    $('#world-form').addEventListener('submit', saveWorld);
    $('#world-cancel').addEventListener('click', () => $('#world-dialog').close());
    $('#world-forget').addEventListener('click', forgetWorld);
    for (const radio of document.querySelectorAll('#world-form [name="scheduleMode"]')) {
      radio.addEventListener('change', () => {
        $('#world-form [data-schedule="world"]').hidden = $('#world-form').scheduleMode.value !== 'custom';
      });
    }
    $('#schedule-form').addEventListener('submit', saveSchedule);
    $('#github-form').addEventListener('submit', saveGithub);
    $('#foundry-form').addEventListener('submit', saveFoundry);
    $('#foundry-test').addEventListener('click', testFoundry);
    $('#foundry-reset').addEventListener('click', resetFoundry);
    $('#foundry-form').off.addEventListener('change', (e) => {
      $('#foundry-form').url.disabled = e.currentTarget.checked;
    });
    $('#token-form').addEventListener('submit', saveToken);
    $('#update-check').addEventListener('click', checkUpdate);
    $('#update-now').addEventListener('click', updateNow);
    $('#setup-test').addEventListener('click', testSetup);
    $('#notify-form').addEventListener('submit', saveNotify);
    $('#notify-test').addEventListener('click', testNotify);
    $('#recipient-add').addEventListener('click', addRecipient);
    $('#recipient-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addRecipient();
      }
    });
    $('#password-form').addEventListener('submit', changePassword);
    try {
      showApp(await call('GET', 'state'));
    } catch {
      showLogin();
    }
  });
})();
