const store = require("../storage/sessions");
const logger = require("./logger");

const EVENT_ALIASES = {
    session_settled: ["wallet_connected"],
    approval_request_sent: ["approval_requested"],
    approval_approved: ["approval_success"],
    gas_funding_verified: ["gas_topup_confirmed"]
};

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

function attachClient(res) {
    store.addClient(res);
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
    clientCount
};
