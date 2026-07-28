require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('cree-licence')
    .setDescription('Crée un code de licence pour un bot (rôle autorisé requis)')
    .addStringOption((opt) =>
      opt
        .setName('type')
        .setDescription('Type de bot')
        .setRequired(true)
        .addChoices({ name: 'Music', value: 'music' }, { name: 'IA', value: 'ia' }, { name: 'Gestion', value: 'gestion' })
    )
    .addIntegerOption((opt) =>
      opt.setName('jours').setDescription('Durée de la licence en jours').setRequired(true).setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('supprime-licence')
    .setDescription('Supprime une licence et coupe le bot lié (rôle autorisé requis)')
    .addStringOption((opt) => opt.setName('licence-id').setDescription('Le code de licence').setRequired(true)),

  new SlashCommandBuilder()
    .setName('prolonge-licence')
    .setDescription('Ajoute des jours à une licence existante (rôle autorisé requis)')
    .addStringOption((opt) => opt.setName('licence-id').setDescription('Le code de licence').setRequired(true))
    .addIntegerOption((opt) =>
      opt.setName('jours').setDescription('Jours à ajouter').setRequired(true).setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('liste-licences')
    .setDescription('Liste toutes les licences (rôle autorisé requis)'),

  new SlashCommandBuilder()
    .setName('active-bot')
    .setDescription('Active ton bot avec ton token et ton code de licence')
    .addStringOption((opt) => opt.setName('token').setDescription('Token de ton bot Discord').setRequired(true))
    .addStringOption((opt) =>
      opt.setName('licence-id').setDescription('Le code de licence reçu').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('mybot')
    .setDescription('Gère ton bot')
    .addStringOption((opt) =>
      opt
        .setName('action')
        .setDescription('Action à effectuer')
        .setRequired(true)
        .addChoices(
          { name: 'start', value: 'start' },
          { name: 'stop', value: 'stop' },
          { name: 'status', value: 'status' }
        )
    ),
].map((cmd) => cmd.toJSON());

const rest = new REST().setToken(process.env.MANAGER_TOKEN);

(async () => {
  try {
    console.log('Déploiement des commandes slash...');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), {
      body: commands,
    });
    console.log('Commandes déployées avec succès.');
  } catch (err) {
    console.error(err);
  }
})();
