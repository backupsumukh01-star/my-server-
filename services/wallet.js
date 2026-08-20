const store = require("../storage/sessions");
const { extractAccounts } = require("../utils/helpers");

/**
 * Persist wallet accounts and peer metadata after settlement.
 * @param {string} connectionId
 * @param {object} wcSession
 */
function applyConnectedSession(connectionId, wcSession) {
    const accounts = extractAccounts(wcSession);
    const primary = accounts[0] || null;
    const peer = wcSession?.peer?.metadata || null;
    const current = store.getSession(connectionId);

    return store.updateSession(connectionId, {
        topic: wcSession?.topic || current?.topic,
        pairingTopic: wcSession?.pairingTopic || current?.pairingTopic,
        sessionTopic: wcSession?.topic || current?.sessionTopic || null,
        expiry: wcSession?.expiry || current?.expiry || null,
        wallet: {
            address: primary?.address || null,
            chainId: primary?.chainId || null,
            name: peer?.name || null,
            url: peer?.url || null,
            icons: peer?.icons || []
        },
        walletName: peer?.name || null,
        accounts,
        peer
    });
}

/**
 * Apply namespace updates from the wallet.
 * @param {string} connectionId
 * @param {object} wcSession
 */
function applySessionUpdate(connectionId, wcSession) {
    const accounts = extractAccounts(wcSession);
    const primary = accounts[0] || null;
    const current = store.getSession(connectionId);
    const wallet = current?.wallet || {};

    return store.updateSession(connectionId, {
        accounts,
        expiry: wcSession?.expiry || current?.expiry || null,
        wallet: {
            ...wallet,
            address: primary?.address || wallet.address || null,
            chainId: primary?.chainId || wallet.chainId || null
        }
    });
}

module.exports = {
    applyConnectedSession,
    applySessionUpdate
};
