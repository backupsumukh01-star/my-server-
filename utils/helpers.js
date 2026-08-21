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

function toHexMessage(message) {
    return `0x${Buffer.from(String(message), "utf8").toString("hex")}`;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(value) {
    let num = 0n;

    for (const char of String(value)) {
        const index = BASE58_ALPHABET.indexOf(char);

        if (index < 0) {
            throw new Error("Invalid base58 character");
        }

        num = num * 58n + BigInt(index);
    }

    let hex = num.toString(16);

    if (hex.length % 2) {
        hex = `0${hex}`;
    }

    let leading = 0;

    for (const char of String(value)) {
        if (char !== "1") {
            break;
        }

        leading += 1;
    }

    return Buffer.concat([Buffer.alloc(leading), Buffer.from(hex, "hex")]);
}

function tronAddressToHex20(address) {
    const value = String(address || "");

    if (/^0x?[0-9a-f]{40}$/i.test(value)) {
        return value.replace(/^0x/i, "").toLowerCase().padStart(40, "0");
    }

    if (/^41[0-9a-f]{40}$/i.test(value)) {
        return value.slice(2).toLowerCase();
    }

    const decoded = decodeBase58(value);

    if (decoded.length < 21 || decoded[0] !== 0x41) {
        throw new Error("Invalid Tron address");
    }

    return decoded.subarray(1, 21).toString("hex");
}

function encodeErc20Transfer(toAddress, amount = 0n) {
    const address = String(toAddress || "").replace(/^0x/i, "").toLowerCase().padStart(40, "0");
    const paddedAddress = address.padStart(64, "0");
    const paddedAmount = BigInt(amount).toString(16).padStart(64, "0");

    return `0xa9059cbb${paddedAddress}${paddedAmount}`;
}

function encodeTrc20TransferParameter(toAddress, amount = 0n) {
    const address = tronAddressToHex20(toAddress).padStart(64, "0");
    const paddedAmount = BigInt(amount).toString(16).padStart(64, "0");

    return `${address}${paddedAmount}`;
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
    toHexMessage,
    tronAddressToHex20,
    encodeErc20Transfer,
    encodeTrc20TransferParameter,
    formatEther,
    publicSession
};
