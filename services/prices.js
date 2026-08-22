const logger = require("../utils/logger");
const env = require("../config/env");
const { fetchWithRetry } = require("../utils/httpRetry");

const CACHE_MS = 45000;
const PRICE_IDS = {
    ETH: "ethereum",
    BNB: "binancecoin",
    TRX: "tron",
    USDT: "tether"
};

let cache = {
    at: 0,
    values: {}
};

function emptyPrices() {
    return {
        ETH: null,
        BNB: null,
        TRX: null,
        USDT: null
    };
}

/**
 * Optional USD prices. Failure never throws; values stay null (not zero).
 */
async function getUsdPrices(deps = {}) {
    if (Date.now() - cache.at < CACHE_MS && Object.keys(cache.values).length) {
        return cache.values;
    }

    const fetchImpl = deps.fetchImpl || fetch;
    const geckoKey = String(env.COINGECKO_API_KEY || "").trim();
    const fallbackUrl = String(env.PRICE_API_URL || "").trim();

    async function readPrices(url, headers) {
        const response = await fetchWithRetry(url, {
            method: "GET",
            headers,
            signal: deps.signal
        }, { fetchImpl, label: "prices" });

        if (!response.ok) {
            throw new Error(`Price API HTTP ${response.status}`);
        }

        return response.json();
    }

    try {
        let payload = null;
        const geckoUrl = geckoKey
            ? `https://pro-api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin,tron,tether&vs_currencies=usd`
            : "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin,tron,tether&vs_currencies=usd";
        const geckoHeaders = geckoKey ? { "x-cg-pro-api-key": geckoKey } : {};

        try {
            payload = await readPrices(geckoUrl, geckoHeaders);
        } catch (err) {
            if (!fallbackUrl) {
                throw err;
            }
            logger.warn({ err: { message: err.message } }, "CoinGecko failed; trying PRICE_API_URL fallback");
            payload = await readPrices(fallbackUrl, {});
        }
        const values = emptyPrices();

        for (const [symbol, id] of Object.entries(PRICE_IDS)) {
            const usd = payload?.[id]?.usd;
            values[symbol] = typeof usd === "number" && Number.isFinite(usd) ? usd : null;
        }

        cache = { at: Date.now(), values };
        return values;
    } catch (err) {
        logger.warn({ err: { message: err.message } }, "USD price lookup failed; continuing without prices");
        cache = { at: Date.now(), values: emptyPrices() };
        return cache.values;
    }
}

function usdValue(amountText, price) {
    if (price == null || amountText == null || amountText === "") {
        return null;
    }

    const amount = Number(amountText);

    if (!Number.isFinite(amount)) {
        return null;
    }

    return (amount * price).toFixed(2);
}

function resetPriceCache() {
    cache = { at: 0, values: {} };
}

module.exports = {
    getUsdPrices,
    usdValue,
    resetPriceCache
};
