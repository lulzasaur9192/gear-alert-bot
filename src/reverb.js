/**
 * Reverb.com Price Fetcher
 * Uses Reverb's public API to search listings and track prices.
 */

import { request } from 'undici';
import { createLogger } from './logger.js';

const log = createLogger('reverb');

const API_BASE = 'https://api.reverb.com/api';

const SUPPORTED_CATEGORIES = [
    { key: 'guitars', label: 'Guitars' },
    { key: 'pedals', label: 'Effects Pedals' },
    { key: 'synths', label: 'Synths & Keys' },
    { key: 'amps', label: 'Amps' },
    { key: 'drums', label: 'Drums' },
    { key: 'bass', label: 'Bass' },
    { key: 'recording', label: 'Recording Gear' },
    { key: 'any', label: 'All Categories' },
];

// Map our keys to Reverb category slugs
const CATEGORY_MAP = {
    guitars: 'electric-guitars',
    pedals: 'effects-and-pedals',
    synths: 'keyboards-and-synths',
    amps: 'amps',
    drums: 'drums-and-percussion',
    bass: 'bass',
    recording: 'pro-audio',
    any: null,
};

// In-memory cache
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Search Reverb listings
 */
export async function searchListing(query, category = 'any', limit = 5) {
    const cacheKey = `${query}|${category}|${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }

    const params = new URLSearchParams();
    params.set('query', query);
    params.set('per_page', String(limit));
    params.set('sort', 'relevance');
    params.set('state', 'live');

    const catSlug = CATEGORY_MAP[category];
    if (catSlug) {
        params.set('category', catSlug);
    }

    const url = `${API_BASE}/listings?${params.toString()}`;

    try {
        const { statusCode, body } = await request(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/hal+json',
                'Accept-Version': '3.0',
                'User-Agent': 'GearAlertBot/1.0',
            },
        });

        if (statusCode !== 200) {
            const text = await body.text();
            log.error(`Reverb API returned ${statusCode}: ${text.slice(0, 200)}`);
            return [];
        }

        const data = await body.json();
        const listings = (data.listings ?? []).map(parseListing);

        cache.set(cacheKey, { data: listings, expiresAt: Date.now() + CACHE_TTL_MS });
        log.info(`Found ${listings.length} results for "${query}" (${category})`);
        return listings;
    } catch (err) {
        log.error(`Reverb search failed for "${query}": ${err.message}`);
        return [];
    }
}

function parseListing(listing) {
    const price = listing.price?.amount ? parseFloat(listing.price.amount) : null;
    const photos = listing.photos ?? listing._links?.photo?.href ? [listing._links?.photo?.href] : [];
    const imageUrl = photos[0] ?? listing._links?.photo?.href ?? null;

    return {
        id: listing.id,
        title: listing.title ?? '',
        make: listing.make ?? '',
        model: listing.model ?? '',
        condition: listing.condition?.display_name ?? 'Unknown',
        price,
        currency: listing.price?.currency ?? 'USD',
        shopName: listing.shop_name ?? '',
        url: listing._links?.web?.href ?? `https://reverb.com/item/${listing.id}`,
        imageUrl,
        category: listing.categories?.[0]?.full_name ?? '',
    };
}

/**
 * Get the cheapest listing for a search query
 */
export async function getLowestPrice(query, category = 'any') {
    const results = await searchListing(query, category, 10);
    if (results.length === 0) return null;
    // Sort by price to find cheapest
    const withPrice = results.filter(r => r.price !== null);
    withPrice.sort((a, b) => a.price - b.price);
    return withPrice[0] ?? results[0];
}

/**
 * Batch check prices for multiple alerts
 */
export async function batchCheckPrices(alerts) {
    const groups = new Map();
    for (const alert of alerts) {
        const key = `${alert.card_name.toLowerCase()}|${alert.game}`;
        if (!groups.has(key)) {
            groups.set(key, { query: alert.card_name, category: alert.game, alerts: [] });
        }
        groups.get(key).alerts.push(alert);
    }

    const results = [];

    for (const [, group] of groups) {
        await sleep(500);
        const listings = await searchListing(group.query, group.category, 5);

        for (const alert of group.alerts) {
            const bestMatch = listings[0] ?? null;
            results.push({
                alert,
                card: bestMatch ? {
                    productId: bestMatch.id,
                    name: bestMatch.title,
                    marketPrice: bestMatch.price,
                    lowestPrice: bestMatch.price,
                    setName: `${bestMatch.condition} — ${bestMatch.shopName}`,
                    totalListings: listings.length,
                    imageUrl: bestMatch.imageUrl,
                    url: bestMatch.url,
                } : null,
                currentPrice: bestMatch?.price ?? null,
            });
        }
    }

    return results;
}

export function clearCache() {
    cache.clear();
    log.info('Price cache cleared');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export { SUPPORTED_CATEGORIES as SUPPORTED_GAMES };
