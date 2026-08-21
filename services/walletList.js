const env = require("../config/env");
const logger = require("../utils/logger");

const FALLBACK_WALLETS = [
    { id: "trust", name: "Trust Wallet", native: "trust://", universal: "https://link.trustwallet.com" },
    { id: "metamask", name: "MetaMask", native: "metamask://", universal: "https://metamask.app.link" },
    { id: "coinbase", name: "Coinbase Wallet", native: "cbwallet://", universal: "https://go.cb-w.com" },
    { id: "rainbow", name: "Rainbow", native: "rainbow://", universal: "https://rainbow.me" },
    { id: "okx", name: "OKX Wallet", native: "okex://main/", universal: "https://www.okx.com/download" },
    { id: "bitget", name: "Bitget Wallet", native: "bitkeep://", universal: "https://bkcode.vip" },
    { id: "tokenpocket", name: "TokenPocket", native: "tpoutside://", universal: "https://www.tokenpocket.pro" },
    { id: "imtoken", name: "imToken", native: "imtokenv2://", universal: "https://token.im" },
    { id: "safepal", name: "SafePal", native: "safepalwallet://", universal: "https://www.safepal.com" },
    { id: "phantom", name: "Phantom", native: "phantom://", universal: "https://phantom.app/ul" }
];

function publicWallet(wallet) {
    return {
        id: wallet.id,
        name: wallet.name,
        image: wallet.image || null,
        native: wallet.native || "",
        universal: wallet.universal || ""
    };
}

async function listMobileWallets(deps = {}) {
    const fetchImpl = deps.fetchImpl || fetch;
    const projectId = env.PROJECT_ID;

    try {
        const url = `https://explorer-api.walletconnect.com/v3/wallets?projectId=${encodeURIComponent(projectId)}&entries=24&page=1&sdks=sign_v2`;
        const response = await fetchImpl(url, { headers: { Accept: "application/json" } });

        if (!response.ok) {
            throw new Error(`Explorer ${response.status}`);
        }

        const body = await response.json();
        const listings = body.listings || {};
        const wallets = Object.values(listings)
            .map((item) => ({
                id: item.id || item.slug || item.name,
                name: item.name,
                image: item.image_id && projectId
                    ? `https://explorer-api.walletconnect.com/v3/logo/md/${item.image_id}?projectId=${encodeURIComponent(projectId)}`
                    : null,
                native: item.mobile?.native || "",
                universal: item.mobile?.universal || ""
            }))
            .filter((item) => item.name && (item.native || item.universal))
            .slice(0, 24);

        if (wallets.length) {
            return wallets.map(publicWallet);
        }
    } catch (err) {
        logger.warn({ err: { message: err.message } }, "WalletConnect explorer listing failed; using fallback wallets");
    }

    return FALLBACK_WALLETS.map(publicWallet);
}

module.exports = {
    listMobileWallets,
    FALLBACK_WALLETS
};
