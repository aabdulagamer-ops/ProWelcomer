import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'prowelcomer.json');
const ALLOWED_IMAGE_HOSTS = new Set([
  'files.yapper.website',
  'i.imgur.com',
  'media.tenor.com',
  'media.giphy.com',
  'i.giphy.com',
  'upload.wikimedia.org',
  'raw.githubusercontent.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'i.ytimg.com',
  'cdn.discordapp.com',
  'media.discordapp.net',
  'pbs.twimg.com',
  'i.redd.it',
  'static-cdn.jtvnw.net',
  'i.scdn.co',
  's4.anilist.co',
  'cdn.myanimelist.net',
  'nekos.best',
  'cdn.weeb.sh',
]);

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  channelId: null,
  title: '🎉 Welcome to {server_name}, {player_name}!',
  message: "We're happy to have you here! 👋\n\n✨ You're member number {member_count}.\n\n📜 Check out the server rules and enjoy your stay!\n\n❤️ Welcome to the community!",
  description: '',
  footer: '',
  imageId: null,
  imageUrl: null,
  showMemberCount: true,
});

const LIMITS = Object.freeze({ title: 256, message: 2500, description: 1500, footer: 1000 });

function text(value) {
  return String(value ?? '').trim();
}

function fit(value, max) {
  return text(value).slice(0, max);
}

function summaryText(value, max) {
  const compact = text(value).replace(/\s+/g, ' ');
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function normalizeStoredSettings(input = {}) {
  let imageId = null;
  if (input.imageId) {
    try { imageId = normalizeImageId(input.imageId); } catch { imageId = null; }
  }
  let imageUrl = null;
  if (input.imageUrl) {
    try {
      const url = new URL(input.imageUrl);
      if (url.protocol === 'https:' && ALLOWED_IMAGE_HOSTS.has(url.hostname.toLowerCase()) && !url.username && !url.password) {
        imageUrl = url.href;
      }
    } catch { /* ignore stale or malformed URL values from local settings */ }
  }
  return {
    enabled: input.enabled === true,
    channelId: typeof input.channelId === 'string' && input.channelId ? input.channelId : null,
    title: fit(input.title || DEFAULT_SETTINGS.title, LIMITS.title),
    message: fit(input.message ?? DEFAULT_SETTINGS.message, LIMITS.message),
    description: fit(input.description, LIMITS.description),
    footer: fit(input.footer, LIMITS.footer),
    imageId: imageUrl ? null : imageId,
    imageUrl,
    showMemberCount: input.showMemberCount !== false,
  };
}

/** Accept the attachment_path returned by Yapper, or its full files.yapper.website URL. */
export function normalizeImageId(value) {
  let raw = text(value);
  if (!raw) throw new Error('Enter a Yapper attachment image ID or attachment path.');

  if (/^https:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw new Error('That image URL is not valid.'); }
    if (url.hostname.toLowerCase() !== 'files.yapper.website' || url.search || url.hash) {
      throw new Error('Use a Yapper attachment image ID or a files.yapper.website/attachments URL.');
    }
    const match = /^\/attachments\/([^/]+)$/i.exec(url.pathname);
    if (!match) throw new Error('The Yapper image URL must point to /attachments/<image-id>.');
    try { raw = decodeURIComponent(match[1]); } catch { throw new Error('That image ID is not valid.'); }
  } else {
    raw = raw.replace(/^\/?attachments\//i, '');
  }

  if (!/^[a-z0-9._-]{1,200}$/i.test(raw) || raw === '.' || raw === '..') {
    throw new Error('Image IDs may contain only letters, numbers, dots, underscores, and hyphens.');
  }
  return raw;
}

export function imageUrlForId(imageId) {
  const id = normalizeImageId(imageId);
  return `https://files.yapper.website/attachments/${encodeURIComponent(id)}`;
}

function parseImageUrl(value) {
  let url;
  try { url = new URL(text(value)); } catch { throw new Error('Enter a complete public HTTP or HTTPS image URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use a public HTTP or HTTPS image URL without a username or password.');
  }
  url.hash = '';
  if (!ALLOWED_IMAGE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Yapper only displays images from supported hosts. Try an HTTPS direct image link from i.imgur.com, media.tenor.com, media.giphy.com, upload.wikimedia.org, raw.githubusercontent.com, avatars.githubusercontent.com, i.ytimg.com, cdn.discordapp.com, pbs.twimg.com, i.redd.it, or Yapper uploads.');
  }
  return url;
}

/** Check a direct image URL and return its final HTTPS URL for Yapper's embed. */
export async function validateImageUrl(value, { fetchImpl = fetch } = {}) {
  const inputUrl = parseImageUrl(value);
  let response;
  try {
    response = await fetchImpl(inputUrl.href, {
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error('Could not reach that image URL. Make sure it is public and try again.');
  }

  try {
    if (!response.ok) {
      throw new Error(`That image URL returned HTTP ${response.status}. Make sure it is public and points directly to an image.`);
    }
    let finalUrl;
    try { finalUrl = new URL(response.url || inputUrl.href); } catch { throw new Error('The image host returned an invalid URL.'); }
    if (finalUrl.protocol !== 'https:') {
      throw new Error('Yapper embed images must use HTTPS. Use an HTTPS image URL or one that redirects to HTTPS.');
    }
    if (!ALLOWED_IMAGE_HOSTS.has(finalUrl.hostname.toLowerCase()) || finalUrl.username || finalUrl.password) {
      throw new Error('That image URL redirects to a host Yapper does not allow. Use an HTTPS image URL from a supported image host.');
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new Error('That URL does not return an image. Use a direct link whose content type is image/* (for example, PNG, JPG, GIF, or WebP).');
    }
    finalUrl.hash = '';
    return finalUrl.href;
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

/** Check the public Yapper attachment URL and its image content type without downloading the file. */
export async function validateImageId(value) {
  const id = normalizeImageId(value);
  const url = imageUrlForId(id);
  let response;
  try {
    response = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error('Could not reach Yapper to verify that image. Try again when the bot is online.');
  }

  try {
    if (!response.ok) throw new Error('Yapper could not find that uploaded image. Check the image ID and try again.');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new Error('That Yapper attachment is not an image. Choose a PNG, JPG, GIF, or WebP image.');
    }
  } finally {
    await response.body?.cancel().catch(() => {});
  }
  return id;
}

export function renderTemplate(template, info, showMemberCount = true) {
  let source = String(template ?? '');
  if (!showMemberCount && source.includes('{member_count}')) {
    source = source.replace(/^.*\{member_count\}.*(?:\r?\n|$)/gm, '');
  }
  const playerName = text(info.playerName) || 'new member';
  const serverName = text(info.serverName) || 'the server';
  const count = Number(info.memberCount);
  const memberCount = Number.isSafeInteger(count) && count >= 0 ? String(count) : 'not available';
  return source
    .replace(/\{player_name\}/gi, playerName)
    .replace(/\{server_name\}/gi, serverName)
    .replace(/\{member_count\}/gi, memberCount)
    .replace(/\{[^{}\r\n]+\}/g, '')
    .trim();
}

export function renderWelcomeEmbed(settingsInput, info, { test = false, includeImage = true } = {}) {
  const settings = normalizeStoredSettings(settingsInput);
  const title = renderTemplate(settings.title, info, settings.showMemberCount);
  const body = renderTemplate(settings.message, info, settings.showMemberCount);
  const customDescription = renderTemplate(settings.description, info, settings.showMemberCount);
  const description = [body, customDescription ? `**About this server**\n${customDescription}` : '']
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4096);

  const fields = [
    { name: 'Member', value: text(info.playerName) || 'New member', inline: true },
    { name: 'Server', value: text(info.serverName) || 'Community', inline: true },
  ];
  if (settings.showMemberCount && Number.isSafeInteger(Number(info.memberCount)) && !settings.message.includes('{member_count}')) {
    fields.push({ name: 'Member count', value: String(info.memberCount), inline: true });
  }
  if (test) {
    fields.push({
      name: 'Preview',
      value: '🧪 This is a test preview. No member joined.',
      inline: false,
    });
  }

  const embed = { title: (test ? `🧪 TEST · ${title}` : title).slice(0, 256), description, color: '#5865f2', fields };
  const footer = renderTemplate(settings.footer, info, settings.showMemberCount);
  if (footer) embed.footer = { text: footer.slice(0, 1000) };
  const imageUrl = settings.imageUrl || (settings.imageId ? imageUrlForId(settings.imageId) : null);
  if (includeImage && imageUrl) embed.image = { url: imageUrl };
  return embed;
}

function errorMessage(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 500);
}

function channelListText(channels) {
  if (!channels.length) return 'I cannot see any text channels in this server. Give ProWelcomer access to a text channel and try again.';
  const visible = channels.slice(0, 15).map((channel) => `• #${channel.name} — ${channel.id}`).join('\n');
  const extra = channels.length > 15 ? `\n…and ${channels.length - 15} more.` : '';
  return `Choose a visible text channel by name or ID, then run \`/welcome activate <channel-name-or-id>\`.\n${visible}${extra}`;
}

function readSubcommand(args) {
  const input = text(args);
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input);
  return match ? { name: match[1].toLowerCase(), rest: text(match[2]) } : { name: '', rest: '' };
}

export async function attachWelcomeSystem(bot, {
  storagePath = DATA_FILE,
  imageValidator = validateImageId,
  imageUrlValidator = validateImageUrl,
  logger = console,
} = {}) {
  const state = { version: 1, servers: {} };

  try {
    const stored = JSON.parse(await readFile(storagePath, 'utf8'));
    if (stored && stored.servers && typeof stored.servers === 'object') {
      for (const [serverId, settings] of Object.entries(stored.servers)) {
        state.servers[serverId] = normalizeStoredSettings(settings);
      }
    } else {
      logger.warn?.('[ProWelcomer] Ignoring a settings file with an unsupported format.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.error?.('[ProWelcomer] Could not read saved settings; starting with defaults:', errorMessage(error));
    }
  }

  let writeQueue = Promise.resolve();
  async function persist() {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    const nextWrite = writeQueue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(storagePath), { recursive: true });
      const tempPath = `${storagePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, serialized, 'utf8');
      await rename(tempPath, storagePath);
    });
    writeQueue = nextWrite;
    return nextWrite;
  }

  function getSettings(serverId) {
    return normalizeStoredSettings(state.servers[serverId] || DEFAULT_SETTINGS);
  }

  async function saveSettings(serverId, patch) {
    const oldValue = state.servers[serverId];
    state.servers[serverId] = normalizeStoredSettings({ ...getSettings(serverId), ...patch });
    try {
      await persist();
    } catch (error) {
      if (oldValue === undefined) delete state.servers[serverId];
      else state.servers[serverId] = oldValue;
      throw error;
    }
    return getSettings(serverId);
  }

  async function reply(msg, message) {
    try { await msg.reply(message); } catch (error) {
      logger.error?.('[ProWelcomer] Could not send a command response:', errorMessage(error));
    }
  }

  async function isServerAdmin(msg) {
    if (!msg.server_id || !msg.author_id) return false;
    const server = await bot.server(msg.server_id);
    if (server?.owner_id === msg.author_id) return true;
    const [member, roles] = await Promise.all([
      bot.member(msg.server_id, msg.author_id),
      bot.roles(msg.server_id),
    ]);
    const roleIds = new Set(Array.isArray(member?.roles) ? member.roles : []);
    return (Array.isArray(roles) ? roles : []).some((role) => roleIds.has(role.id) && role.manage_server === true);
  }

  async function adminRequired(msg) {
    if (!msg.server_id) {
      await reply(msg, 'ProWelcomer settings only work inside a server.');
      return false;
    }
    let allowed = false;
    try { allowed = await isServerAdmin(msg); } catch {
      await reply(msg, 'I could not verify your server permissions. Please try again in a moment.');
      return false;
    }
    if (!allowed) await reply(msg, 'Only the server owner or a member with Manage Server can change ProWelcomer settings.');
    return allowed;
  }

  async function resolveChannel(serverId, selection) {
    const channels = await bot.channels(serverId, { type: 'text' });
    if (!selection) return { channel: null, channels };
    let wanted = text(selection).replace(/^['"]|['"]$/g, '');
    const mention = /^<#([^>]+)>$/.exec(wanted);
    if (mention) wanted = mention[1];
    else if (wanted.startsWith('#')) wanted = wanted.slice(1);

    const byId = channels.find((channel) => channel.id === wanted);
    if (byId) return { channel: byId, channels };
    const byName = channels.filter((channel) => String(channel.name).toLowerCase() === wanted.toLowerCase());
    if (byName.length === 1) return { channel: byName[0], channels };
    return { channel: null, channels, ambiguous: byName.length > 1 };
  }

  async function sendWelcome(channelId, settings, info, { test = false } = {}) {
    const endpoint = `/channels/${encodeURIComponent(channelId)}/messages`;
    const withImage = renderWelcomeEmbed(settings, info, { test, includeImage: true });
    try {
      await bot.api('POST', endpoint, { content: '', embeds: [withImage] });
      return Boolean(settings.imageUrl || settings.imageId);
    } catch (error) {
      // Yapper rejects an unsupported/unavailable embed image with HTTP 400. The message itself can still be sent.
      if (!(settings.imageUrl || settings.imageId) || error?.status !== 400) throw error;
      const withoutImage = renderWelcomeEmbed(settings, info, { test, includeImage: false });
      await bot.api('POST', endpoint, { content: '', embeds: [withoutImage] });
      return false;
    }
  }

  async function handleWelcome(msg) {
    const { name, rest } = readSubcommand(msg.args);
    if (!name || name === 'help') {
      await reply(msg, 'Use `/welcome settings` to view the current setup, or `/help` for all commands and placeholders.');
      return;
    }
    if (!msg.server_id) {
      await reply(msg, 'ProWelcomer settings only work inside a server.');
      return;
    }

    if (name === 'settings') {
      const settings = getSettings(msg.server_id);
      let channelLabel = settings.channelId ? summaryText(settings.channelId, 160) : 'not selected';
      const imageLabel = settings.imageUrl
        ? (() => { try { const url = new URL(settings.imageUrl); return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`; } catch { return 'invalid URL'; } })()
        : settings.imageId ? `Yapper image ID: ${settings.imageId}` : 'not set';
      if (settings.channelId) {
        try {
          const channel = await bot.channel(settings.channelId);
          if (channel?.server_id === msg.server_id) channelLabel = summaryText(`#${channel.name} (${channel.id})`, 160);
        } catch { /* show the saved channel ID below */ }
      }
      await reply(msg, [
        `**ProWelcomer settings — ${settings.enabled ? 'enabled' : 'disabled'}**`,
        `Channel: ${channelLabel}`,
        `Title: ${summaryText(settings.title, 200)}`,
        `Message: ${summaryText(settings.message, 650)}`,
        `Description: ${summaryText(settings.description || 'not set', 400)}`,
        `Footer: ${summaryText(settings.footer || 'not set', 180)}`,
        `Image: ${summaryText(imageLabel, 180)}`,
        `Member count: ${settings.showMemberCount ? 'shown when available' : 'hidden'}`,
      ].join('\n'));
      return;
    }

    if (name === 'test' || name === 'activate' || name === 'deactivate' || name === 'message' ||
        name === 'description' || name === 'footer' || name === 'image' || name === 'removeimage' ||
        name === 'reset' || name === 'count') {
      if (!(await adminRequired(msg))) return;
    } else {
      await reply(msg, 'Unknown `/welcome` action. Use `/help` to see the supported commands.');
      return;
    }

    if (name === 'activate') {
      let resolved;
      try { resolved = await resolveChannel(msg.server_id, rest); } catch {
        await reply(msg, 'I could not load this server’s text channels. Check that ProWelcomer can see the channel and try again.');
        return;
      }
      if (!resolved.channel) {
        const prompt = resolved.ambiguous
          ? `That channel name is ambiguous. Use its channel ID instead.\n${channelListText(resolved.channels)}`
          : channelListText(resolved.channels);
        await reply(msg, prompt);
        return;
      }
      await saveSettings(msg.server_id, { enabled: true, channelId: resolved.channel.id });
      await reply(msg, `✅ ProWelcomer is active in **#${resolved.channel.name}** (${resolved.channel.id}).`);
      return;
    }

    if (name === 'deactivate') {
      const current = getSettings(msg.server_id);
      if (!current.enabled) {
        await reply(msg, 'ProWelcomer is already disabled. Your saved channel and customization are preserved.');
        return;
      }
      await saveSettings(msg.server_id, { enabled: false });
      await reply(msg, '⏸️ ProWelcomer is disabled. Your saved channel and customization are preserved.');
      return;
    }

    if (name === 'test') {
      const settings = getSettings(msg.server_id);
      if (!settings.channelId) {
        await reply(msg, 'No welcome channel is configured yet. Run `/welcome activate <channel-name-or-id>` first.');
        return;
      }
      let server = {};
      try { server = await bot.server(msg.server_id) || {}; } catch { /* use the fallback label */ }
      const rawCount = Number(server.member_count);
      const info = {
        playerName: 'Alex Example',
        serverName: text(server.name) || 'Your server',
        memberCount: Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : 42,
      };
      try {
        const imageIncluded = await sendWelcome(settings.channelId, settings, info, { test: true });
        await reply(msg, `🧪 Preview sent to the configured channel${(settings.imageUrl || settings.imageId) && !imageIncluded ? ' without its image' : ''}.`);
      } catch {
        await reply(msg, 'I could not send the preview. Check that ProWelcomer can post in the configured channel.');
      }
      return;
    }

    if (name === 'message') {
      if (!rest) {
        await reply(msg, 'Usage: `/welcome message title <title>`, `/welcome message body <template>`, or `/welcome message <title> | <template>`.');
        return;
      }
      const current = getSettings(msg.server_id);
      let patch;
      if (/^title\s+/i.test(rest)) {
        patch = { title: fit(rest.replace(/^title\s+/i, ''), LIMITS.title) };
      } else if (/^body\s+/i.test(rest)) {
        patch = { message: fit(rest.replace(/^body\s+/i, ''), LIMITS.message) };
      } else {
        const separator = rest.indexOf('|');
        if (separator >= 0) {
          const title = fit(rest.slice(0, separator), LIMITS.title);
          const body = fit(rest.slice(separator + 1), LIMITS.message);
          if (!title || !body) {
            await reply(msg, 'Provide both a title and a message around `|`.');
            return;
          }
          patch = { title, message: body };
        } else {
          patch = { message: fit(rest, LIMITS.message) };
        }
      }
      if ((patch.title !== undefined && !patch.title) || (patch.message !== undefined && !patch.message)) {
        await reply(msg, 'Title and message cannot be empty.');
        return;
      }
      await saveSettings(msg.server_id, patch);
      await reply(msg, `✅ Welcome ${patch.title !== undefined && patch.message !== undefined ? 'title and message' : patch.title !== undefined ? 'title' : 'message'} saved.`);
      return;
    }

    if (name === 'description' || name === 'footer') {
      const field = name;
      if (!rest) {
        await reply(msg, `Usage: /welcome ${name} <text> or /welcome ${name} clear.`);
        return;
      }
      const value = /^clear$/i.test(rest) ? '' : fit(rest, LIMITS[field]);
      await saveSettings(msg.server_id, { [field]: value });
      await reply(msg, value ? `✅ Welcome ${field} saved.` : `✅ Welcome ${field} cleared.`);
      return;
    }

    if (name === 'image') {
      if (!rest) {
        await reply(msg, 'Usage: `/welcome image <image-url>` for a public image, or `/welcome image <image-id-or-message-id>` for an existing Yapper upload.');
        return;
      }
      if (/^https?:/i.test(rest)) {
        let imageUrl;
        try { imageUrl = await imageUrlValidator(rest); } catch (error) {
          await reply(msg, errorMessage(error));
          return;
        }
        await saveSettings(msg.server_id, { imageUrl, imageId: null });
        await reply(msg, '✅ Welcome image URL saved and verified.');
        return;
      }
      let imageId;
      const isMessageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rest);
      if (isMessageId && msg.channel_id && typeof bot.message === 'function') {
        try {
          const source = await bot.message(msg.channel_id, rest);
          const attachmentPath = source?.attachment_path || source?.message?.attachment_path;
          if (attachmentPath) imageId = await imageValidator(attachmentPath);
        } catch { /* It may be an attachment ID itself; validate that next. */ }
      }
      if (!imageId) {
        try { imageId = await imageValidator(rest); } catch (error) {
          await reply(msg, errorMessage(error));
          return;
        }
      }
      await saveSettings(msg.server_id, { imageId, imageUrl: null });
      await reply(msg, `✅ Welcome image saved (ID: ${imageId}).`);
      return;
    }

    if (name === 'removeimage') {
      await saveSettings(msg.server_id, { imageId: null, imageUrl: null });
      await reply(msg, '✅ The custom welcome image has been removed.');
      return;
    }

    if (name === 'count') {
      const value = rest.toLowerCase();
      if (!['on', 'off'].includes(value)) {
        await reply(msg, 'Usage: `/welcome count on` or `/welcome count off`.');
        return;
      }
      await saveSettings(msg.server_id, { showMemberCount: value === 'on' });
      await reply(msg, `✅ Member count will be ${value === 'on' ? 'shown when available' : 'hidden'}.`);
      return;
    }

    if (name === 'reset') {
      await saveSettings(msg.server_id, { ...DEFAULT_SETTINGS });
      await reply(msg, '✅ Welcome settings reset. The system is disabled until you activate it in a channel.');
    }
  }

  bot.command('welcome', 'Configure the server welcome message', async (msg) => {
    try { await handleWelcome(msg); } catch (error) {
      logger.error?.('[ProWelcomer] Welcome command failed:', errorMessage(error));
      await reply(msg, 'I could not save or load that setting. Check the bot’s access and local data folder, then try again.');
    }
  });

  bot.command('help', 'Show ProWelcomer commands and placeholders', async (msg) => {
    await reply(msg, [
      '**ProWelcomer commands**',
      '`/welcome activate <channel-name-or-id>` — choose a visible text channel and enable welcomes.',
      '`/welcome deactivate` — disable welcomes while keeping the saved settings.',
      '`/welcome settings` — view the server configuration.',
      '`/welcome test` — send a labelled sample preview to the configured channel.',
      '`/welcome message title <text>` or `/welcome message body <template>` — customize the title or message.',
      '`/welcome message <title> | <template>` — set both at once.',
      '`/welcome description <text|clear>` and `/welcome footer <text|clear>` — set or clear optional text.',
      '`/welcome image <image-url>` — set a verified public image URL. `/welcome image <image-id-or-message-id>` still accepts a Yapper upload. `/welcome removeimage` clears it.',
      '`/welcome count on|off` — show the count when available, or hide it.',
      '`/welcome reset` — restore defaults and disable the system.',
      '`/help` — show this guide.',
      '',
      '**Placeholders:** `{player_name}` is the joining member, `{server_name}` is the server, and `{member_count}` is the count from Yapper when supplied. Unknown values use a readable fallback; turning count off removes its template line.',
      'Only the server owner or someone with Manage Server can change settings or send a test. Yapper’s current bot command format has no channel dropdown, so activation accepts a text channel name or ID. Image URLs must be public, return an image, use HTTPS after redirects, and come from a host Yapper allows (such as i.imgur.com or Yapper uploads); existing attachment and message ID inputs remain supported.',
    ].join('\n'));
  });

  bot.on('member_join', async (event) => {
    if (!event?.server_id || !event?.user_id) return;
    const settings = getSettings(event.server_id);
    if (!settings.enabled || !settings.channelId) return;

    let server = {};
    try { server = await bot.server(event.server_id) || {}; } catch { /* sensible server-name fallback */ }
    const rawCount = Number(event.member_count ?? server.member_count);
    const info = {
      playerName: text(event.username) || 'new member',
      serverName: text(server.name) || 'the server',
      memberCount: Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : undefined,
    };
    try {
      await sendWelcome(settings.channelId, settings, info);
    } catch (error) {
      logger.error?.('[ProWelcomer] Could not send a join welcome:', errorMessage(error));
    }
  });

  return { getSettings, saveSettings, handleWelcome, sendWelcome };
}
