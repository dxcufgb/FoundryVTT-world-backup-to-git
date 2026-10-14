'use strict';
// When each world is backed up. A schedule names slots in local time: every N hours counted from midnight, daily
// at HH:MM, or weekly on a weekday at HH:MM. Every minute the scheduler looks at each enabled world: when the most
// recent slot of its schedule is one that has not run yet (status.lastScheduled is older), the world is queued.
// So a slot missed while the machine was off runs as soon as it is back, and a freshly installed service backs
// every world up once right away.

const { effectiveSettings } = require('./config.js');

const TICK_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function atTime(date, time) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

/** The most recent slot of the schedule at or before `now` (a Date). */
function lastSlot(schedule, now) {
  if (schedule.frequency === 'hourly') {
    let last = new Date(now);
    last.setHours(0, 0, 0, 0);
    for (let h = schedule.everyHours; h < 24; h += schedule.everyHours) {
      const slot = new Date(last);
      slot.setHours(h, 0, 0, 0);
      if (slot > now) break;
      last = slot;
    }
    return last;
  }
  if (schedule.frequency === 'daily') {
    let d = atTime(now, schedule.time);
    if (d > now) d = atTime(new Date(now.getTime() - DAY_MS), schedule.time);
    return d;
  }
  // weekly
  let d = atTime(now, schedule.time);
  const back = (now.getDay() - schedule.weekday + 7) % 7;
  d = atTime(new Date(d.getTime() - back * DAY_MS), schedule.time);
  if (d > now) d = atTime(new Date(d.getTime() - 7 * DAY_MS), schedule.time);
  return d;
}

/** The first slot after `now`. */
function nextSlot(schedule, now) {
  if (schedule.frequency === 'hourly') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    for (let day = 0; day < 3; day++) {
      for (let h = 0; h < 24; h += schedule.everyHours) {
        const slot = new Date(d);
        slot.setDate(d.getDate() + day);
        slot.setHours(h, 0, 0, 0);
        if (slot > now) return slot;
      }
    }
  }
  if (schedule.frequency === 'daily') {
    const today = atTime(now, schedule.time);
    if (today > now) return today;
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    return atTime(tomorrow, schedule.time);
  }
  const ahead = (schedule.weekday - now.getDay() + 7) % 7;
  const day = new Date(now);
  day.setDate(now.getDate() + ahead);
  const slot = atTime(day, schedule.time);
  if (slot > now) return slot;
  day.setDate(day.getDate() + 7);
  return atTime(day, schedule.time);
}

/**
 * backups: createBackups(); getConfig: the current config; statusOf(id): the world's status entry.
 * Returns { start, stop, check, nextRun }.
 */
function createScheduler({ backups, getConfig, now = () => new Date(), log = console.log }) {
  let timer = null;

  /** Queues every enabled world whose latest slot has not run; returns the ids queued. */
  function check() {
    const config = getConfig();
    const t = now();
    const queued = [];
    let worlds;
    try {
      worlds = backups.worlds();
    } catch (err) {
      log(`scheduler: cannot list the worlds (${err.message})`);
      return queued;
    }
    for (const w of worlds) {
      const eff = effectiveSettings(config, w.id);
      if (!eff.enabled || !w.readable) continue;
      const slot = lastSlot(eff.schedule, t).toISOString();
      const done = backups.statusOf(w.id).lastScheduled || '';
      if (done >= slot) continue;
      const r = backups.enqueue(w.id, { reason: `scheduled run for ${slot}`, scheduled: slot });
      if (r.queued) queued.push(w.id);
    }
    if (queued.length) log(`scheduler: queued ${queued.join(', ')}`);
    return queued;
  }

  function start({ firstDelayMs = TICK_MS, intervalMs = TICK_MS } = {}) {
    stop();
    const tick = () => {
      try {
        check();
      } catch (err) {
        log(`scheduler: ${err.message}`);
      }
      timer = setTimeout(tick, intervalMs);
      timer.unref();
    };
    timer = setTimeout(tick, firstDelayMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start,
    stop,
    check,
    nextRun: (id) => nextSlot(effectiveSettings(getConfig(), id).schedule, now()).toISOString(),
  };
}

module.exports = { createScheduler, lastSlot, nextSlot };
