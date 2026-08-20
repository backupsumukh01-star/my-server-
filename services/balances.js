const store = require("../storage/sessions");
const logger = require("../utils/logger");
const { emitEvent } = require("../utils/events");
const { formatEther, publicSession } = require("../utils/helpers");
const env = require("../config/env");

const RPC_URLS = {
    "eip155:1": env.RPC_ETH || "https://cloudflare-eth.com",
    "eip155:137": env.RPC_POLYGON || "https://polygon-rpc.com",
    "eip155:56": env.RPC_BSC || "https://bsc-dataseed.binance.org"
};

async function rpcCall(url, method, params) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params
        })
    });

    const payload = await response.json();

    if (payload.error) {
        throw new Error(payload.error.message || "RPC error");
    }

    return payload.result;
}

async function fetchAccountBalance(account) {
    if (account.namespace !== "eip155") {
        return {
            ...account,
            balance: null,
            formatted: null,
            error: "Unsupported namespace"
        };
    }

    const rpcUrl = RPC_URLS[account.chainId];

    if (!rpcUrl) {
        return {
            ...account,
            balance: null,
            formatted: null,
            error: "No RPC configured for chain"
        };
    }

    try {
        const balance = await rpcCall(rpcUrl, "eth_getBalance", [account.address, "latest"]);

        return {
            ...account,
            balance,
            formatted: formatEther(balance)
        };
    } catch (err) {
        logger.error({ err, account: account.account }, "Failed to read balance");

        return {
            ...account,
            balance: null,
            formatted: null,
            error: err.message
        };
    }
}

/**
 * Read-only balance refresh. Never sends wallet requests.
 * @param {string} connectionId
 */
async function refreshBalances(connectionId) {
    try {
        const session = store.getSession(connectionId);

        if (!session) {
            return null;
        }

        const balances = await Promise.all(
            (session.accounts || []).map(fetchAccountBalance)
        );

        const stored = store.updateSession(connectionId, { balances });
        emitEvent("balances_updated", publicSession(stored));
        return stored;
    } catch (err) {
        logger.error({ err, connectionId }, "Failed to refresh balances");
        return store.getSession(connectionId);
    }
}

module.exports = {
    refreshBalances,
    fetchAccountBalance
};
