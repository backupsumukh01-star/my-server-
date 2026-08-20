const store = require("../storage/sessions");
const { publicSession } = require("../utils/helpers");
const { NotFoundError } = require("../utils/errors");

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
 * Compatibility flag only. Does not send wallet signing requests.
 */
function enableAutoApprove(req, res) {
    const session = findSession(req.body);

    if (!session) {
        throw new NotFoundError("Session not found");
    }

    store.updateSession(session.connectionId, { autoApprove: true });

    res.json({
        success: true,
        started: false,
        message: "Wallet connected. Approval in the wallet is still required for any signature."
    });
}

/**
 * POST /api/front/auto-approve/cancel
 */
function cancelAutoApprove(req, res) {
    const session = findSession(req.body);

    if (session) {
        store.updateSession(session.connectionId, { autoApprove: false });
    }

    res.json({ success: true, cancelled: true });
}

module.exports = {
    enableAutoApprove,
    cancelAutoApprove
};
