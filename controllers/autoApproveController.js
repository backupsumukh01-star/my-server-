const store = require("../storage/sessions");
const { publicSession } = require("../utils/helpers");
const { NotFoundError } = require("../utils/errors");

/**
 * POST /api/front/auto-approve
 * Stores an autoApprove flag only. Does not send wallet requests or sign anything.
 */
function enableAutoApprove(req, res) {
    const connectionId = req.body.connectionId || req.body.id;
    const session = store.getSession(connectionId);

    if (!session) {
        throw new NotFoundError("Session not found");
    }

    const stored = store.updateSession(connectionId, { autoApprove: true });

    res.json({
        success: true,
        message: "Auto approve flag stored. Wallet approval is still required.",
        session: publicSession(stored)
    });
}

module.exports = {
    enableAutoApprove
};
