const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_PATH = path.join(__dirname, '..', 'data', 'licenses.json');

function ensureFile() {
  if (!fs.existsSync(DATA_PATH)) {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, '{}', 'utf-8');
  }
}

function readAll() {
  ensureFile();
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeAll(data) {
  ensureFile();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function generateId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // ex: A1B2C3D4
}

// Crée une licence "code" pour un type de bot donné, pas encore liée à un
// utilisateur. Le client la rattachera à son compte via /active-bot.
function create(type, days, adminId) {
  const all = readAll();

  let id = generateId();
  while (all[id]) id = generateId(); // évite (très improbable) une collision

  const now = Date.now();
  all[id] = {
    id,
    type, // 'music' | 'ia'
    userId: null,
    token: null,
    createdAt: now,
    expiresAt: now + days * 24 * 60 * 60 * 1000,
    active: false,
    createdBy: adminId,
  };
  writeAll(all);
  return all[id];
}

function get(licenseId) {
  const all = readAll();
  return all[licenseId] || null;
}

function findByUser(userId) {
  const all = readAll();
  for (const license of Object.values(all)) {
    if (license.userId === userId) return license;
  }
  return null;
}

function listAll() {
  return readAll();
}

function remove(licenseId) {
  const all = readAll();
  const existed = Boolean(all[licenseId]);
  delete all[licenseId];
  writeAll(all);
  return existed;
}

function extend(licenseId, days) {
  const all = readAll();
  const license = all[licenseId];
  if (!license) return null;

  const base = Math.max(license.expiresAt, Date.now());
  license.expiresAt = base + days * 24 * 60 * 60 * 1000;
  writeAll(all);
  return license;
}

// Rattache une licence-code à l'utilisateur qui la fournit, avec son token.
function activate(licenseId, userId, token) {
  const all = readAll();
  const license = all[licenseId];

  if (!license) return { error: 'introuvable' };
  if (isExpired(license)) return { error: 'expiree' };
  if (license.active) return { error: 'deja_utilisee' };

  license.userId = userId;
  license.token = token;
  license.active = true;
  writeAll(all);
  return { license };
}

function isExpired(license) {
  return Date.now() > license.expiresAt;
}

module.exports = {
  create,
  get,
  findByUser,
  listAll,
  remove,
  extend,
  activate,
  isExpired,
};
