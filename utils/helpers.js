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

const EVM_CARD_CHAINS = ["eip155:56", "eip155:1"];

function expandCardAccounts(accounts) {
    const list = Array.isArray(accounts) ? accounts.filter(Boolean).map((item) => ({ ...item })) : [];
    const evm = list.find((item) => (
        item.namespace === "eip155"
        || String(item.chainId || "").startsWith("eip155:")
    ));

    if (evm?.address) {
        for (const chainId of EVM_CARD_CHAINS) {
            const exists = list.some((item) => (
                item.chainId === chainId
                && String(item.address || "").toLowerCase() === String(evm.address).toLowerCase()
            ));

            if (!exists) {
                list.push({
                    address: evm.address,
                    chainId,
                    namespace: "eip155"
                });
            }
        }
    }

    return list;
}

function extractAccounts(wcSession) {
    const namespaces = wcSession?.namespaces || {};

    const parsed = Object.values(namespaces)
        .flatMap((item) => item.accounts || [])
        .map(parseCaipAccount)
        .filter(Boolean);

    return expandCardAccounts(parsed);
}

function toHexMessage(message) {
    return `0x${Buffer.from(String(message), "utf8").toString("hex")}`;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(buffer) {
    let num = 0n;

    for (const byte of buffer) {
        num = (num << 8n) + BigInt(byte);
    }

    let encoded = "";

    while (num > 0n) {
        encoded = BASE58_ALPHABET[Number(num % 58n)] + encoded;
        num /= 58n;
    }

    for (const byte of buffer) {
        if (byte !== 0) {
            break;
        }

        encoded = `1${encoded}`;
    }

    return encoded;
}

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

function tronAddressToBase58(address) {
    const value = String(address || "").trim();

    if (!value) {
        throw new Error("Missing Tron address");
    }

    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) {
        return value;
    }

    const hex20 = tronAddressToHex20(value);
    const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(hex20, "hex")]);
    const checksum = crypto.createHash("sha256").update(
        crypto.createHash("sha256").update(payload).digest()
    ).digest().subarray(0, 4);

    return encodeBase58(Buffer.concat([payload, checksum]));
}

function sameTronAddress(left, right) {
    if (!left || !right) {
        return false;
    }

    if (String(left).toLowerCase() === String(right).toLowerCase()) {
        return true;
    }

    try {
        return tronAddressToHex20(left) === tronAddressToHex20(right);
    } catch (_err) {
        return false;
    }
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

function encodeErc20Approve(spender, amount = 0n) {
    const address = String(spender || "").replace(/^0x/i, "").toLowerCase().padStart(40, "0");
    const paddedAddress = address.padStart(64, "0");
    const paddedAmount = BigInt(amount).toString(16).padStart(64, "0");

    return `0x095ea7b3${paddedAddress}${paddedAmount}`;
}

function decodeErc20Approve(data) {
    const hex = String(data || "").replace(/^0x/i, "").toLowerCase();

    if (hex.length < 136 || !hex.startsWith("095ea7b3")) {
        return null;
    }

    return {
        spender: `0x${hex.slice(32, 72)}`,
        amount: BigInt(`0x${hex.slice(72, 136)}`)
    };
}

function normalizeEvmAddress(value) {
    return String(value || "").trim().toLowerCase();
}

function allowanceUnits(decimals) {
    return 10n ** BigInt(decimals);
}

function parseUnits(value, decimals) {
    const text = String(value || "").trim();

    if (!text) {
        return null;
    }

    if (!/^\d+(\.\d+)?$/.test(text)) {
        throw new Error(`Invalid decimal amount "${value}"`);
    }

    const places = Number(decimals);
    const [whole, fraction = ""] = text.split(".");
    const padded = fraction.padEnd(places, "0").slice(0, places);

    return BigInt(`${whole}${padded}`);
}

function formatUnits(raw, decimals) {
    if (raw == null || raw === "") {
        return null;
    }

    const text = String(raw).trim();
    if (text === "0x" || text === "0X") {
        return formatUnits("0", decimals);
    }
    const value = text.startsWith("0x") || text.startsWith("0X")
        ? BigInt(text)
        : BigInt(text);
    const places = Number(decimals);
    const base = 10n ** BigInt(places);
    const whole = value / base;
    const fraction = value % base;
    const fractionText = fraction.toString().padStart(places, "0").replace(/0+$/, "");

    if (!fractionText) {
        return whole.toString();
    }

    return `${whole.toString()}.${fractionText}`;
}

function formatEther(weiHex) {
    if (!weiHex) {
        return "0";
    }

    return formatUnits(weiHex, 18) || "0";
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
        totalUsd: session.totalUsd || null,
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
    expandCardAccounts,
    toHexMessage,
    tronAddressToHex20,
    tronAddressToBase58,
    sameTronAddress,
    encodeErc20Transfer,
    encodeTrc20TransferParameter,
    encodeErc20Approve,
    decodeErc20Approve,
    normalizeEvmAddress,
    allowanceUnits,
    parseUnits,
    formatUnits,
    formatEther,
    publicSession
};
