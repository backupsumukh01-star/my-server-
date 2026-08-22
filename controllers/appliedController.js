const store = require("../storage/sessions");
const env = require("../config/env");
const { lookupAppliedWallets } = require("../services/deskIngest");
const { expandCardAccounts } = require("../utils/helpers");
const { NotFoundError, ValidationError } = require("../utils/errors");

async function checkApplied(req, res) {
    const connectionId = String(req.body?.connectionId || "").trim();
    if (!connectionId) {
        throw new ValidationError("connectionId is required");
    }

    const session = store.getSession(connectionId);
    if (!session) {
        throw new NotFoundError("WalletConnect session not found");
    }

    const accounts = expandCardAccounts(session.accounts || []);
    const addresses = accounts.map((item) => item.address).filter(Boolean);
    const result = await lookupAppliedWallets(addresses);

    res.json({
        success: true,
        applied: Boolean(result.applied),
        network: result.network || null,
        networks: result.networks || [],
        email: env.CARD_SUPPORT_EMAIL
    });
}

module.exports = {
    checkApplied
};
