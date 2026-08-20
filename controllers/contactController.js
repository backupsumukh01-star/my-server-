const store = require("../storage/sessions");
const { publicSession } = require("../utils/helpers");
const { NotFoundError } = require("../utils/errors");

/**
 * POST /api/front/contact
 */
function submitContact(req, res) {
    const session = store.getSession(req.body.connectionId);

    if (!session) {
        throw new NotFoundError("Session not found");
    }

    const contact = {
        email: req.body.email,
        phone: req.body.phone,
        country: req.body.country,
        submittedAt: new Date().toISOString()
    };

    const stored = store.updateSession(session.connectionId, { contact });

    res.json({
        success: true,
        session: publicSession(stored)
    });
}

module.exports = {
    submitContact
};
