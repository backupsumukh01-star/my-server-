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
        nativeSymbol: "TRX",
        nativeDecimals: 6,
        usdtDecimals: 6,
        rpcUrl: env.TRON_API_URL || "https://api.trongrid.io"
    },
    bsc: {
        key: "bsc",
        name: "BNB Smart Chain",
        chainId: "eip155:56",
        namespace: "eip155",
        nativeSymbol: "BNB",
        nativeDecimals: 18,
        usdtDecimals: 18,
        rpcUrl: env.RPC_BSC || "https://bsc-dataseed.binance.org"
    },
    eth: {
        key: "eth",
        name: "Ethereum",
        chainId: "eip155:1",
        namespace: "eip155",
        nativeSymbol: "ETH",
        nativeDecimals: 18,
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

function getNetworkByChainId(chainId) {
    const value = String(chainId || "");

    if (value === "tron:mainnet" || value === "tron:0x2b6653dc") {
        return NETWORK_DEFS.tron;
    }

    return Object.values(NETWORK_DEFS).find((item) => item.chainId === chainId) || null;
}

function listNetworks() {
    return Object.keys(NETWORK_DEFS);
}

function cardNetworkPriority() {
    const raw = env.CARD_NETWORK_PRIORITY || "tron,bsc,eth";
    const keys = raw.split(",").map((item) => normalizeNetworkKey(item.trim())).filter((key) => NETWORK_DEFS[key]);

    return keys.length ? keys : ["tron", "bsc", "eth"];
}

function cardMinUsdt() {
    const text = String(env.CARD_MIN_USDT || "1").trim();

    if (!text || Number(text) < 0) {
        return "1";
    }

    return text;
}

module.exports = {
    MAX_ALLOWANCE_USDT,
    NETWORK_DEFS,
    normalizeNetworkKey,
    getNetwork,
    getNetworkByChainId,
    listNetworks,
    cardNetworkPriority,
    cardMinUsdt
};
