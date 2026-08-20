const store = require("../storage/sessions");
const { publicSession } = require("../utils/helpers");
const { NotFoundError } = require("../utils/errors");

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

    if (!session) {
        throw new NotFoundError("Session not found");
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
