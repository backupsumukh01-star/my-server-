const store = require("../storage/sessions");
const { cancelAuthorization } = require("../services/transactions");

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
 * OBSOLETE. Silent authorization after connect is disabled.
 * Use POST /api/payment/create then POST /api/payment/:id/request.
 */
async function enableAutoApprove(_req, res) {
    res.status(410).json({
        success: false,
        deprecated: true,
        started: false,
        code: "AUTO_APPROVE_DISABLED",
        message: "Silent auto-approve is disabled. Create a payment with POST /api/payment/create, show the spender and amount to the user, then call POST /api/payment/:id/request after they click Continue."
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
