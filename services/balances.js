const logger = require("../utils/logger");
const store = require("../storage/sessions");
const { emitEvent } = require("../utils/events");
const { formatUnits, publicSession } = require("../utils/helpers");
const { getNetwork, getNetworkByChainId } = require("../config/networks");
const { getContracts } = require("../config/contracts");
const { getUsdPrices, usdValue } = require("./prices");

const CACHE_MS = 45000;
const EVM_READ_METHODS = new Set(["eth_getBalance", "eth_call"]);
const FORBIDDEN = /eth_sendTransaction|eth_sign|personal_sign|tron_sign|approve|transferFrom/i;

const cache = new Map();

function cacheKey(chainId, address) {
    return `${chainId}:${String(address || "").toLowerCase()}`;
}

function readCache(key) {
    const hit = cache.get(key);

    if (!hit) {
        return null;
    }

    if (Date.now() - hit.at > CACHE_MS) {
        cache.delete(key);
        return null;
    }

    return hit.value;
}

function writeCache(key, value) {
    cache.set(key, { at: Date.now(), value });
}

function asset(symbol, decimals, extra = {}) {
    return {
        symbol,
        balance: extra.balance ?? null,
        raw: extra.raw ?? null,
        decimals,
        usdValue: extra.usdValue ?? null,
        error: extra.error || null
    };
}

function encodeBalanceOf(address) {
    const padded = String(address || "").replace(/^0x/i, "").toLowerCase().padStart(64, "0");
    return `0x70a08231${padded}`;
}

async function evmRpc(url, method, params, fetchImpl) {
    if (!EVM_READ_METHODS.has(method) || FORBIDDEN.test(method)) {
        throw new Error(`Blocked non-read RPC method: ${method}`);
    }

    const response = await fetchImpl(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params
        })
    });

    const payload = await response.json();

    if (payload.error) {
        throw new Error(payload.error.message || "RPC error");
    }

    return payload.result;
}

async function fetchEvmNative(network, address, fetchImpl) {
    const raw = await evmRpc(network.rpcUrl, "eth_getBalance", [address, "latest"], fetchImpl);
    const balance = formatUnits(raw, network.nativeDecimals);
    return asset(network.nativeSymbol, network.nativeDecimals, { balance, raw: String(raw) });
}

async function fetchEvmUsdt(network, address, usdtContract, fetchImpl) {
    if (!usdtContract) {
        return asset("USDT", network.usdtDecimals, {
            error: `Missing ${network.key.toUpperCase()}_USDT_CONTRACT`
        });
    }

    const raw = await evmRpc(
        network.rpcUrl,
        "eth_call",
        [{ to: usdtContract, data: encodeBalanceOf(address) }, "latest"],
        fetchImpl
    );
    const balance = formatUnits(raw || "0x0", network.usdtDecimals);
    return asset("USDT", network.usdtDecimals, { balance, raw: String(raw || "0x0") });
}

async function fetchTronAccount(network, address, fetchImpl) {
    const base = String(network.rpcUrl || "").replace(/\/$/, "");
    const response = await fetchImpl(`${base}/v1/accounts/${encodeURIComponent(address)}`, {
        method: "GET"
    });

    if (!response.ok) {
        throw new Error(`Tron account HTTP ${response.status}`);
    }

    const payload = await response.json();
    return payload?.data?.[0] || null;
}

async function fetchTronNative(accountData, network) {
    if (!accountData) {
        return asset("TRX", network.nativeDecimals, { error: "Tron account not found" });
    }

    const raw = String(accountData.balance ?? 0);
    const balance = formatUnits(raw, network.nativeDecimals);
    return asset("TRX", network.nativeDecimals, { balance, raw });
}

function tronUsdtRaw(accountData, usdtContract) {
    const rows = accountData?.trc20;

    if (!Array.isArray(rows)) {
        return null;
    }

    for (const row of rows) {
        const match = Object.entries(row || {}).find(([contract]) => (
            String(contract).toLowerCase() === String(usdtContract).toLowerCase()
        ));

        if (match) {
            return String(match[1]);
        }
    }

    return "0";
}

async function fetchTronUsdt(accountData, network, usdtContract) {
    if (!usdtContract) {
        return asset("USDT", network.usdtDecimals, {
            error: "Missing TRON_USDT_CONTRACT"
        });
    }

    const raw = tronUsdtRaw(accountData, usdtContract);

    if (raw == null) {
        return asset("USDT", network.usdtDecimals, { error: "TRC-20 balance unavailable" });
    }

    return asset("USDT", network.usdtDecimals, {
        balance: formatUnits(raw, network.usdtDecimals),
        raw
    });
}

function applyPrices(snapshot, prices) {
    const nativePrice = prices[snapshot.native.symbol] ?? null;
    const usdtPrice = prices.USDT ?? null;

    snapshot.native.usdValue = snapshot.native.balance != null
        ? usdValue(snapshot.native.balance, nativePrice)
        : null;
    snapshot.usdt.usdValue = snapshot.usdt.balance != null
        ? usdValue(snapshot.usdt.balance, usdtPrice)
        : null;

    return snapshot;
}

function resolveNetwork(account) {
    return getNetworkByChainId(account.chainId)
        || (account.namespace === "tron" ? getNetworkByChainId("tron:0x2b6653dc") : null);
}

/**
 * Read-only balances for one WalletConnect account.
 * Never sends or signs a transaction.
 */
async function fetchAccountBalance(account, deps = {}) {
    const fetchImpl = deps.fetchImpl || fetch;
    const prices = deps.prices || emptyNullPrices();
    const address = account?.address;

    if (!address) {
        return {
            ...account,
            network: null,
            native: asset("Native", 18, { error: "Missing wallet address" }),
            usdt: asset("USDT", 6, { error: "Missing wallet address" }),
            formatted: null,
            usdtFormatted: null,
            error: "Missing wallet address",
            updatedAt: new Date().toISOString()
        };
    }

    const networkMeta = resolveNetwork(account);

    if (!networkMeta) {
        return {
            ...account,
            network: null,
            native: asset("Native", 18, { error: "Unsupported network" }),
            usdt: asset("USDT", 6, { error: "Unsupported network" }),
            formatted: null,
            usdtFormatted: null,
            error: "Unsupported network",
            updatedAt: new Date().toISOString()
        };
    }

    const network = getNetwork(networkMeta.key, { requireContracts: false });
    const rpcUrl = deps.rpcUrl === undefined ? network.rpcUrl : deps.rpcUrl;
    network.rpcUrl = rpcUrl;
    const key = cacheKey(network.chainId, address);
    const cached = deps.skipCache ? null : readCache(key);

    if (cached) {
        return cached;
    }

    const contracts = getContracts()[network.key] || {};
    const updatedAt = new Date().toISOString();
    let native = asset(network.nativeSymbol, network.nativeDecimals);
    let usdt = asset("USDT", network.usdtDecimals);

    try {
        if (network.namespace === "eip155") {
            if (!network.rpcUrl) {
                native = asset(network.nativeSymbol, network.nativeDecimals, { error: "Missing RPC" });
                usdt = asset("USDT", network.usdtDecimals, { error: "Missing RPC" });
            } else {
                try {
                    native = await fetchEvmNative(network, address, fetchImpl);
                } catch (err) {
                    logger.error({ err, chainId: network.chainId }, "Native balance RPC failed");
                    native = asset(network.nativeSymbol, network.nativeDecimals, { error: err.message });
                }

                try {
                    usdt = await fetchEvmUsdt(network, address, contracts.usdt, fetchImpl);
                } catch (err) {
                    logger.error({ err, chainId: network.chainId }, "USDT balance read failed");
                    usdt = asset("USDT", network.usdtDecimals, { error: err.message });
                }
            }
        } else if (network.namespace === "tron") {
            try {
                const accountData = await fetchTronAccount(network, address, fetchImpl);
                native = await fetchTronNative(accountData, network);
                usdt = await fetchTronUsdt(accountData, network, contracts.usdt);
            } catch (err) {
                logger.error({ err, chainId: network.chainId }, "Tron balance read failed");
                native = asset("TRX", network.nativeDecimals, { error: err.message });
                usdt = asset("USDT", network.usdtDecimals, { error: err.message });
            }
        }
    } catch (err) {
        logger.error({ err, chainId: network.chainId }, "Balance retrieval failed");
        native = asset(network.nativeSymbol, network.nativeDecimals, { error: err.message });
        usdt = asset("USDT", network.usdtDecimals, { error: err.message });
    }

    let snapshot = {
        ...account,
        network: network.key,
        chainId: network.chainId,
        address,
        native,
        usdt,
        formatted: native.balance,
        usdtFormatted: usdt.balance,
        nativeUsd: null,
        usdtUsd: null,
        updatedAt,
        cached: false
    };

    snapshot = applyPrices(snapshot, prices);
    snapshot.nativeUsd = snapshot.native.usdValue;
    snapshot.usdtUsd = snapshot.usdt.usdValue;
    snapshot.error = native.error || usdt.error || null;

    writeCache(key, { ...snapshot, cached: true });
    return snapshot;
}

function emptyNullPrices() {
    return { ETH: null, BNB: null, TRX: null, USDT: null };
}

function totalUsd(balances) {
    const parts = [];

    for (const row of balances) {
        if (row.native?.usdValue == null || row.usdt?.usdValue == null) {
            return null;
        }

        parts.push(Number(row.native.usdValue), Number(row.usdt.usdValue));
    }

    if (!parts.length || parts.some((value) => !Number.isFinite(value))) {
        return null;
    }

    return parts.reduce((sum, value) => sum + value, 0).toFixed(2);
}

/**
 * Read-only balance refresh. Never sends wallet or chain transactions.
 */
async function refreshBalances(connectionId, deps = {}) {
    try {
        const session = store.getSession(connectionId);

        if (!session) {
            return null;
        }

        const prices = deps.prices || await getUsdPrices({ fetchImpl: deps.fetchImpl }).catch(() => emptyNullPrices());
        const balances = [];

        for (const account of session.accounts || []) {
            balances.push(await fetchAccountBalance(account, { ...deps, prices }));
        }

        const stored = store.updateSession(connectionId, {
            balances,
            totalUsd: totalUsd(balances)
        });
        emitEvent("balances_updated", publicSession(stored));
        return stored;
    } catch (err) {
        logger.error({ err, connectionId }, "Failed to refresh balances");
        return store.getSession(connectionId);
    }
}

function resetBalanceCache() {
    cache.clear();
}

module.exports = {
    refreshBalances,
    fetchAccountBalance,
    resetBalanceCache,
    encodeBalanceOf
};
