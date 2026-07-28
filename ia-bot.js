// Template lancé par le Bot Manager pour un client ayant activé une licence
// de type "ia". Basé sur le bot IA fourni par Larcitoo (converti en
// CommonJS pour rester cohérent avec le reste du projet Bot Manager).
//
// - process.env.SUBBOT_TOKEN     -> le token Discord du client (fourni via /active-bot)
// - process.env.OPENROUTER_API_KEY -> la clé API OpenRouter du Manager (partagée, dans .env)

const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const prompt = fs.readFileSync(path.join(__dirname, 'prompts', 'system.txt'), 'utf8');

client.once('clientReady', () => {
  console.log(`[ia-bot] ${client.user.tag} connecté`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  const question = message.content
    .replace(`<@${client.user.id}>`, '')
    .replace(`<@!${client.user.id}>`, '')
    .trim();

  if (!question) return message.reply("Pose-moi une question après m'avoir mentionné.");

  await message.channel.sendTyping();

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: question },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const texte = response.data.choices[0].message.content;

    if (texte.length > 2000) {
      for (let i = 0; i < texte.length; i += 2000) {
        await message.reply(texte.slice(i, i + 2000));
      }
    } else {
      await message.reply(texte);
    }
  } catch (err) {
    console.log(err.response?.data || err);
    message.reply("Erreur avec l'IA.");
  }
});

client.login(process.env.SUBBOT_TOKEN);

// Arrêt propre quand le manager coupe ce processus (+mybot stop, expiration, etc.)
process.on('SIGTERM', () => {
  console.log('[ia-bot] Arrêt demandé, déconnexion...');
  client.destroy();
  process.exit(0);
});
