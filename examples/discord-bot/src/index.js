import { Client, Events, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
import { config } from './config.js';
import { chat, listModels } from './llm.js';
import { getHistory, addTurn, resetHistory } from './history.js';
import { splitMessage } from './split.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // must also be enabled in the Developer Portal
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // needed to receive DMs
});

let modelCache = { ids: [], at: 0 };
async function cachedModels() {
  if (Date.now() - modelCache.at > 5 * 60_000) {
    modelCache = { ids: ['auto', 'auto:fast', 'auto:coding', ...(await listModels())], at: Date.now() };
  }
  return modelCache.ids;
}

async function answer(channelId, author, prompt, model) {
  const content = `${author}: ${prompt}`;
  const { text } = await chat([...getHistory(channelId), { role: 'user', content }], model);
  addTurn(channelId, content, text);
  return text;
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} — using ${config.baseUrl} (model: ${config.model})`);
});

// Reply to @mentions, DMs, and messages in auto-reply channels.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM;
  const mentioned = message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
  const autoReply = config.autoReplyChannels.has(message.channelId);
  if (!isDM && !mentioned && !autoReply) return;

  const prompt = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  if (!prompt) {
    await message.reply('Hi! Ask me anything — mention me with a question, or use `/ask`.');
    return;
  }

  await message.channel.sendTyping().catch(() => {});
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8_000);
  try {
    const text = await answer(message.channelId, message.member?.displayName ?? message.author.username, prompt);
    const [first, ...rest] = splitMessage(text);
    await message.reply({ content: first, allowedMentions: { repliedUser: false, parse: [] } });
    for (const chunk of rest) await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(err);
    await message.reply('⚠️ Sorry, I could not get a response from the AI right now.').catch(() => {});
  } finally {
    clearInterval(typing);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused().toLowerCase();
    const ids = await cachedModels().catch(() => ['auto']);
    await interaction
      .respond(ids.filter((id) => id.toLowerCase().includes(focused)).slice(0, 25).map((id) => ({ name: id, value: id })))
      .catch(() => {});
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'ask': {
        await interaction.deferReply();
        const prompt = interaction.options.getString('prompt', true);
        const model = interaction.options.getString('model') || undefined;
        const name = interaction.member?.displayName ?? interaction.user.username;
        const text = await answer(interaction.channelId, name, prompt, model);
        const header = `> **${name}:** ${prompt.slice(0, 300)}\n\n`;
        const [first, ...rest] = splitMessage(header + text);
        await interaction.editReply({ content: first, allowedMentions: { parse: [] } });
        for (const chunk of rest) await interaction.followUp({ content: chunk, allowedMentions: { parse: [] } });
        break;
      }
      case 'reset':
        resetHistory(interaction.channelId);
        await interaction.reply('🧹 Memory cleared for this channel.');
        break;
      case 'models': {
        await interaction.deferReply({ ephemeral: true });
        const ids = await listModels();
        const list = ids.length ? ids.map((id) => `\`${id}\``).join(', ') : 'No ready models.';
        await interaction.editReply(splitMessage(`**${ids.length} models ready:** ${list}`)[0]);
        break;
      }
    }
  } catch (err) {
    console.error(err);
    const msg = '⚠️ Something went wrong talking to the AI.';
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
});

client.login(config.discordToken);
