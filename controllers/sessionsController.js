const store = require("../storage/sessions");
const { publicSession } = require("../utils/helpers");

/**
 * GET /api/front/sessions
 */
function listSessions(req, res) {
    res.json({
        success: true,
        sessions: store.getSessions().map(publicSession)
    });
}

/**
 * GET /api/front/session/:id
 */
function getSession(req, res) {
    const session = store.getSession(req.params.id);

    // Polling often races a fresh pairing or a restarted instance.
    // Return an empty session payload instead of throwing so logs stay clean.
    if (!session) {
        return res.status(200).json({
            success: true,
            session: null,
            missing: true
        });
    }

    res.json({
        success: true,
        session: publicSession(session)
    });
}

module.exports = {
    listSessions,
    getSession
};
