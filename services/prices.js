const logger = require("../utils/logger");

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

    try {
        const url = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin,tron,tether&vs_currencies=usd";
        const response = await fetchImpl(url, {
            method: "GET",
            signal: deps.signal
        });

        if (!response.ok) {
            throw new Error(`Price API HTTP ${response.status}`);
        }

        const payload = await response.json();
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
