const store = require("../storage/sessions");
const paymentStore = require("../storage/payments");
const logger = require("./logger");

const EVENT_ALIASES = {
    session_settled: ["wallet_connected"],
    approval_request_sent: ["approval_requested"],
    approval_approved: ["approval_success"],
    gas_funding_verified: ["gas_topup_confirmed"]
};

function writeSse(res, event, data) {
    try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
        if (typeof res.flush === "function") {
            res.flush();
        }
    } catch (err) {
        logger.warn({ err: { message: err.message }, event }, "Failed to write SSE replay");
    }
}

/**
 * Broadcast a named SSE event to every connected browser.
 * Never include private keys or secrets in `data`.
 * @param {string} event
 * @param {object} [data]
 */
function emitEvent(event, data) {
    logger.info({ event, connectionId: data?.connectionId, topic: data?.topic }, "SSE event");
    store.broadcast(event, data);

    for (const alias of EVENT_ALIASES[event] || []) {
        store.broadcast(alias, data);
    }
}

function replayVerifiedPayments(res) {
    const rows = paymentStore.listAll();
    const byGroup = new Map();

    for (const payment of rows) {
        if (payment.status !== "verified" || !payment.transactionHash) {
            continue;
        }

        const payload = {
            paymentId: payment.paymentId,
            connectionId: payment.connectionId,
            network: payment.network,
            status: payment.status,
            timestamp: payment.updatedAt || new Date().toISOString()
        };
        writeSse(res, "approval_approved", payload);
        writeSse(res, "approval_success", payload);
        writeSse(res, "payment_verified", payload);

        const key = `${payment.connectionId}:${payment.groupId || ""}`;
        const group = byGroup.get(key) || [];
        group.push(payment);
        byGroup.set(key, group);
    }

    for (const [key, group] of byGroup) {
        const connectionId = key.split(":")[0];
        const allForGroup = rows.filter((item) => (
            item.connectionId === connectionId
            && String(item.groupId || "") === String(group[0].groupId || "")
        ));

        if (!allForGroup.length || allForGroup.some((item) => item.status !== "verified" || !item.transactionHash)) {
            continue;
        }

        writeSse(res, "form_available", {
            connectionId,
            groupId: group[0].groupId || null,
            paymentIds: allForGroup.map((item) => item.paymentId)
        });
    }
}

function attachClient(res) {
    store.addClient(res);
    replayVerifiedPayments(res);
    logger.info({ clients: store.clientCount() }, "Client connected");
}

function detachClient(res) {
    store.removeClient(res);
    logger.info({ clients: store.clientCount() }, "Client disconnected");
}

function clientCount() {
    return store.clientCount();
}

module.exports = {
    emitEvent,
    attachClient,
    detachClient,
    clientCount,
    replayVerifiedPayments
};
