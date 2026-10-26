// ProWelcomer — ProsepStudios
// Requires Node.js 18+ and the official yapper.js SDK beside this file.
import { Bot } from './yapper.js';
import { attachWelcomeSystem } from './prowelcomer.js';

const token = process.env.YAPPER_BOT_TOKEN;
if (!token) {
  console.error('Set YAPPER_BOT_TOKEN in this PowerShell session before starting ProWelcomer.');
  process.exit(1);
}

const bot = new Bot(token);

// Keep the original starter commands working.
bot.command('ping', 'Is ProWelcomer online?', (msg) => msg.reply('pong 🏓'));

bot.command('roll', 'Roll a die, like /roll 20', (msg) => {
  const n = Number(msg.argv[0]);
  const sides = Number.isSafeInteger(n) && n >= 2 && n <= 1000 ? n : 6;
  msg.reply(`🎲 ${1 + Math.floor(Math.random() * sides)} (d${sides})`);
});

// Keep the original mention response.
bot.on('message', (msg) => {
  if (msg.mentioned) msg.reply(`hey ${msg.authorMention}, try /help`);
});

await attachWelcomeSystem(bot);

bot.on('error', (error) => {
  const safeMessage = String(error?.message || error || 'Unknown error').replaceAll(token, '[redacted]');
  console.error('[ProWelcomer]', safeMessage);
});

bot.start().catch((error) => {
  const safeMessage = String(error?.message || error || 'Unknown error').replaceAll(token, '[redacted]');
  console.error('[ProWelcomer] Could not start:', safeMessage);
  process.exitCode = 1;
});
