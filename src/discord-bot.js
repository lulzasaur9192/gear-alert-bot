/**
 * Discord Bot for GearAlert — Reverb Price Tracking
 */

import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { createLogger } from './logger.js';
import { registerNotifier } from './price-checker.js';
import {
    getOrCreateUser, canCreateAlert, createAlert, getUserAlerts,
    removeAlert, getAlert, getPriceHistory, getStats, saveFeedback,
} from './db.js';
import { searchListing, SUPPORTED_GAMES as SUPPORTED_CATEGORIES } from './reverb.js';

const log = createLogger('discord');
let client = null;

function fmtPrice(price) {
    if (price === null || price === undefined) return 'N/A';
    return `$${Number(price).toFixed(2)}`;
}

function buildCommands() {
    const catChoices = SUPPORTED_CATEGORIES.map(c => ({ name: c.label, value: c.key }));

    return [
        new SlashCommandBuilder()
            .setName('alert')
            .setDescription('Set a price alert for gear on Reverb')
            .addStringOption(opt => opt.setName('gear').setDescription('What gear to track (e.g. "Korg Minilogue")').setRequired(true))
            .addNumberOption(opt => opt.setName('price').setDescription('Alert when price drops below this').setRequired(true))
            .addStringOption(opt => opt.setName('category').setDescription('Gear category').addChoices(...catChoices)),

        new SlashCommandBuilder()
            .setName('search')
            .setDescription('Search Reverb for gear and prices')
            .addStringOption(opt => opt.setName('gear').setDescription('What to search for').setRequired(true))
            .addStringOption(opt => opt.setName('category').setDescription('Gear category').addChoices(...catChoices)),

        new SlashCommandBuilder()
            .setName('list')
            .setDescription('View your active price alerts'),

        new SlashCommandBuilder()
            .setName('remove')
            .setDescription('Remove a price alert')
            .addIntegerOption(opt => opt.setName('id').setDescription('Alert ID (optional — shows picker if omitted)')),

        new SlashCommandBuilder()
            .setName('history')
            .setDescription('View price history for an alert (paid tier)')
            .addIntegerOption(opt => opt.setName('id').setDescription('Alert ID').setRequired(true)),

        new SlashCommandBuilder()
            .setName('upgrade')
            .setDescription('Info about upgrading to paid tier'),

        new SlashCommandBuilder()
            .setName('gearhelp')
            .setDescription('Show GearAlert Bot help'),

        new SlashCommandBuilder()
            .setName('gearstats')
            .setDescription('View bot statistics'),

        new SlashCommandBuilder()
            .setName('feedback')
            .setDescription('Send feedback or report an issue')
            .addStringOption(opt => opt.setName('message').setDescription('Your feedback or issue').setRequired(true)),
    ].map(cmd => cmd.toJSON());
}

async function registerCommands(token, appId) {
    const rest = new REST({ version: '10' }).setToken(token);
    try {
        log.info('Registering Discord slash commands...');
        await rest.put(Routes.applicationCommands(appId), { body: buildCommands() });
        log.info('Discord slash commands registered');
    } catch (err) {
        log.error(`Failed to register slash commands: ${err.message}`);
    }
}

export async function startDiscordBot() {
    const token = process.env.DISCORD_BOT_TOKEN;
    const appId = process.env.DISCORD_APP_ID;

    if (!token) { log.warn('DISCORD_BOT_TOKEN not set'); return null; }
    if (!appId) { log.warn('DISCORD_APP_ID not set'); return null; }

    await registerCommands(token, appId);

    client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.on('ready', () => log.info(`Discord bot logged in as ${client.user.tag}`));

    client.on('interactionCreate', async (interaction) => {
        if (interaction.isStringSelectMenu() && interaction.customId === 'remove_alert') {
            const alertId = parseInt(interaction.values[0]);
            const user = getOrCreateUser('discord', interaction.user.id, interaction.user.username);
            const alert = getAlert(alertId, user.id);
            if (!alert) {
                await interaction.update({ content: `Alert #${alertId} not found.`, components: [], embeds: [] });
                return;
            }
            removeAlert(alertId, user.id);
            await interaction.update({ content: `Alert #${alertId} ("${alert.card_name}") removed.`, components: [], embeds: [] });
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        const userId = interaction.user.id;
        const username = interaction.user.username;

        try {
            switch (interaction.commandName) {
                case 'alert': await handleAlert(interaction, userId, username); break;
                case 'search': await handleSearch(interaction); break;
                case 'list': await handleList(interaction, userId, username); break;
                case 'remove': await handleRemove(interaction, userId, username); break;
                case 'history': await handleHistory(interaction, userId, username); break;
                case 'upgrade': await handleUpgrade(interaction, userId, username); break;
                case 'gearhelp': await handleHelp(interaction); break;
                case 'gearstats': await handleStats(interaction); break;
                case 'feedback': await handleFeedback(interaction, userId, username); break;
                default: await interaction.reply({ content: 'Unknown command.', ephemeral: true });
            }
        } catch (err) {
            log.error(`Command error (${interaction.commandName}): ${err.message}`);
            const reply = interaction.replied || interaction.deferred
                ? interaction.followUp.bind(interaction)
                : interaction.reply.bind(interaction);
            await reply({ content: 'An error occurred processing your command.', ephemeral: true });
        }
    });

    registerNotifier(async (alert, card, currentPrice) => {
        if (alert.platform !== 'discord') return;
        try {
            const discordUser = await client.users.fetch(alert.platform_user_id);
            if (!discordUser) return;

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('PRICE ALERT!')
                .setDescription(`**${alert.card_name}** found for ${fmtPrice(currentPrice)} on Reverb!`)
                .addFields(
                    { name: 'Your Target', value: fmtPrice(alert.target_price), inline: true },
                    { name: 'Current Price', value: fmtPrice(currentPrice), inline: true },
                )
                .setTimestamp();

            if (card?.setName) embed.addFields({ name: 'Details', value: card.setName, inline: true });
            if (card?.totalListings) embed.addFields({ name: 'Listings', value: String(card.totalListings), inline: true });
            if (card?.url) embed.setURL(card.url);
            if (card?.imageUrl) embed.setThumbnail(card.imageUrl);
            embed.setFooter({ text: `Alert #${alert.id} | Use /remove to stop` });

            await discordUser.send({ embeds: [embed] });
            log.info(`Notification sent to ${alert.platform_user_id} for alert #${alert.id}`);
        } catch (err) {
            log.error(`Failed to send notification: ${err.message}`);
        }
    });

    await client.login(token);
    log.info('Discord bot started');
    return client;
}

async function handleAlert(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);
    const gearName = interaction.options.getString('gear');
    const targetPrice = interaction.options.getNumber('price');
    const category = interaction.options.getString('category') ?? 'any';

    const { allowed, count, limit } = canCreateAlert(user.id, user.tier);
    if (!allowed) {
        const limitEmbed = new EmbedBuilder()
            .setColor(0xF39C12)
            .setTitle('Alert Limit Reached')
            .setDescription(`You have ${count}/${limit} alerts on the free tier.`)
            .addFields(
                { name: 'Want unlimited alerts?', value: 'Upgrade to the Reverb Music Gear API on RapidAPI for unlimited alerts, full price history, and priority checks.' },
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Upgrade on RapidAPI')
                .setURL('https://rapidapi.com/lulzasaur9192/api/reverb-music-gear-listings?utm_source=discord&utm_medium=bot&utm_campaign=gear-limit-hit')
                .setStyle(ButtonStyle.Link),
        );

        await interaction.reply({ embeds: [limitEmbed], components: [row], ephemeral: true });
        return;
    }

    await interaction.deferReply();

    const results = await searchListing(gearName, category, 1);
    const listing = results[0] ?? null;

    const alert = createAlert(user.id, {
        cardName: gearName,
        game: category,
        targetPrice,
        productId: listing?.id ?? null,
        productUrl: listing?.url ?? null,
        imageUrl: listing?.imageUrl ?? null,
        setName: listing ? `${listing.condition} — ${listing.shopName}` : null,
        currentPrice: listing?.price ?? null,
    });

    const embed = new EmbedBuilder()
        .setColor(0xF77F00)
        .setTitle(`Alert #${alert.id} Created`)
        .setDescription(`Tracking **${gearName}** below ${fmtPrice(targetPrice)} on Reverb`)
        .addFields(
            { name: 'Category', value: category === 'any' ? 'All' : category, inline: true },
            { name: 'Target', value: fmtPrice(targetPrice), inline: true },
            { name: 'Lowest Now', value: listing?.price ? fmtPrice(listing.price) : 'Checking...', inline: true },
        )
        .setTimestamp()
        .setFooter({ text: 'Prices checked every 30 minutes' });

    if (listing?.imageUrl) embed.setThumbnail(listing.imageUrl);
    if (listing?.url) embed.setURL(listing.url);
    if (listing) embed.addFields({ name: 'Best Listing', value: `${listing.condition} — ${listing.shopName}`, inline: true });

    await interaction.editReply({ embeds: [embed] });
}

async function handleSearch(interaction) {
    const gearName = interaction.options.getString('gear');
    const category = interaction.options.getString('category') ?? 'any';

    await interaction.deferReply();

    const results = await searchListing(gearName, category, 5);
    if (results.length === 0) {
        await interaction.editReply(`No results found for "${gearName}" on Reverb.`);
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0xF77F00)
        .setTitle(`Reverb: "${gearName}"`)
        .setTimestamp();

    for (const item of results) {
        embed.addFields({
            name: `${item.title}`.slice(0, 256),
            value: `${fmtPrice(item.price)} | ${item.condition} | ${item.shopName}\n[View on Reverb](${item.url})`,
        });
    }

    if (results[0]?.imageUrl) embed.setThumbnail(results[0].imageUrl);

    await interaction.editReply({ embeds: [embed] });
}

async function handleList(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);
    const alerts = getUserAlerts(user.id);

    if (alerts.length === 0) {
        await interaction.reply({ content: 'No active alerts. Create one with /alert.', ephemeral: true });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('Your Active Alerts')
        .setTimestamp();

    for (const a of alerts) {
        const priceInfo = a.current_price ? fmtPrice(a.current_price) : 'checking...';
        const triggerIcon = a.triggered ? ' [TRIGGERED]' : '';
        embed.addFields({
            name: `#${a.id} — ${a.card_name}${triggerIcon}`,
            value: `Target: ${fmtPrice(a.target_price)} | Current: ${priceInfo}`,
        });
    }

    const { limit } = canCreateAlert(user.id, user.tier);
    embed.setFooter({ text: user.tier === 'free' ? `Alerts: ${alerts.length}/${limit} (free)` : `Alerts: ${alerts.length} (paid)` });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleRemove(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);
    const alertId = interaction.options.getInteger('id');

    if (alertId === null) {
        const alerts = getUserAlerts(user.id);
        if (alerts.length === 0) {
            await interaction.reply({ content: 'No active alerts.', ephemeral: true });
            return;
        }

        const select = new StringSelectMenuBuilder()
            .setCustomId('remove_alert')
            .setPlaceholder('Pick an alert to remove')
            .addOptions(alerts.slice(0, 25).map(a => ({
                label: `#${a.id} — ${a.card_name}`.slice(0, 100),
                description: `Target: ${fmtPrice(a.target_price)} | Current: ${a.current_price ? fmtPrice(a.current_price) : '...'}`.slice(0, 100),
                value: String(a.id),
            })));

        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply({ content: 'Which alert do you want to remove?', components: [row], ephemeral: true });
        return;
    }

    const alert = getAlert(alertId, user.id);
    if (!alert) {
        await interaction.reply({ content: `Alert #${alertId} not found.`, ephemeral: true });
        return;
    }
    removeAlert(alertId, user.id);
    await interaction.reply({ content: `Alert #${alertId} ("${alert.card_name}") removed.`, ephemeral: true });
}

async function handleHistory(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);
    if (user.tier !== 'paid') {
        await interaction.reply({ content: 'Price history is for paid tier. Use /upgrade.', ephemeral: true });
        return;
    }
    const alertId = interaction.options.getInteger('id');
    const alert = getAlert(alertId, user.id);
    if (!alert) { await interaction.reply({ content: `Alert #${alertId} not found.`, ephemeral: true }); return; }

    const history = getPriceHistory(alertId, 20);
    if (history.length === 0) {
        await interaction.reply({ content: `No history yet for alert #${alertId}.`, ephemeral: true });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0xE67E22)
        .setTitle(`Price History: ${alert.card_name}`)
        .setDescription(`Target: ${fmtPrice(alert.target_price)}`)
        .setTimestamp();

    const lines = history.slice(0, 15).map(h => {
        const date = h.checked_at.replace('T', ' ').slice(0, 16);
        return `\`${date}\` ${fmtPrice(h.market_price)} (low: ${fmtPrice(h.lowest_price)})`;
    });
    embed.addFields({ name: 'Recent Checks', value: lines.join('\n') });
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleUpgrade(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);
    if (user.tier === 'paid') {
        await interaction.reply({ content: 'You are already on the paid tier!', ephemeral: true });
        return;
    }
    const embed = new EmbedBuilder()
        .setColor(0xF39C12)
        .setTitle('Upgrade to Pro')
        .setDescription('Get more from GearAlert Bot with a RapidAPI subscription.')
        .addFields(
            { name: 'Free Tier', value: '- 3 active alerts\n- Price notifications\n- 30-min price checks' },
            { name: 'Pro ($9.99/mo)', value: '- Unlimited alerts\n- Full price history\n- Priority checks\n- 5,000 API requests/mo' },
            { name: 'Ultra ($29.99/mo)', value: '- Everything in Pro\n- 25,000 API requests/mo\n- Bulk gear search' },
        );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Subscribe on RapidAPI')
            .setURL('https://rapidapi.com/lulzasaur9192/api/reverb-music-gear-listings?utm_source=discord&utm_medium=bot&utm_campaign=gear-upgrade-cmd')
            .setStyle(ButtonStyle.Link),
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleHelp(interaction) {
    const embed = new EmbedBuilder()
        .setColor(0xF77F00)
        .setTitle('GearAlert Bot')
        .setDescription('Track gear prices on Reverb and get alerts when they drop!')
        .addFields(
            { name: '/alert [gear] [price] [category]', value: 'Set a price alert' },
            { name: '/search [gear] [category]', value: 'Search Reverb for prices' },
            { name: '/list', value: 'View your active alerts' },
            { name: '/remove [id]', value: 'Remove an alert (shows picker if no ID)' },
            { name: '/history [id]', value: 'View price history (paid)' },
            { name: '/feedback [message]', value: 'Send us feedback' },
        )
        .setFooter({ text: 'Categories: Guitars, Pedals, Synths, Amps, Drums, Bass, Recording' });
    await interaction.reply({ embeds: [embed] });
}

async function handleStats(interaction) {
    const stats = getStats();
    const embed = new EmbedBuilder()
        .setColor(0x1ABC9C)
        .setTitle('Bot Statistics')
        .addFields(
            { name: 'Users', value: String(stats.totalUsers), inline: true },
            { name: 'Active Alerts', value: String(stats.activeAlerts), inline: true },
            { name: 'Triggered', value: String(stats.triggeredAlerts), inline: true },
            { name: 'Price Checks', value: String(stats.totalPriceChecks), inline: true },
        )
        .setTimestamp();
    await interaction.reply({ embeds: [embed] });
}

async function handleFeedback(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);
    const message = interaction.options.getString('message');
    saveFeedback(user.id, message);
    log.info(`Feedback from ${username} (${userId}): ${message}`);

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('Feedback Received')
        .setDescription('Thanks! We read every message.')
        .addFields({ name: 'Need more help?', value: 'Email us at **lulzasaur9192@gmail.com**' })
        .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

export function stopDiscordBot() {
    if (client) { client.destroy(); log.info('Discord bot stopped'); }
}
