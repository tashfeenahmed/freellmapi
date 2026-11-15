import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';

const rest = new REST().setToken(config.discordToken);
const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

await rest.put(route, { body: commands });
console.log(`Registered ${commands.length} slash commands ${config.guildId ? `in guild ${config.guildId}` : 'globally'}.`);
