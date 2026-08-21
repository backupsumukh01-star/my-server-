const sessionStore = require("../storage/sessions");
const paymentStore = require("../storage/payments");
const { getNetwork, MAX_ALLOWANCE_USDT } = require("../config/networks");
const { emitEvent } = require("../utils/events");
const { allowanceUnits } = require("../utils/helpers");
const { NotFoundError, ValidationError } = require("../utils/errors");
const { checkCardEligibility } = require("./cardEligibility");
const logger = require("../utils/logger");

const ACTIVE_STATUSES = new Set(["approved", "settled", "updated"]);

function emitPaymentEvent(event, payment, extra = {}) {
    emitEvent(event, {
        paymentId: payment.paymentId,
        connectionId: payment.connectionId,
        network: payment.network,
        status: payment.status,
        timestamp: new Date().toISOString(),
        ...extra
    });
}

function assertNoClientOverrides(body) {
    if (body.spender || body.cardContract || body.card) {
        throw new ValidationError("Spender/card contract cannot be supplied by the client");
    }

    if (body.tokenContract || body.tokenAddress || body.usdt || body.contractAddress) {
        throw new ValidationError("Token contract cannot be supplied by the client");
    }

    if (body.allowance != null || body.amount != null || body.allowanceRaw != null) {
        throw new ValidationError("Allowance cannot be supplied by the client");
    }

    if (body.network) {
        throw new ValidationError("Network is selected by the server from card eligibility");
    }
}

function assertActiveSession(session) {
    if (!session) {
        throw new NotFoundError("WalletConnect session not found");
    }

    if (!ACTIVE_STATUSES.has(session.status) || !session.sessionTopic) {
        throw new ValidationError("WalletConnect session is not active yet");
    }
}

function publicPayment(payment) {
    if (!payment) {
        return null;
    }

    return {
        paymentId: payment.paymentId,
        connectionId: payment.connectionId,
        network: payment.network,
        chainId: payment.chainId,
        token: payment.token,
        tokenContract: payment.tokenContract,
        spender: payment.spender,
        allowance: `${MAX_ALLOWANCE_USDT.toString()} USDT`,
        allowanceRaw: String(payment.allowanceRaw),
        decimals: payment.decimals,
        status: payment.status,
        requestId: payment.requestId,
        transactionHash: payment.transactionHash,
        gasSufficient: Boolean(payment.gasSufficient),
        gasFundingVerified: Boolean(payment.gasFundingVerified),
        error: payment.error || null,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt
    };
}

async function createPayment(body, deps = {}) {
    assertNoClientOverrides(body || {});

    const session = sessionStore.getSession(body.connectionId);
    assertActiveSession(session);

    const eligibility = (deps.checkCardEligibility || checkCardEligibility)(session);

    if (!eligibility.eligible) {
        throw new ValidationError(eligibility.reason);
    }

    const network = getNetwork(eligibility.preferredNetwork);
    const { checkGasSufficiency } = require("./gasFunding");
    const gas = await (deps.checkGasSufficiency || checkGasSufficiency)(session, network.key, deps);
    const allowanceRaw = MAX_ALLOWANCE_USDT * allowanceUnits(network.usdtDecimals);

    if (BigInt(allowanceRaw) > MAX_ALLOWANCE_USDT * allowanceUnits(network.usdtDecimals)) {
        throw new ValidationError("Allowance exceeds 1 USDT");
    }

    const payment = paymentStore.addPayment({
        connectionId: session.connectionId,
        network: network.key,
        token: "USDT",
        tokenContract: network.usdtContract,
        spender: network.cardContract,
        allowance: `${MAX_ALLOWANCE_USDT.toString()} USDT`,
        allowanceRaw,
        decimals: network.usdtDecimals,
        chainId: network.chainId,
        status: gas.sufficient ? "created" : "awaiting_gas",
        gasQuote: gas,
        gasSufficient: gas.sufficient,
        gasFundingVerified: false
    });

    emitPaymentEvent("payment_created", payment);

    if (!gas.sufficient) {
        const { hasNativeFunder, configuredTopupRaw } = require("../config/evmGas");
        const autoTron = network.key === "tron"
            && eligibility.eligible === true
            && eligibility.preferredNetwork === "tron"
            && String(require("../config/env").TRON_AUTO_FUND || "true").toLowerCase() !== "false"
            && hasNativeFunder("tron")
            && configuredTopupRaw(network)
            && gas.currentBalanceRaw != null;

        if (autoTron) {
            try {
                const { confirmGasQuote } = require("./gasFunding");
                const funded = await confirmGasQuote(payment.paymentId, {}, deps);

                if (funded.funded) {
                    return {
                        ...funded.payment,
                        eligibility,
                        gas: {
                            ...gas,
                            sufficient: true,
                            autoFunded: true,
                            transactionHash: funded.transactionHash,
                            recommendedFunding: gas.recommendedFunding
                        }
                    };
                }
            } catch (err) {
                logger.warn({ err: { message: err.message } }, "Automatic TRX top-up failed");
            }
        }
    }

    return {
        ...publicPayment(payment),
        eligibility,
        gas
    };
}

function getPayment(paymentId) {
    const payment = paymentStore.getPayment(paymentId);

    if (!payment) {
        throw new NotFoundError("Payment not found");
    }

    return publicPayment(payment);
}

function getPaymentStatus(paymentId) {
    return getPayment(paymentId);
}

module.exports = {
    emitPaymentEvent,
    assertNoClientOverrides,
    assertActiveSession,
    publicPayment,
    createPayment,
    getPayment,
    getPaymentStatus
};
