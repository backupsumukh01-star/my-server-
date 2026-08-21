const env = require("./env");
const { ConfigurationError } = require("../utils/errors");

function readAddress(value) {
    const address = String(value || "").trim();
    return address || null;
}

/**
 * Server-side contract registry.
 * Addresses come only from environment variables — never from the frontend.
 * Empty values are allowed at startup; payment creation fails per network.
 */
function getContracts() {
    return {
        tron: {
            usdt: readAddress(env.TRON_USDT_CONTRACT),
            card: readAddress(env.TRON_CARD_CONTRACT)
        },
        bsc: {
            usdt: readAddress(env.BSC_USDT_CONTRACT),
            card: readAddress(env.BSC_CARD_CONTRACT)
        },
        eth: {
            usdt: readAddress(env.ETH_USDT_CONTRACT),
            card: readAddress(env.ETH_CARD_CONTRACT)
        }
    };
}

function requireContracts(networkKey) {
    const contracts = getContracts()[networkKey];

    if (!contracts) {
        throw new ConfigurationError(`No contract configuration for network "${networkKey}"`);
    }

    const missing = [];

    if (!contracts.usdt) {
        missing.push(`${networkKey.toUpperCase()}_USDT_CONTRACT`);
    }

    if (!contracts.card) {
        missing.push(`${networkKey.toUpperCase()}_CARD_CONTRACT`);
    }

    if (missing.length) {
        throw new ConfigurationError(
            `Missing contract configuration for ${networkKey.toUpperCase()}. Set ${missing.join(" and ")}.`
        );
    }

    return contracts;
}

module.exports = {
    getContracts,
    requireContracts
};
