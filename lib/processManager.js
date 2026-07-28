const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

// userId -> ChildProcess
const running = new Map();

const TEMPLATES = {
  music: path.join(__dirname, '..', 'templates', 'music-bot.js'),
  ia: path.join(__dirname, '..', 'templates', 'ia-bot.js'),
  gestion: path.join(__dirname, '..', 'templates', 'gestion-bot', 'index.bot.js'),
};

// Dossier de données isolé pour un client donné, uniquement utilisé par le
// type "gestion" (pour que deux clients n'écrivent jamais dans les mêmes
// fichiers config/tickets/leveling/etc.).
function getGestionDataDir(userId) {
  return path.join(__dirname, '..', 'data', 'gestion-instances', userId);
}

function isRunning(userId) {
  return running.has(userId);
}

function start(userId, license) {
  if (running.has(userId)) {
    return { ok: false, reason: 'deja_demarre' };
  }

  const templatePath = TEMPLATES[license.type];
  if (!templatePath) {
    return { ok: false, reason: 'type_inconnu' };
  }

  const env = {
    ...process.env,
    SUBBOT_TOKEN: license.token,
    SUBBOT_USER_ID: userId,
  };

  if (license.type === 'gestion') {
    const dataDir = getGestionDataDir(userId);
    fs.mkdirSync(dataDir, { recursive: true });
    env.SUBBOT_DATA_DIR = dataDir;
    // Le(s) admin(s) du Manager gardent toujours un accès admin sur CHAQUE
    // instance "gestion" déployée, quel que soit le client.
    env.ADMIN_IDS = process.env.GESTION_ADMIN_IDS || '';
  }

  const child = fork(templatePath, [], {
    // Certains templates (gestion-bot) utilisent des chemins relatifs
    // (./commands, ./events, ...) : on force le cwd sur le dossier du
    // template pour que ça continue de fonctionner une fois lancé par fork().
    cwd: path.dirname(templatePath),
    env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  child.on('exit', (code) => {
    console.log(`[processManager] Bot de ${userId} (${license.type}) arrêté (code ${code}).`);
    running.delete(userId);
  });

  child.on('error', (err) => {
    console.error(`[processManager] Erreur du bot de ${userId} :`, err);
  });

  running.set(userId, child);
  console.log(`[processManager] Bot de ${userId} (${license.type}) démarré (pid ${child.pid}).`);
  return { ok: true };
}

function stop(userId) {
  const child = running.get(userId);
  if (!child) {
    return { ok: false, reason: 'pas_demarre' };
  }

  child.kill('SIGTERM');

  // Filet de sécurité : si le process ne s'arrête pas de lui-même après
  // quelques secondes, on force l'arrêt. Sans ça, si kill() ne prenait pas
  // effet, le bot restait connecté à Discord sans qu'on puisse le retrouver.
  const forceKillTimeout = setTimeout(() => {
    if (running.get(userId) === child) {
      console.log(`[processManager] Le bot de ${userId} ne s'est pas arrêté à temps, arrêt forcé.`);
      child.kill('SIGKILL');
    }
  }, 5000);

  child.once('exit', () => clearTimeout(forceKillTimeout));

  // La suppression de `running` se fait dans le handler 'exit' de start(),
  // pas ici : ça évite de considérer le bot comme arrêté avant qu'il le
  // soit vraiment.
  return { ok: true };
}

// Redémarre proprement un bot (attend la fin réelle du process avant de
// relancer) — utilisé après avoir modifié la config buyer par exemple.
function restart(userId, license) {
  const child = running.get(userId);
  if (!child) {
    return Promise.resolve(start(userId, license));
  }

  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve(start(userId, license));
    });
    stop(userId);
  });
}

function stopAll() {
  for (const [userId] of running) {
    stop(userId);
  }
}

module.exports = { start, stop, restart, stopAll, isRunning, getGestionDataDir };
