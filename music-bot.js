// Template lancé par le Bot Manager (lib/processManager.js) pour un client
// ayant activé une licence de type "music". Le token vient du manager, pas
// d'un fichier .env local.
require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} = require('@discordjs/voice');
const ytdlp = require('yt-dlp-exec');

// Force @discordjs/voice à utiliser le ffmpeg fourni par ffmpeg-static
// (évite de dépendre d'un ffmpeg installé manuellement sur la machine).
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static');

const PREFIX = '+';
const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Une entrée par serveur (guild) :
// { connection, player, currentProcess, current, queue, stoppingManually, textChannel }
const guildPlayers = new Map();

// La playlist de chaque serveur, indépendante du fait que le bot joue ou non
// (alimentée par +add, consommée par +jouer / la lecture automatique).
const guildQueues = new Map();

function getQueue(guildId) {
  let queue = guildQueues.get(guildId);
  if (!queue) {
    queue = [];
    guildQueues.set(guildId, queue);
  }
  return queue;
}

client.once('clientReady', () => {
  console.log(`[bot] Connecté en tant que ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  console.log(`[cmd] ${message.author.tag} : ${message.content}`);

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  if (command === 'play') {
    await handlePlay(message, args[0]);
  } else if (command === 'stop') {
    await handleStop(message);
  } else if (command === 'pause') {
    await handlePause(message);
  } else if (command === 'add') {
    await handleAdd(message, args[0]);
  } else if (command === 'jouer') {
    await handleJouer(message);
  } else if (command === 'np') {
    await handleNowPlaying(message);
  } else if (command === 'queue' || command === 'playlist') {
    await handleQueue(message);
  } else if (command === 'remix') {
    await handleRemix(message);
  } else if (command === 'remove') {
    await handleRemove(message, args[0]);
  } else if (command === 'rename') {
    await handleRename(message, args[0], args.slice(1).join(' '));
  } else if (command === 'skip') {
    await handleSkip(message);
  } else if (command === 'help') {
    await handleHelp(message);
  }
});

function displayName(track) {
  return track.customName || track.title || track.url;
}

function cleanup(guildId) {
  const entry = guildPlayers.get(guildId);
  if (!entry) return;

  if (entry.currentProcess && !entry.currentProcess.killed) {
    entry.currentProcess.kill();
  }
  entry.connection.destroy();
  guildPlayers.delete(guildId);
  console.log(`[voice] Déconnecté et nettoyé pour le serveur ${guildId}.`);
}

function getAudioStream(url) {
  console.log(`[yt-dlp] Lancement pour : ${url}`);

  const subprocess = ytdlp.exec(
    url,
    {
      output: '-',
      format: 'bestaudio/best',
      noPlaylist: true,
      noWarnings: true,
    },
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  subprocess.on('spawn', () => console.log('[yt-dlp] Processus démarré.'));

  subprocess.stderr.on('data', (chunk) => {
    console.error(`[yt-dlp:stderr] ${chunk.toString().trim()}`);
  });

  subprocess.on('error', (err) => {
    console.error('[yt-dlp] Erreur de lancement :', err);
  });

  subprocess.on('close', (code) => {
    console.log(`[yt-dlp] Terminé (code ${code}).`);
  });

  return subprocess;
}

async function getVideoTitle(url) {
  try {
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noWarnings: true,
    });
    return typeof info === 'object' ? info?.title : null;
  } catch (err) {
    console.error('[yt-dlp] Impossible de récupérer le titre :', err.message || err);
    return null;
  }
}

// Démarre réellement la lecture d'un morceau (track) sur une entrée déjà connectée.
function playTrackNow(entry, track, announceChannel) {
  if (entry.currentProcess && !entry.currentProcess.killed) {
    entry.currentProcess.kill();
  }

  const subprocess = getAudioStream(track.url);
  entry.currentProcess = subprocess;

  const resource = createAudioResource(subprocess.stdout, {
    inputType: StreamType.Arbitrary,
  });
  entry.player.play(resource);
  entry.current = track;
  console.log(`[player] Lecture : ${displayName(track)}`);

  if (announceChannel) {
    announceChannel.send(`Lecture en cours : **${displayName(track)}**`).catch(() => {});
  }
}

// Appelée quand un morceau se termine naturellement : enchaîne sur la
// playlist si elle contient encore quelque chose, sinon se déconnecte.
function playNextOrCleanup(guildId) {
  const entry = guildPlayers.get(guildId);
  if (!entry) return;

  if (entry.queue.length > 0) {
    const next = entry.queue.shift();
    playTrackNow(entry, next, entry.textChannel);
  } else {
    entry.current = null;
    cleanup(guildId);
  }
}

// Crée la connexion vocale + le lecteur audio pour un serveur, et branche
// tous les événements communs (logs, fin de piste, erreurs).
async function ensureVoiceConnection(message) {
  const guildId = message.guild.id;
  let entry = guildPlayers.get(guildId);
  if (entry) {
    entry.textChannel = message.channel;
    return entry;
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    message.reply('Tu dois être dans un salon vocal pour utiliser cette commande.');
    return null;
  }

  console.log(`[voice] Connexion au salon ${voiceChannel.name} (${voiceChannel.id})`);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: message.guild.voiceAdapterCreator,
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(`[voice] Connexion : ${oldState.status} -> ${newState.status}`);
  });
  connection.on('error', (err) => console.error('[voice] Erreur de connexion :', err));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log('[voice] Connexion vocale prête.');
  } catch (err) {
    console.error('[voice] La connexion vocale ne devient jamais "Ready" :', err);
    connection.destroy();
    message.reply("Je n'arrive pas à me connecter au salon vocal. Réessaie.");
    return null;
  }

  const player = createAudioPlayer();
  connection.subscribe(player);

  player.on('stateChange', (oldState, newState) => {
    console.log(`[player] ${oldState.status} -> ${newState.status}`);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    console.log('[player] Lecture terminée (Idle).');
    const currentEntry = guildPlayers.get(guildId);
    if (!currentEntry || currentEntry.stoppingManually) return;
    playNextOrCleanup(guildId);
  });

  player.on('error', (err) => {
    console.error('[player] Erreur du lecteur audio :', err);
    message.channel.send('Une erreur est survenue pendant la lecture.').catch(() => {});
  });

  entry = {
    connection,
    player,
    currentProcess: null,
    current: null,
    queue: getQueue(guildId),
    stoppingManually: false,
    textChannel: message.channel,
  };
  guildPlayers.set(guildId, entry);
  return entry;
}

async function handlePlay(message, url) {
  if (!url) {
    return message.reply('Merci de donner un lien. Exemple : `+play https://youtube.com/watch?v=...`');
  }
  if (!YOUTUBE_URL_REGEX.test(url)) {
    return message.reply("Ce lien n'est pas un lien YouTube valide.");
  }

  const entry = await ensureVoiceConnection(message);
  if (!entry) return;

  try {
    const title = await getVideoTitle(url);
    const track = { url, title, customName: null, requestedBy: message.author.tag };
    playTrackNow(entry, track, message.channel);
  } catch (err) {
    console.error('[handlePlay] Erreur :', err);
    message.reply('Impossible de lire cette vidéo. Vérifie le lien et réessaie.');
  }
}

async function handleAdd(message, url) {
  if (!url) {
    return message.reply('Merci de donner un lien. Exemple : `+add https://youtube.com/watch?v=...`');
  }
  if (!YOUTUBE_URL_REGEX.test(url)) {
    return message.reply("Ce lien n'est pas un lien YouTube valide.");
  }

  try {
    const title = await getVideoTitle(url);
    const track = { url, title, customName: null, requestedBy: message.author.tag };

    const queue = getQueue(message.guild.id);
    queue.push(track);
    message.reply(`Ajouté à la playlist (position ${queue.length}) : **${displayName(track)}**`);
  } catch (err) {
    console.error('[handleAdd] Erreur :', err);
    message.reply("Impossible d'ajouter cette vidéo. Vérifie le lien et réessaie.");
  }
}

async function handleJouer(message) {
  const queue = getQueue(message.guild.id);

  const existingEntry = guildPlayers.get(message.guild.id);
  if (existingEntry && existingEntry.current) {
    return message.reply('Une lecture est déjà en cours. Utilise `+stop` avant de relancer la playlist.');
  }

  if (queue.length === 0) {
    return message.reply('Ta playlist est vide. Ajoute des morceaux avec `+add <lien>`.');
  }

  const entry = await ensureVoiceConnection(message);
  if (!entry) return;

  const first = entry.queue.shift();
  playTrackNow(entry, first, message.channel);
}

async function handleNowPlaying(message) {
  const entry = guildPlayers.get(message.guild.id);
  if (!entry || !entry.current) {
    return message.reply("Rien n'est en cours de lecture.");
  }
  message.reply(`En cours de lecture : **${displayName(entry.current)}**`);
}

async function handleQueue(message) {
  const queue = getQueue(message.guild.id);
  const entry = guildPlayers.get(message.guild.id);
  const current = entry?.current;

  if (!current && queue.length === 0) {
    return message.reply('La playlist est vide.');
  }

  const embed = new EmbedBuilder()
    .setTitle('🎵 Playlist')
    .setColor(0x5865f2);

  if (current) {
    embed.addFields({
      name: '▶️ En cours de lecture',
      value: displayName(current),
    });
  }

  if (queue.length > 0) {
    const lines = queue.map((track, i) => `**${i + 1}.** ${displayName(track)}`);
    embed.addFields({
      name: `À venir (${queue.length})`,
      value: lines.join('\n'),
    });
  } else {
    embed.addFields({ name: 'À venir', value: 'Aucun morceau en attente.' });
  }

  message.reply({ embeds: [embed] });
}

async function handleRemix(message) {
  const queue = getQueue(message.guild.id);
  if (queue.length < 2) {
    return message.reply("Il n'y a pas assez de morceaux dans la playlist pour la mélanger.");
  }

  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }

  message.reply('Playlist mélangée.');
}

async function handleRemove(message, indexArg) {
  const entry = guildPlayers.get(message.guild.id);
  if (!entry || entry.queue.length === 0) {
    return message.reply('La playlist est vide.');
  }

  const index = parseInt(indexArg, 10);
  if (!Number.isInteger(index) || index < 1 || index > entry.queue.length) {
    return message.reply(`Merci de donner un numéro valide entre 1 et ${entry.queue.length} (voir \`+queue\`).`);
  }

  const [removed] = entry.queue.splice(index - 1, 1);
  message.reply(`Retiré de la playlist : **${displayName(removed)}**`);
}

async function handleRename(message, indexArg, newName) {
  const entry = guildPlayers.get(message.guild.id);
  if (!entry || entry.queue.length === 0) {
    return message.reply('La playlist est vide.');
  }

  const index = parseInt(indexArg, 10);
  if (!Number.isInteger(index) || index < 1 || index > entry.queue.length) {
    return message.reply(`Merci de donner un numéro valide entre 1 et ${entry.queue.length} (voir \`+queue\`).`);
  }
  if (!newName) {
    return message.reply('Merci de donner un nouveau nom. Exemple : `+rename 2 Ma chanson`');
  }

  const track = entry.queue[index - 1];
  const oldName = displayName(track);
  track.customName = newName;
  message.reply(`Renommé : **${oldName}** → **${newName}**`);
}

async function handleSkip(message) {
  const entry = guildPlayers.get(message.guild.id);
  if (!entry || !entry.current) {
    return message.reply("Rien n'est en cours de lecture.");
  }
  if (entry.queue.length === 0) {
    return message.reply("Il n'y a pas de playlist en cours, `+skip` n'est disponible que si une playlist existe (voir `+add`).");
  }

  message.reply(`Morceau passé : **${displayName(entry.current)}**`);
  entry.player.stop(); // déclenche Idle -> playNextOrCleanup joue le morceau suivant
}

async function handleStop(message) {
  const entry = guildPlayers.get(message.guild.id);
  if (!entry) {
    return message.reply('Je ne suis dans aucun salon vocal.');
  }

  entry.stoppingManually = true;
  entry.player.stop();
  cleanup(message.guild.id);
  message.reply('Musique arrêtée, je quitte le salon vocal.');
}

async function handlePause(message) {
  const entry = guildPlayers.get(message.guild.id);
  if (!entry) {
    return message.reply('Je ne suis dans aucun salon vocal.');
  }

  if (entry.player.state.status === AudioPlayerStatus.Playing) {
    entry.player.pause();
    message.reply('Musique en pause.');
  } else if (entry.player.state.status === AudioPlayerStatus.Paused) {
    entry.player.unpause();
    message.reply('Musique reprise.');
  } else {
    message.reply("Il n'y a rien à mettre en pause pour le moment.");
  }
}

async function handleHelp(message) {
  const embed = new EmbedBuilder()
    .setTitle('🎵 Commandes du bot')
    .setColor(0x5865f2)
    .addFields(
      {
        name: '🎧 Musique solo',
        value:
          '`+play <lien>` — joue un lien immédiatement (interrompt ce qui joue)\n' +
          '`+pause` — met la musique en pause, ou la reprend\n' +
          '`+stop` — arrête la musique et quitte le salon vocal',
      },
      {
        name: '📜 Playlist',
        value:
          '`+add <lien>` — ajoute un morceau à la playlist\n' +
          '`+np` — affiche le morceau en cours\n' +
          '`+queue` — affiche la playlist\n' +
          '`+remix` — mélange la playlist\n' +
          '`+remove <numéro>` — supprime un morceau de la playlist\n' +
          '`+rename <numéro> <nouveau nom>` — renomme un morceau de la playlist\n' +
          '`+skip` — passe au morceau suivant (playlist requise)',
      }
    );

  message.reply({ embeds: [embed] });
}

client.login(process.env.SUBBOT_TOKEN);

// Arrêt propre quand le manager coupe ce processus (+mybot stop, expiration, etc.)
process.on('SIGTERM', () => {
  console.log('[music-bot] Arrêt demandé, déconnexion...');
  client.destroy();
  process.exit(0);
});
