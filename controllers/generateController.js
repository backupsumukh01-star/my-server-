const { createPairing } = require("../services/walletconnect");
const { WalletConnectError } = require("../utils/errors");
const logger = require("../utils/logger");

/**
 * POST /api/front/generate
 */
async function generate(req, res) {
    try {
        const session = await createPairing({
            autoApprove: Boolean(req.body?.autoApprove)
        });

        res.json({
            connectionId: session.connectionId,
            topic: session.topic,
            uri: session.uri,
            qr: session.qr,
            createdAt: session.createdAt,
            status: session.status
        });
    } catch (err) {
        logger.error({ err }, "Failed to generate pairing");
        throw new WalletConnectError(err.message);
    }
}

module.exports = {
    generate
};
