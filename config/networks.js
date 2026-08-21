const { requireContracts } = require("./contracts");
const { ValidationError } = require("../utils/errors");
const env = require("./env");

const MAX_ALLOWANCE_USDT = 1n;

const NETWORK_DEFS = {
    tron: {
        key: "tron",
        name: "TRON",
        chainId: "tron:0x2b6653dc",
        namespace: "tron",
        usdtDecimals: 6,
        rpcUrl: env.TRON_API_URL || "https://api.trongrid.io"
    },
    bsc: {
        key: "bsc",
        name: "BNB Smart Chain",
        chainId: "eip155:56",
        namespace: "eip155",
        usdtDecimals: 18,
        rpcUrl: env.RPC_BSC || "https://bsc-dataseed.binance.org"
    },
    eth: {
        key: "eth",
        name: "Ethereum",
        chainId: "eip155:1",
        namespace: "eip155",
        usdtDecimals: 6,
        rpcUrl: env.RPC_ETH || "https://cloudflare-eth.com"
    }
};

function normalizeNetworkKey(value) {
    const key = String(value || "").trim().toLowerCase();

    if (key === "trc20" || key === "tron") {
        return "tron";
    }

    if (key === "bep20" || key === "bsc" || key === "bnb") {
        return "bsc";
    }

    if (key === "erc20" || key === "eth" || key === "ethereum") {
        return "eth";
    }

    return key;
}

function getNetwork(networkKey, options = {}) {
    const key = normalizeNetworkKey(networkKey);
    const base = NETWORK_DEFS[key];

    if (!base) {
        throw new ValidationError(
            `Unsupported network "${networkKey}". Use tron, bsc, or eth.`
        );
    }

    const contracts = options.requireContracts === false
        ? { usdt: null, card: null }
        : requireContracts(key);

    return {
        ...base,
        token: "USDT",
        usdtContract: contracts.usdt,
        cardContract: contracts.card,
        maxAllowanceUsdt: MAX_ALLOWANCE_USDT
    };
}

function listNetworks() {
    return Object.keys(NETWORK_DEFS);
}

module.exports = {
    MAX_ALLOWANCE_USDT,
    NETWORK_DEFS,
    normalizeNetworkKey,
    getNetwork,
    listNetworks
};
