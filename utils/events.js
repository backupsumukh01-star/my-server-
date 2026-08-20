const store = require("../storage/sessions");
const logger = require("./logger");

/**
 * Broadcast a named SSE event to every connected browser.
 * @param {string} event
 * @param {object} [data]
 */
function emitEvent(event, data) {
    logger.info({ event, connectionId: data?.connectionId, topic: data?.topic }, "SSE event");
    store.broadcast(event, data);
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
