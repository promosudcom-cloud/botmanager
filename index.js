require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const fs = require('fs');

const licenses = require('./lib/licenses');
const processManager = require('./lib/processManager');
const { startApiServer } = require('./lib/apiServer');

// Démarre le petit serveur HTTP interne utilisé par le site web pour créer
// une licence automatiquement après un paiement confirmé (voir lib/apiServer.js).
startApiServer();

const ALLOWED_ROLE_IDS = (process.env.ALLOWED_ROLE_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('clientReady', () => {
  console.log(`[manager] Connecté en tant que ${client.user.tag}`);
});

function hasManagerRole(member) {
  if (!member) return false;
  return member.roles.cache.some((role) => ALLOWED_ROLE_IDS.includes(role.id));
}

function formatDate(ms) {
  return new Date(ms).toLocaleString('fr-FR');
}

function typeLabel(type) {
  if (type === 'music') return 'Music';
  if (type === 'ia') return 'IA';
  if (type === 'gestion') return 'Gestion';
  return type;
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }
  } catch (err) {
    console.error('[manager] Erreur interaction :', err);
    const payload = { content: 'Une erreur est survenue.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

async function handleButton(interaction) {
  if (interaction.customId === 'gestion-config-buyer') {
    const modal = new ModalBuilder()
      .setCustomId('gestion-buyer-modal')
      .setTitle('Configurer un buyer');

    const idInput = new TextInputBuilder()
      .setCustomId('discord-id')
      .setLabel('ID Discord à ajouter comme buyer')
      .setPlaceholder('Ex : 123456789012345678')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(idInput));
    await interaction.showModal(modal);
  }
}

async function handleModalSubmit(interaction) {
  if (interaction.customId !== 'gestion-buyer-modal') return;

  const targetId = interaction.fields.getTextInputValue('discord-id').trim();

  if (!/^\d{15,20}$/.test(targetId)) {
    return interaction.reply({
      content: "Ça ne ressemble pas à un ID Discord valide (uniquement des chiffres, 15 à 20 caractères).",
      flags: MessageFlags.Ephemeral,
    });
  }

  const license = licenses.findByUser(interaction.user.id);
  if (!license || license.type !== 'gestion') {
    return interaction.reply({ content: "Tu n'as pas de bot de type Gestion activé.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const dataDir = processManager.getGestionDataDir(interaction.user.id);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = `${dataDir}/config.json`;

  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      config = {};
    }
  }

  if (!Array.isArray(config._globalBuyers)) config._globalBuyers = [];

  if (config._globalBuyers.some((b) => b.id === targetId)) {
    return interaction.editReply(`\`${targetId}\` est déjà configuré comme buyer.`);
  }

  config._globalBuyers.push({ id: targetId, addedAt: Date.now(), addedBy: interaction.user.id });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Si le bot tourne déjà, on le redémarre pour qu'il recharge la config.
  if (processManager.isRunning(interaction.user.id)) {
    await processManager.restart(interaction.user.id, license);
    return interaction.editReply(
      `✅ \`${targetId}\` ajouté comme buyer. Ton bot redémarre pour appliquer le changement.`
    );
  }

  return interaction.editReply(`✅ \`${targetId}\` ajouté comme buyer.`);
}

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === 'cree-licence') return handleCreeLicence(interaction);
  if (commandName === 'supprime-licence') return handleSupprimeLicence(interaction);
  if (commandName === 'prolonge-licence') return handleProlongeLicence(interaction);
  if (commandName === 'liste-licences') return handleListeLicences(interaction);
  if (commandName === 'active-bot') return handleActiveBot(interaction);
  if (commandName === 'mybot') return handleMybot(interaction);
}

// ---- Commandes admin (rôle autorisé requis) ----

async function handleCreeLicence(interaction) {
  if (!hasManagerRole(interaction.member)) {
    return interaction.reply({ content: "Tu n'as pas le rôle nécessaire pour cette commande.", flags: MessageFlags.Ephemeral });
  }

  const type = interaction.options.getString('type', true);
  const days = interaction.options.getInteger('jours', true);

  const license = licenses.create(type, days, interaction.user.id);

  const embed = new EmbedBuilder()
    .setTitle('✅ Licence créée')
    .setColor(0x57f287)
    .addFields(
      { name: 'Code de licence', value: `\`${license.id}\``, inline: true },
      { name: 'Type', value: typeLabel(type), inline: true },
      { name: 'Expire le', value: formatDate(license.expiresAt), inline: false }
    )
    .setDescription(
      'Donne ce code au client. Il doit ensuite faire `/active-bot token:<son token> licence-id:' +
        license.id +
        '` (réponse privée, personne d\'autre ne verra son token).'
    );

  // Ephemeral : le code de licence ne doit pas traîner publiquement dans le salon.
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleSupprimeLicence(interaction) {
  if (!hasManagerRole(interaction.member)) {
    return interaction.reply({ content: "Tu n'as pas le rôle nécessaire pour cette commande.", flags: MessageFlags.Ephemeral });
  }

  const licenceId = interaction.options.getString('licence-id', true).trim().toLowerCase();
  const license = licenses.get(licenceId);

  if (license?.userId) {
    processManager.stop(license.userId);
  }
  const existed = licenses.remove(licenceId);

  await interaction.reply({
    content: existed ? `Licence \`${licenceId}\` supprimée, le bot lié a été arrêté.` : `Licence \`${licenceId}\` introuvable.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleProlongeLicence(interaction) {
  if (!hasManagerRole(interaction.member)) {
    return interaction.reply({ content: "Tu n'as pas le rôle nécessaire pour cette commande.", flags: MessageFlags.Ephemeral });
  }

  const licenceId = interaction.options.getString('licence-id', true).trim().toLowerCase();
  const days = interaction.options.getInteger('jours', true);

  const license = licenses.extend(licenceId, days);
  if (!license) {
    return interaction.reply({ content: `Licence \`${licenceId}\` introuvable.`, flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({
    content: `Licence \`${licenceId}\` prolongée. Nouvelle expiration : ${formatDate(license.expiresAt)}.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleListeLicences(interaction) {
  if (!hasManagerRole(interaction.member)) {
    return interaction.reply({ content: "Tu n'as pas le rôle nécessaire pour cette commande.", flags: MessageFlags.Ephemeral });
  }

  const all = licenses.listAll();
  const ids = Object.keys(all);

  if (ids.length === 0) {
    return interaction.reply({ content: 'Aucune licence enregistrée.', flags: MessageFlags.Ephemeral });
  }

  const lines = ids.map((id) => {
    const l = all[id];
    const expired = licenses.isExpired(l) ? ' (expirée)' : '';
    const owner = l.userId ? `<@${l.userId}>` : '_non activée_';
    const running = l.userId && processManager.isRunning(l.userId) ? '🟢' : '⚪';
    return `\`${id}\` — ${typeLabel(l.type)} — ${owner} — expire le ${formatDate(l.expiresAt)}${expired} — ${running}`;
  });

  const embed = new EmbedBuilder().setTitle('📋 Licences').setColor(0x5865f2).setDescription(lines.join('\n'));

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---- Activation (côté client) ----

async function handleActiveBot(interaction) {
  const token = interaction.options.getString('token', true);
  const licenceId = interaction.options.getString('licence-id', true).trim().toLowerCase();

  const result = licenses.activate(licenceId, interaction.user.id, token);

  if (result.error === 'introuvable') {
    return interaction.reply({ content: `Le code de licence \`${licenceId}\` n'existe pas.`, flags: MessageFlags.Ephemeral });
  }
  if (result.error === 'expiree') {
    return interaction.reply({ content: `La licence \`${licenceId}\` a expiré.`, flags: MessageFlags.Ephemeral });
  }
  if (result.error === 'deja_utilisee') {
    return interaction.reply({ content: `La licence \`${licenceId}\` a déjà été activée.`, flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({
    content: `✅ Bot activé (type **${typeLabel(result.license.type)}**). Démarre-le avec \`/mybot action:start\`.`,
    flags: MessageFlags.Ephemeral,
  });
}

// ---- /mybot ----

async function handleMybot(interaction) {
  const action = interaction.options.getString('action', true);
  const userId = interaction.user.id;
  const license = licenses.findByUser(userId);

  if (!license) {
    return interaction.reply({
      content: "Tu n'as pas de bot activé. Utilise `/active-bot` avec ton token et ton code de licence.",
      flags: MessageFlags.Ephemeral,
    });
  }
  if (licenses.isExpired(license)) {
    return interaction.reply({ content: 'Ta licence a expiré.', flags: MessageFlags.Ephemeral });
  }

  if (action === 'start') {
    const result = processManager.start(userId, license);
    if (!result.ok && result.reason === 'deja_demarre') {
      return interaction.reply({ content: 'Ton bot est déjà démarré.', flags: MessageFlags.Ephemeral });
    }

    if (license.type === 'gestion') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('gestion-config-buyer')
          .setLabel('Configurer un buyer')
          .setStyle(ButtonStyle.Primary)
      );
      return interaction.reply({
        content:
          '✅ Ton bot démarre...\n\nTon bot a un système de "buyer" (accès à certaines commandes). ' +
          'Clique ci-dessous pour ajouter un ID Discord comme buyer.',
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({ content: '✅ Ton bot démarre...', flags: MessageFlags.Ephemeral });
  }

  if (action === 'stop') {
    const result = processManager.stop(userId);
    return interaction.reply({
      content: result.ok ? '🛑 Ton bot a été arrêté.' : "Ton bot n'est pas démarré.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'status') {
    const running = processManager.isRunning(userId);
    const embed = new EmbedBuilder()
      .setTitle('📊 Statut de ton bot')
      .setColor(0x5865f2)
      .addFields(
        { name: 'Type', value: typeLabel(license.type), inline: true },
        { name: 'État', value: running ? '🟢 En ligne' : '⚪ Arrêté', inline: true },
        { name: 'Expire le', value: formatDate(license.expiresAt), inline: false }
      );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

// Coupe proprement tous les sous-bots si le manager s'arrête.
process.on('SIGINT', () => {
  processManager.stopAll();
  process.exit(0);
});

// Vérifie régulièrement les licences expirées et coupe les bots concernés.
setInterval(() => {
  const all = licenses.listAll();
  for (const license of Object.values(all)) {
    if (license.userId && licenses.isExpired(license) && processManager.isRunning(license.userId)) {
      console.log(`[manager] Licence ${license.id} expirée, arrêt du bot de ${license.userId}.`);
      processManager.stop(license.userId);
    }
  }
}, 10 * 60 * 1000); // toutes les 10 minutes

client.login(process.env.MANAGER_TOKEN);
