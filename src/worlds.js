'use strict';
// Finds the worlds of a Foundry VTT installation: every folder under <user data>/Data/worlds that has a world.json.
// FOUNDRY_DATA may point at the user data folder (the one with Config, Data and Logs; Foundry calls it "User Data
// Path"), at its Data folder or straight at the worlds folder. Folder sizes are summed with a plain walk (symbolic
// links are not followed), which can take a few seconds for a large world, so callers cache them.

const fs = require('node:fs');
const path = require('node:path');
const { WORLD_ID_RE } = require('./config.js');

class WorldsError extends Error {}

/** The worlds folder for FOUNDRY_DATA, whichever of the three folders it names. */
function worldsDir(dataDir) {
  const candidates = [
    path.join(dataDir, 'Data', 'worlds'),
    path.join(dataDir, 'worlds'),
    dataDir,
  ];
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory() && path.basename(dir) === 'worlds') return dir;
    } catch {
      // try the next one
    }
  }
  throw new WorldsError(`${dataDir} is not a Foundry user data folder (no Data/worlds inside)`);
}

/** Reads world.json; returns {} when it is unreadable or not JSON (the folder still counts as a world). */
function readWorldJson(folder) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(folder, 'world.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

const text = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Lists the worlds: [{ id, folder, title, system, coreVersion, readable, problem }], sorted by id. */
function listWorlds(dataDir) {
  const dir = worldsDir(dataDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new WorldsError(`cannot read ${dir}: ${err.message}`);
  }
  const worlds = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORLD_ID_RE.test(entry.name)) continue;
    const folder = path.join(dir, entry.name);
    let hasManifest = false;
    let problem = '';
    try {
      hasManifest = fs.statSync(path.join(folder, 'world.json')).isFile();
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') problem = `cannot read the folder (${err.code})`;
    }
    if (!hasManifest && !problem) continue;
    const manifest = hasManifest ? readWorldJson(folder) : {};
    const compat = manifest.compatibility && typeof manifest.compatibility === 'object' ? manifest.compatibility : {};
    worlds.push({
      id: entry.name,
      folder,
      title: text(manifest.title) || entry.name,
      system: text(manifest.system, 60),
      coreVersion: text(compat.verified || compat.minimum || manifest.coreVersion, 20),
      readable: !problem,
      problem,
    });
  }
  worlds.sort((a, b) => a.id.localeCompare(b.id));
  return worlds;
}

/** Total size in bytes of the regular files below a folder (symbolic links are counted as their own size). */
async function folderSize(folder) {
  let total = 0;
  const stack = [folder];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        try {
          total += (await fs.promises.lstat(full)).size;
        } catch {
          // deleted while walking
        }
      }
    }
  }
  return total;
}

/** "1.2 GB", "348 MB", "12 kB", "0 B". */
function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

module.exports = { worldsDir, listWorlds, folderSize, formatSize, WorldsError };
