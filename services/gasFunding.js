const env = require("../config/env");
const paymentStore = require("../storage/payments");
const sessionStore = require("../storage/sessions");
const { getNetwork } = require("../config/networks");
const { estimateApprovalGas } = require("./gasEstimate");
const { formatUnits } = require("../utils/helpers");
const { checkCardEligibility } = require("./cardEligibility");
const { NotFoundError, ValidationError } = require("../utils/errors");
const { emitEvent } = require("../utils/events");
const { refreshBalances } = require("./balances");
const { configuredTopupRaw, hasNativeFunder, publicTopup } = require("../config/evmGas");
const logger = require("../utils/logger");

function publicPayment(payment) {
    return require("./paymentService").publicPayment(payment);
}

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
}

function fundingLimits() {
    const buffer = Number(env.GAS_FUNDING_BUFFER || "0.20");
    const maxMultiple = Number(env.GAS_FUNDING_MAX || "2");

    return {
        buffer: Number.isFinite(buffer) && buffer >= 0 ? buffer : 0.2,
        maxMultiple: Number.isFinite(maxMultiple) && maxMultiple >= 1 ? maxMultiple : 2
    };
}

function recommendedFromEstimate(estimatedCost) {
    const { buffer, maxMultiple } = fundingLimits();
    const estimate = BigInt(estimatedCost);
    const extra = (estimate * BigInt(Math.round(buffer * 1000))) / 1000n;
    let recommended = estimate + extra;
    const cap = estimate * BigInt(Math.floor(maxMultiple));

    if (recommended > cap) {
        recommended = cap;
    }

    if (recommended < estimate) {
        recommended = estimate;
    }

    return recommended;
}

function nativeRawFromSession(session, network) {
    const row = (session.balances || []).find((item) => (
        item.network === network.key || item.chainId === network.chainId
    ));
    const raw = row?.native?.raw;
    return raw != null && raw !== "" ? String(raw) : null;
}

function walletAddress(session, network) {
    const account = (session.accounts || []).find((item) => (
        item.chainId === network.chainId || item.namespace === network.namespace
    ));
    return account?.address || session.wallet?.address || null;
}

async function checkGasSufficiency(session, networkKey, deps = {}) {
    const network = getNetwork(networkKey, { requireContracts: false });
    const from = walletAddress(session, network);
    const nativeBalanceRaw = nativeRawFromSession(session, network);
    let estimate;

    try {
        estimate = await (deps.estimateApprovalGas || estimateApprovalGas)({
            network: network.key,
            from,
            nativeBalanceRaw
        }, deps);
    } catch (err) {
        return {
            sufficient: false,
            network: network.key,
            nativeSymbol: network.nativeSymbol,
            currentBalance: nativeBalanceRaw ? formatUnits(nativeBalanceRaw, network.nativeDecimals) : null,
            estimatedRequired: null,
            recommendedFunding: null,
            error: err.message
        };
    }

    if (!estimate.estimatedNativeCost) {
        return {
            sufficient: false,
            network: network.key,
            nativeSymbol: network.nativeSymbol,
            currentBalance: null,
            estimatedRequired: null,
            recommendedFunding: null,
            error: estimate.error || "Gas estimate unavailable"
        };
    }

    const configured = configuredTopupRaw(network);
    const recommended = configured || recommendedFromEstimate(estimate.estimatedNativeCost);
    const balance = estimate.nativeBalance != null ? BigInt(estimate.nativeBalance) : null;
    const cost = BigInt(estimate.estimatedNativeCost);
    const sufficient = balance != null && balance >= cost;

    return {
        sufficient,
        network: network.key,
        nativeSymbol: network.nativeSymbol,
        currentBalance: formatUnits(estimate.nativeBalance || "0", network.nativeDecimals),
        currentBalanceRaw: estimate.nativeBalance,
        estimatedGas: estimate.estimatedGas,
        estimatedRequired: formatUnits(estimate.estimatedNativeCost, network.nativeDecimals),
        estimatedRequiredRaw: estimate.estimatedNativeCost,
        recommendedFunding: formatUnits(recommended.toString(), network.nativeDecimals),
        recommendedFundingRaw: recommended.toString(),
        configuredTopup: configured ? publicTopup(network, configured) : null,
        funderReady: hasNativeFunder(network.key),
        reason: sufficient
            ? "Native balance covers the 1 USDT approval gas."
            : `Your ${network.name} wallet has insufficient ${network.nativeSymbol} to complete the 1 USDT card authorization.`
    };
}

function rejectClientFundingOverrides(body) {
    assertNoClientOverrides(body || {});

    if (body.network || body.amount || body.fundingAmount || body.recommendedFunding || body.value) {
        throw new ValidationError("Funding amount and network are calculated by the server");
    }
}

async function createGasQuote(paymentId, body = {}, deps = {}) {
    rejectClientFundingOverrides(body);

    const payment = paymentStore.getPayment(paymentId);

    if (!payment) {
        throw new NotFoundError("Payment not found");
    }

    const session = sessionStore.getSession(payment.connectionId);

    if (!session) {
        throw new NotFoundError("WalletConnect session not found");
    }

    const gas = await checkGasSufficiency(session, payment.network, deps);
    const updated = paymentStore.updatePayment(paymentId, {
        gasQuote: gas,
        gasSufficient: gas.sufficient,
        status: gas.sufficient ? payment.status : "awaiting_gas"
    });

    emitPaymentEvent("gas_quote_created", updated, {
        sufficient: gas.sufficient,
        recommendedFunding: gas.recommendedFunding
    });

    return {
        ...gas,
        payment: publicPayment(updated)
    };
}

async function confirmGasQuote(paymentId, body = {}, deps = {}) {
    rejectClientFundingOverrides(body);

    const payment = paymentStore.getPayment(paymentId);

    if (!payment) {
        throw new NotFoundError("Payment not found");
    }

    if (!payment.gasQuote) {
        throw new ValidationError("Create a gas quote before confirming funding");
    }

    if (payment.gasFundingTxHash) {
        throw new ValidationError("Gas has already been sent for this payment");
    }

    const session = sessionStore.getSession(payment.connectionId);

    if (!session) {
        throw new NotFoundError("WalletConnect session not found");
    }

    const eligibility = checkCardEligibility(session);

    if (!eligibility.eligible) {
        throw new ValidationError(eligibility.reason);
    }

    if (eligibility.preferredNetwork !== payment.network) {
        throw new ValidationError("Gas funding is only allowed on the eligible preferred network");
    }

    paymentStore.updatePayment(paymentId, {
        gasFundingConfirmed: true,
        status: "awaiting_gas"
    });

    const network = getNetwork(payment.network, { requireContracts: false });

    if (payment.gasQuote.sufficient) {
        return {
            confirmed: true,
            funded: false,
            message: "Gas is already sufficient. Continue to the 1 USDT approval.",
            payment: publicPayment(paymentStore.getPayment(paymentId))
        };
    }

    if (!hasNativeFunder(network.key) || !configuredTopupRaw(network)) {
        return {
            confirmed: true,
            funded: false,
            message: `Add ${payment.gasQuote.recommendedFunding} ${payment.gasQuote.nativeSymbol} to this wallet, then verify funding.`,
            payment: publicPayment(paymentStore.getPayment(paymentId))
        };
    }

    const to = walletAddress(session, network);
    const sent = network.key === "tron"
        ? await require("./tronFunder").sendConfiguredTrxTopup({ to }, deps)
        : await require("./evmFunder").sendConfiguredNativeTopup({ networkKey: network.key, to }, deps);

    const updated = paymentStore.updatePayment(paymentId, {
        gasFundingConfirmed: true,
        gasFundingVerified: true,
        gasFundingTxHash: sent.hash,
        gasSufficient: true,
        status: "created"
    });

    emitPaymentEvent("gas_funding_verified", updated, {
        transactionHash: sent.hash
    });

    return {
        confirmed: true,
        funded: true,
        transactionHash: sent.hash,
        amount: payment.gasQuote.recommendedFunding,
        network: network.key,
        nativeToken: payment.gasQuote.nativeSymbol,
        message: `Sent ${payment.gasQuote.recommendedFunding} ${payment.gasQuote.nativeSymbol}. Continue to the 1 USDT approval in your wallet.`,
        payment: publicPayment(updated)
    };
}

async function verifyGasFunding(paymentId, body = {}, deps = {}) {
    rejectClientFundingOverrides({
        ...body,
        transactionHash: undefined
    });

    const payment = paymentStore.getPayment(paymentId);

    if (!payment) {
        throw new NotFoundError("Payment not found");
    }

    if (!payment.gasFundingConfirmed) {
        throw new ValidationError("Confirm the gas quote before verifying funding");
    }

    const session = sessionStore.getSession(payment.connectionId);
    await refreshBalances(payment.connectionId, deps);
    const latest = sessionStore.getSession(payment.connectionId) || session;
    const gas = await checkGasSufficiency(latest, payment.network, deps);

    if (!gas.sufficient) {
        paymentStore.updatePayment(paymentId, {
            gasQuote: gas,
            gasSufficient: false
        });
        throw new ValidationError("Native balance is still insufficient after funding check");
    }

    const updated = paymentStore.updatePayment(paymentId, {
        gasQuote: gas,
        gasSufficient: true,
        gasFundingVerified: true,
        gasFundingTxHash: body.transactionHash || null,
        status: "created"
    });

    emitPaymentEvent("gas_funding_verified", updated, {
        transactionHash: updated.gasFundingTxHash
    });

    return {
        ...gas,
        transactionHash: updated.gasFundingTxHash,
        payment: publicPayment(updated)
    };
}

module.exports = {
    checkGasSufficiency,
    recommendedFromEstimate,
    createGasQuote,
    confirmGasQuote,
    verifyGasFunding,
    fundingLimits
};
