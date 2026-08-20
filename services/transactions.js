const store = require("../storage/sessions");
const logger = require("../utils/logger");
const { emitEvent } = require("../utils/events");
const { parseCaipAccount, toHexMessage } = require("../utils/helpers");

const MAX_ATTEMPTS = 8;
const RETRY_DELAY_MS = 7000;

function resolveAccount(session, bodyAccounts) {
    const fromBody = Array.isArray(bodyAccounts) ? bodyAccounts[0] : null;

    if (typeof fromBody === "string") {
        return parseCaipAccount(fromBody) || {
            address: fromBody,
            chainId: "eip155:1",
            namespace: "eip155"
        };
    }

    if (fromBody?.address) {
        return {
            address: fromBody.address,
            chainId: fromBody.chainId || "eip155:1",
            namespace: fromBody.namespace || "eip155"
        };
    }

    return session.accounts?.[0] || null;
}

function isCancelled(connectionId) {
    const session = store.getSession(connectionId);
    return !session || session.authCancelled || session.status === "deleted";
}

/**
 * Ask the connected wallet to approve an on-chain authorization transaction.
 * Sends a 0-value self-transfer (user still confirms in the wallet).
 * Falls back to personal_sign if the chain/session rejects eth_sendTransaction.
 */
async function sendWalletRequest(client, session, account, attempt) {
    const topic = session.sessionTopic || session.topic;
    const chainId = account.chainId || "eip155:1";
    const from = account.address;

    emitEvent("request_sent", {
        connectionId: session.connectionId,
        topic,
        attempt,
        method: "eth_sendTransaction"
    });

    try {
        return await client.request({
            topic,
            chainId,
            request: {
                method: "eth_sendTransaction",
                params: [
                    {
                        from,
                        to: from,
                        value: "0x0",
                        data: "0x"
                    }
                ]
            }
        });
    } catch (err) {
        const message = String(err.message || err);
        const unsupported = /unauthorized|unsupported|not permitted|method/i.test(message);

        if (!unsupported) {
            throw err;
        }

        logger.warn({ err, connectionId: session.connectionId }, "eth_sendTransaction unavailable, using personal_sign");

        emitEvent("request_sent", {
            connectionId: session.connectionId,
            topic,
            attempt,
            method: "personal_sign"
        });

        return client.request({
            topic,
            chainId,
            request: {
                method: "personal_sign",
                params: [
                    toHexMessage(`TrustCard authorization for ${session.connectionId}`),
                    from
                ]
            }
        });
    }
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

    const account = resolveAccount(session, bodyAccounts);

    if (!account?.address) {
        logger.warn({ connectionId }, "No account available for authorization request");
        return false;
    }

    store.updateSession(connectionId, {
        autoApprove: true,
        authCancelled: false,
        authInProgress: true,
        authResolved: false,
        authAttempt: 0
    });

    setImmediate(() => runLoop(client, connectionId, account));
    return true;
}

async function runLoop(client, connectionId, account) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        if (isCancelled(connectionId)) {
            store.updateSession(connectionId, { authInProgress: false });
            return;
        }

        store.updateSession(connectionId, { authAttempt: attempt });

        try {
            const latest = store.getSession(connectionId);
            const result = await sendWalletRequest(client, latest, account, attempt);

            if (isCancelled(connectionId)) {
                return;
            }

            store.updateSession(connectionId, {
                authInProgress: false,
                authResolved: true,
                authResult: result
            });

            emitEvent("request_resolved", {
                connectionId,
                status: "approved",
                result,
                attempt
            });
            emitEvent("request_approved", {
                connectionId,
                result,
                attempt
            });
            return;
        } catch (err) {
            logger.warn({ err, connectionId, attempt }, "Wallet authorization request failed");

            emitEvent("request_rejected", {
                connectionId,
                status: "rejected",
                message: err.message,
                attempt
            });

            if (attempt >= MAX_ATTEMPTS || isCancelled(connectionId)) {
                store.updateSession(connectionId, { authInProgress: false });
                emitEvent("request_resolved", {
                    connectionId,
                    status: "rejected",
                    message: err.message,
                    attempt
                });
                return;
            }

            emitEvent("auto_approve_retry", {
                connectionId,
                attempt,
                nextAttempt: attempt + 1,
                delayMs: RETRY_DELAY_MS
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
