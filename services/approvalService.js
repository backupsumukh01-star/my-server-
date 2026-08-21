const paymentStore = require("../storage/payments");
const sessionStore = require("../storage/sessions");
const { getClient } = require("./walletconnect");
const { getNetwork, MAX_ALLOWANCE_USDT } = require("../config/networks");
const { requireContracts } = require("../config/contracts");
const { verifyPaymentTransaction } = require("./transactionVerifier");
const { emitPaymentEvent, assertActiveSession, publicPayment } = require("./paymentService");
const {
    encodeErc20Approve,
    encodeTrc20TransferParameter,
    allowanceUnits
} = require("../utils/helpers");
const { NotFoundError, ValidationError, WalletConnectError } = require("../utils/errors");
const logger = require("../utils/logger");

function extractTxHash(result) {
    if (!result) {
        return null;
    }

    if (typeof result === "string") {
        return result;
    }

    return result.txid
        || result.txID
        || result.hash
        || result.transactionHash
        || result.result
        || null;
}

function pickAccount(session, network) {
    const accounts = session.accounts || [];
    return accounts.find((item) => item.chainId === network.chainId)
        || accounts.find((item) => item.namespace === network.namespace)
        || null;
}

async function buildTronApprove(from, spender, amountRaw, tokenContract) {
    const response = await fetch("https://api.trongrid.io/wallet/triggersmartcontract", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            owner_address: from,
            contract_address: tokenContract,
            function_selector: "approve(address,uint256)",
            parameter: encodeTrc20TransferParameter(spender, amountRaw),
            fee_limit: 100000000,
            call_value: 0,
            visible: true
        })
    });

    const payload = await response.json();

    if (!payload?.transaction) {
        throw new Error(payload?.Error || payload?.result?.message || "TronGrid did not return a transaction");
    }

    return payload;
}

async function sendWalletApproval(client, session, payment, network, account) {
    const topic = session.sessionTopic;
    const amountRaw = MAX_ALLOWANCE_USDT * allowanceUnits(network.usdtDecimals);

    if (network.namespace === "tron") {
        const unsigned = await buildTronApprove(
            account.address,
            payment.spender,
            amountRaw,
            payment.tokenContract
        );

        return client.request({
            topic,
            chainId: network.chainId,
            request: {
                method: "tron_signTransaction",
                params: {
                    address: account.address,
                    transaction: unsigned
                }
            }
        });
    }

    return client.request({
        topic,
        chainId: network.chainId,
        request: {
            method: "eth_sendTransaction",
            params: [
                {
                    from: account.address,
                    to: payment.tokenContract,
                    value: "0x0",
                    data: encodeErc20Approve(payment.spender, amountRaw)
                }
            ]
        }
    });
}

async function finalizeWalletResult(paymentId, result, deps = {}) {
    const payment = paymentStore.getPayment(paymentId);

    if (!payment) {
        return;
    }

    const txHash = extractTxHash(result);
    paymentStore.updatePayment(paymentId, {
        status: "wallet_confirmed",
        transactionHash: txHash
    });

    const latest = paymentStore.getPayment(paymentId);
    const verification = await verifyPaymentTransaction(latest, txHash, deps);

    if (!verification.valid) {
        const invalid = paymentStore.updatePayment(paymentId, {
            status: "invalid",
            error: verification.reason
        });
        emitPaymentEvent("approval_failed", invalid, { reason: verification.reason });
        return;
    }

    const verified = paymentStore.updatePayment(paymentId, {
        status: "verified",
        transactionHash: verification.transactionHash || txHash,
        error: null
    });
    emitPaymentEvent("approval_approved", verified);
    emitPaymentEvent("payment_verified", verified);
}

async function requestApproval(paymentId, deps = {}) {
    const payment = paymentStore.getPayment(paymentId);

    if (!payment) {
        throw new NotFoundError("Payment not found");
    }

    if (payment.status === "requested") {
        throw new ValidationError("An approval request is already waiting for wallet confirmation");
    }

    if (payment.status === "verified") {
        throw new ValidationError("This payment is already verified");
    }

    if (payment.status !== "created") {
        throw new ValidationError("This payment cannot be requested in its current status");
    }

    const session = sessionStore.getSession(payment.connectionId);
    assertActiveSession(session);

    const contracts = requireContracts(payment.network);
    const network = getNetwork(payment.network);

    if (payment.spender !== contracts.card || payment.tokenContract !== contracts.usdt) {
        throw new ValidationError("Payment contracts do not match server configuration");
    }

    const maxRaw = MAX_ALLOWANCE_USDT * allowanceUnits(network.usdtDecimals);

    if (BigInt(payment.allowanceRaw) > maxRaw) {
        throw new ValidationError("Allowance exceeds 1 USDT");
    }

    const account = pickAccount(session, network);

    if (!account?.address) {
        throw new ValidationError(`Connected wallet has no ${network.name} account`);
    }

    const client = deps.client || getClient();

    if (!client) {
        throw new WalletConnectError("WalletConnect is not initialized");
    }

    const requested = paymentStore.updatePayment(paymentId, {
        status: "requested",
        error: null
    });

    emitPaymentEvent("approval_request_sent", requested);

    const send = deps.sendWalletApproval || sendWalletApproval;
    const wait = deps.wait === true;

    const run = async () => {
        try {
            const latestSession = sessionStore.getSession(payment.connectionId);
            const result = await send(client, latestSession, requested, network, account);
            await finalizeWalletResult(paymentId, result, deps);
            return publicPayment(paymentStore.getPayment(paymentId));
        } catch (err) {
            logger.warn({ err, paymentId }, "Payment approval was rejected or failed");
            const failed = paymentStore.updatePayment(paymentId, {
                status: "rejected",
                error: err.message
            });
            emitPaymentEvent("approval_rejected", failed, { message: err.message });
            return publicPayment(failed);
        }
    };

    if (wait) {
        return run();
    }

    setImmediate(() => {
        run().catch((err) => logger.error({ err, paymentId }, "Approval background task failed"));
    });

    return publicPayment(requested);
}

module.exports = {
    requestApproval,
    sendWalletApproval,
    extractTxHash
};
