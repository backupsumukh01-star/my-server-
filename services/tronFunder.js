const { TronWeb } = require("tronweb");
const env = require("../config/env");
const { getNetwork } = require("../config/networks");
const { funderPrivateKey, autoTopupRaw } = require("../config/evmGas");
const { ValidationError } = require("../utils/errors");
const logger = require("../utils/logger");

function tronHost() {
    return env.TRON_API_URL || "https://api.trongrid.io";
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

    const tronWeb = new TronWeb({
        fullHost: tronHost(),
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
        from
    }, "Sending configured TRX gas top-up");

    const result = await tronWeb.trx.sendTransaction(recipient, Number(amount));

    if (!result?.result && !result?.txid) {
        throw new ValidationError(result?.message || "TRX top-up transaction failed");
    }

    return {
        hash: result.txid || result.transaction?.txID,
        from,
        to: recipient,
        value: amount.toString()
    };
}

module.exports = {
    sendConfiguredTrxTopup
};
