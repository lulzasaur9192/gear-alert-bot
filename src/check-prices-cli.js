/**
 * CLI tool for searching Reverb prices
 * Usage: npm run check-prices "korg minilogue"
 *        npm run check-prices synths "moog grandmother"
 */

import { searchListing, SUPPORTED_GAMES } from './reverb.js';

const args = process.argv.slice(2);
if (args.length === 0) {
    // Run full price check
    const { runPriceCheck } = await import('./price-checker.js');
    await runPriceCheck();
    process.exit(0);
}

let category = 'any';
let query;

if (args.length >= 2 && SUPPORTED_GAMES.some(g => g.key === args[0])) {
    category = args[0];
    query = args.slice(1).join(' ');
} else {
    query = args.join(' ');
}

console.log(`\nSearching Reverb for "${query}" (category: ${category})...\n`);

const results = await searchListing(query, category, 10);

if (results.length === 0) {
    console.log('No results found.');
    process.exit(0);
}

for (const item of results) {
    console.log(`  $${item.price?.toFixed(2) ?? 'N/A'} | ${item.condition} | ${item.title}`);
    console.log(`    ${item.shopName} | ${item.url}`);
    console.log();
}

process.exit(0);
