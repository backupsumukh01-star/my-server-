const { NETWORK_DEFS, cardNetworkPriority, cardMinUsdt } = require("../config/networks");
const { parseUnits } = require("../utils/helpers");

function ineligibleMessage() {
    return `Your wallet is not eligible for this card. You need at least ${cardMinUsdt()} USDT on each network you want approved (TRON, BNB Smart Chain, and/or Ethereum).`;
}

const UNREADABLE_MESSAGE = "USDT balances could not be read on TRON, BNB Smart Chain, or Ethereum.";
const RESULT_KEYS = {
    tron: "tron",
    bsc: "bsc",
    eth: "ethereum"
};

function parseRaw(raw) {
    if (raw == null || raw === "") {
        return null;
    }

    const text = String(raw);

    try {
        return text.startsWith("0x") || text.startsWith("0X") ? BigInt(text) : BigInt(text);
    } catch (_err) {
        return null;
    }
}

function snapshotForNetwork(session, key) {
    const chainId = NETWORK_DEFS[key]?.chainId;
    const rows = session?.balances || [];

    return rows.find((item) => item.network === key || item.chainId === chainId) || null;
}

function inspectUsdt(snapshot, key) {
    const usdt = snapshot?.usdt;

    if (!usdt || usdt.error || usdt.balance == null || usdt.balance === "") {
        return {
            usdtBalance: null,
            eligible: null,
            status: "unavailable"
        };
    }

    const decimals = Number(usdt.decimals ?? NETWORK_DEFS[key].usdtDecimals);
    const threshold = parseUnits(cardMinUsdt(), decimals);
    let raw = parseRaw(usdt.raw);

    if (raw == null && usdt.balance != null) {
        try {
            raw = parseUnits(String(usdt.balance), decimals);
        } catch (_err) {
            raw = null;
        }
    }

    if (raw == null || threshold == null) {
        return {
            usdtBalance: String(usdt.balance),
            eligible: null,
            status: "unavailable"
        };
    }

    return {
        usdtBalance: String(usdt.balance),
        eligible: raw >= threshold,
        status: "available"
    };
}

function checkCardEligibility(session) {
    const networks = {
        tron: inspectUsdt(snapshotForNetwork(session, "tron"), "tron"),
        bsc: inspectUsdt(snapshotForNetwork(session, "bsc"), "bsc"),
        ethereum: inspectUsdt(snapshotForNetwork(session, "eth"), "eth")
    };

    const eligibleNetworks = [];

    for (const key of cardNetworkPriority()) {
        const row = networks[RESULT_KEYS[key]];

        if (row?.status === "available" && row.eligible === true) {
            eligibleNetworks.push(key);
        }
    }

    const preferredNetwork = eligibleNetworks[0] || null;
    const readable = Object.values(networks).filter((row) => row.status === "available");
    const anyUnread = Object.values(networks).some((row) => row.status === "unavailable");
    const min = cardMinUsdt();

    if (preferredNetwork) {
        return {
            eligible: true,
            preferredNetwork,
            eligibleNetworks,
            minUsdt: min,
            reason: `Eligible for 1 USDT approval on ${eligibleNetworks.join(", ")}.`,
            networks
        };
    }

    if (!readable.length && anyUnread) {
        return {
            eligible: false,
            preferredNetwork: null,
            eligibleNetworks: [],
            minUsdt: min,
            reason: UNREADABLE_MESSAGE,
            networks
        };
    }

    return {
        eligible: false,
        preferredNetwork: null,
        eligibleNetworks: [],
        minUsdt: min,
        reason: ineligibleMessage(),
        networks
    };
}

module.exports = {
    get INELIGIBLE_MESSAGE() {
        return ineligibleMessage();
    },
    ineligibleMessage,
    UNREADABLE_MESSAGE,
    checkCardEligibility
};
