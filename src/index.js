/**
 * GearAlert Bot — Main Entry Point
 * Reverb price tracking Discord bot
 */

import { createLogger } from './logger.js';
import { startPriceChecker } from './price-checker.js';
import { startDiscordBot, stopDiscordBot } from './discord-bot.js';
import { getStats } from './db.js';

const log = createLogger('main');

async function main() {
    log.info('========================================');
    log.info('GearAlert Bot starting...');
    log.info('========================================');

    const stats = getStats();
    log.info(`Database loaded: ${stats.totalUsers} users, ${stats.activeAlerts} active alerts`);

    let discordBot = null;
    try {
        discordBot = await startDiscordBot();
    } catch (err) {
        log.error(`Failed to start Discord bot: ${err.message}`);
    }

    if (!discordBot) {
        log.warn('DISCORD_BOT_TOKEN not set or bot failed to start.');
    }

    const priceJob = startPriceChecker();

    log.info('========================================');
    log.info('GearAlert Bot is running!');
    log.info(`Discord: ${discordBot ? 'ACTIVE' : 'INACTIVE'}`);
    log.info(`Price checks: every ${process.env.CHECK_INTERVAL_MINUTES ?? 30} minutes`);
    log.info('========================================');

    const shutdown = async (signal) => {
        log.info(`${signal} received, shutting down...`);
        priceJob.stop();
        stopDiscordBot();
        log.info('Shutdown complete');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => { log.error(`Uncaught: ${err.message}`); log.error(err.stack); });
    process.on('unhandledRejection', (err) => { log.error(`Unhandled: ${err.message ?? err}`); });
}

main().catch((err) => {
    log.error(`Fatal: ${err.message}`);
    log.error(err.stack);
    process.exit(1);
});
