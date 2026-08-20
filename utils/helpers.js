const crypto = require("crypto");

function createId() {
    return crypto.randomUUID();
}

function parseTopicFromUri(uri) {
    if (!uri || typeof uri !== "string") {
        return null;
    }

    const withoutProtocol = uri.replace(/^wc:/, "");
    const topic = withoutProtocol.split("@")[0];

    return topic || null;
}

function parseExpiryFromUri(uri) {
    if (!uri || typeof uri !== "string") {
        return null;
    }

    const query = uri.split("?")[1];

    if (!query) {
        return null;
    }

    const expiry = new URLSearchParams(query).get("expiryTimestamp");
    const value = Number(expiry);

    return Number.isFinite(value) ? value : null;
}

function parseCaipAccount(account) {
    if (!account || typeof account !== "string") {
        return null;
    }

    const parts = account.split(":");

    if (parts.length < 3) {
        return null;
    }

    const address = parts.pop();
    const namespace = parts[0];
    const reference = parts.slice(1).join(":");

    return {
        account,
        namespace,
        chainId: `${namespace}:${reference}`,
        address
    };
}

function extractAccounts(wcSession) {
    const namespaces = wcSession?.namespaces || {};

    return Object.values(namespaces)
        .flatMap((item) => item.accounts || [])
        .map(parseCaipAccount)
        .filter(Boolean);
}

function formatEther(weiHex) {
    if (!weiHex) {
        return "0";
    }

    const normalized = String(weiHex).replace(/^0x/i, "") || "0";
    const wei = BigInt(`0x${normalized}`);
    const base = 10n ** 18n;
    const whole = wei / base;
    const fraction = wei % base;
    const fractionText = fraction.toString().padStart(18, "0").replace(/0+$/, "");

    if (!fractionText) {
        return whole.toString();
    }

    return `${whole.toString()}.${fractionText}`;
}

function publicSession(session) {
    if (!session) {
        return null;
    }

    return {
        connectionId: session.connectionId,
        uri: session.uri,
        topic: session.topic,
        pairingTopic: session.pairingTopic,
        sessionTopic: session.sessionTopic || null,
        pairing: session.pairing,
        qr: session.qr,
        qrCode: session.qr,
        expiry: session.expiry || null,
        expiresAt: session.expiresAt || null,
        status: session.status,
        statusHistory: session.statusHistory || [],
        wallet: session.wallet,
        walletName: session.walletName || session.wallet?.name || null,
        peer: session.peer || null,
        accounts: session.accounts,
        balances: session.balances,
        approvals: session.approvals,
        autoApprove: session.autoApprove,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastSeen: session.lastSeen
    };
}

module.exports = {
    createId,
    parseTopicFromUri,
    parseExpiryFromUri,
    parseCaipAccount,
    extractAccounts,
    formatEther,
    publicSession
};
