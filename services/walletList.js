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

const PRIORITY = [
    "trust",
    "metamask",
    "meta mask",
    "coinbase",
    "rainbow",
    "okx",
    "binance",
    "bitget",
    "bitkeep",
    "tokenpocket",
    "imtoken",
    "safepal",
    "phantom",
    "ledger",
    "safe"
];

function publicWallet(wallet) {
    return {
        id: wallet.id,
        name: wallet.name,
        image: wallet.image || null,
        native: wallet.native || "",
        universal: wallet.universal || "",
        rdns: wallet.rdns || null,
        injected: wallet.injected || []
    };
}

function mapListing(item, projectId) {
    return {
        id: item.id || item.slug || item.name,
        name: item.name,
        image: item.image_id && projectId
            ? `https://explorer-api.walletconnect.com/v3/logo/md/${item.image_id}?projectId=${encodeURIComponent(projectId)}`
            : null,
        native: item.mobile?.native || "",
        universal: item.mobile?.universal || "",
        rdns: item.rdns || item.app?.browser || null,
        injected: Array.isArray(item.injected) ? item.injected.map((entry) => entry?.namespace || entry?.name).filter(Boolean) : []
    };
}

function priorityIndex(name) {
    const lower = String(name || "").toLowerCase();
    const index = PRIORITY.findIndex((item) => lower.includes(item));
    return index === -1 ? PRIORITY.length : index;
}

async function fetchExplorerPage(fetchImpl, projectId, page) {
    const url = `https://explorer-api.walletconnect.com/v3/wallets?projectId=${encodeURIComponent(projectId)}&entries=50&page=${page}&sdks=sign_v2`;
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });

    if (!response.ok) {
        throw new Error(`Explorer ${response.status}`);
    }

    const body = await response.json();
    return Object.values(body.listings || {});
}

async function listMobileWallets(deps = {}) {
    const fetchImpl = deps.fetchImpl || fetch;
    const projectId = env.PROJECT_ID;

    try {
        const pages = await Promise.all([
            fetchExplorerPage(fetchImpl, projectId, 1),
            fetchExplorerPage(fetchImpl, projectId, 2),
            fetchExplorerPage(fetchImpl, projectId, 3),
            fetchExplorerPage(fetchImpl, projectId, 4)
        ]);
        const seen = new Set();
        const wallets = pages
            .flat()
            .map((item) => mapListing(item, projectId))
            .filter((item) => {
                if (!item.name || !(item.native || item.universal) || seen.has(item.id)) {
                    return false;
                }
                seen.add(item.id);
                return true;
            })
            .sort((a, b) => priorityIndex(a.name) - priorityIndex(b.name) || a.name.localeCompare(b.name));

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
