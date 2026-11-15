import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the AI a question')
    .addStringOption((o) => o.setName('prompt').setDescription('Your question').setRequired(true))
    .addStringOption((o) =>
      o.setName('model').setDescription('Model (default: router config)').setRequired(false).setAutocomplete(true),
    ),
  new SlashCommandBuilder().setName('reset').setDescription("Clear the bot's memory for this channel"),
  new SlashCommandBuilder().setName('models').setDescription('List models available on the FreeLLMAPI router'),
].map((c) => c.toJSON());
