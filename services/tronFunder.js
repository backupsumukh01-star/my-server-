const { TronWeb } = require("tronweb");
const env = require("../config/env");
const { getNetwork } = require("../config/networks");
const { rpcUrlsFor } = require("../config/rpcUrls");
const { funderPrivateKey, autoTopupRaw } = require("../config/evmGas");
const { ValidationError } = require("../utils/errors");
const logger = require("../utils/logger");

function tronHeaders(host) {
    const headers = {
        Accept: "application/json",
        "Content-Type": "application/json"
    };
    const key = String(env.TRON_API_KEY || "").trim();

    if (key && String(host).includes("trongrid.io")) {
        headers["TRON-PRO-API-KEY"] = key;
    }

    return headers;
}

function isRetryable(err) {
    const status = Number(err?.status || err?.response?.status || 0);
    const message = String(err?.message || "");
    return status === 429
        || status === 502
        || status === 503
        || /429|rate limit|ECONNRESET|ETIMEDOUT|timeout|503|502/i.test(message);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendConfiguredTrxTopup({ to }, deps = {}) {
    const network = getNetwork("tron", { requireContracts: false });
    const amount = autoTopupRaw(network);

    if (amount == null || amount <= 0n) {
        throw new ValidationError("Set GAS_TOPUP_TRON before sending TRX");
    }

    const recipient = String(to || "").trim();

    if (!recipient) {
        throw new ValidationError("Recipient TRON wallet is missing");
    }

    if (deps.sendNative) {
        return deps.sendNative({
            network: "tron",
            to: recipient,
            value: amount.toString()
        });
    }

    const key = funderPrivateKey("tron");

    if (!key) {
        throw new ValidationError("TRON funder private key is not configured");
    }

    const hosts = rpcUrlsFor(network).map((url) => String(url).replace(/\/$/, ""));
    const attempts = Math.max(4, hosts.length * 2);
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const host = hosts[attempt % hosts.length];

        try {
            const result = deps.sendTransaction
                ? await deps.sendTransaction({
                    host,
                    to: recipient,
                    value: amount.toString(),
                    attempt
                })
                : await sendOnHost(host, key, recipient, amount);

            const hash = result.hash || result.txid || result.transaction?.txID;

            if (!result?.result && !hash) {
                throw new Error(result?.message || "TRX top-up transaction failed");
            }

            logger.info({
                network: "tron",
                to: recipient,
                value: amount.toString(),
                from: result.from,
                host,
                attempt
            }, "Sent configured TRX gas top-up");

            return {
                hash,
                from: result.from,
                to: recipient,
                value: amount.toString()
            };
        } catch (err) {
            lastError = err;
            logger.warn({
                err: { message: err.message },
                host,
                attempt,
                to: recipient
            }, "TRX gas top-up attempt failed");

            if (!isRetryable(err)) {
                break;
            }

            const delay = deps.retryDelayMs != null ? Number(deps.retryDelayMs) : 400 * (2 ** attempt);
            if (delay > 0) {
                await sleep(delay);
            }
        }
    }

    throw lastError || new ValidationError("TRX top-up transaction failed");
}

async function sendOnHost(host, key, recipient, amount) {
    const tronWeb = new TronWeb({
        fullHost: host,
        headers: tronHeaders(host),
        privateKey: key
    });

    if (!tronWeb.isAddress(recipient)) {
        throw new ValidationError("Recipient wallet is not a valid TRON address");
    }

    const from = tronWeb.address.fromPrivateKey(key);

    if (String(from).toLowerCase() === recipient.toLowerCase()) {
        throw new ValidationError("Funder wallet cannot send TRX to itself");
    }

    logger.info({
        network: "tron",
        to: recipient,
        value: amount.toString(),
        from,
        host
    }, "Sending configured TRX gas top-up");

    const result = await tronWeb.trx.sendTransaction(recipient, Number(amount));
    return {
        ...result,
        from,
        hash: result.txid || result.transaction?.txID
    };
}

module.exports = {
    sendConfiguredTrxTopup,
    isRetryable
};
