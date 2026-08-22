const logger = require("../utils/logger");
const store = require("../storage/sessions");
const { emitEvent } = require("../utils/events");
const env = require("../config/env");
const { formatUnits, publicSession, tronAddressToHex20, tronAddressToBase58, sameTronAddress } = require("../utils/helpers");
const { getNetwork, getNetworkByChainId } = require("../config/networks");
const { getContracts } = require("../config/contracts");
const { getUsdPrices, usdValue } = require("./prices");
const { rpcUrlsFor } = require("../config/rpcUrls");
const { fetchWithRetry } = require("../utils/httpRetry");

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

function sessionBalancesFresh(session, maxMs = CACHE_MS) {
    const at = Date.parse(session?.balancesUpdatedAt || "");
    return Number.isFinite(at)
        && (Date.now() - at) < maxMs
        && Array.isArray(session?.balances)
        && session.balances.length > 0;
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

async function evmRpcOnce(url, method, params, fetchImpl) {
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

async function evmRpc(network, method, params, fetchImpl) {
    let lastError = null;

    for (const url of rpcUrlsFor(network)) {
        try {
            return await evmRpcOnce(url, method, params, fetchImpl);
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error("RPC failed");
}

async function fetchEvmNative(network, address, fetchImpl) {
    const raw = await evmRpc(network, "eth_getBalance", [address, "latest"], fetchImpl);
    if (raw == null || raw === "" || raw === "0x" || raw === "0X") {
        throw new Error("Empty native RPC result");
    }
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
        network,
        "eth_call",
        [{ to: usdtContract, data: encodeBalanceOf(address) }, "latest"],
        fetchImpl
    );
    if (raw == null || raw === "" || raw === "0x" || raw === "0X") {
        throw new Error("Empty USDT RPC result");
    }
    const balance = formatUnits(raw, network.usdtDecimals);
    return asset("USDT", network.usdtDecimals, { balance, raw: String(raw) });
}

function tronRpcHeaders(url) {
    const headers = {
        Accept: "application/json",
        "Content-Type": "application/json"
    };
    const key = String(env.TRON_API_KEY || "").trim();

    if (key && String(url).includes("trongrid.io")) {
        headers["TRON-PRO-API-KEY"] = key;
    }

    return headers;
}

function tronHosts(network) {
    return rpcUrlsFor(network).map((url) => String(url).replace(/\/$/, ""));
}

async function tronFetchJson(fetchImpl, url, options = {}) {
    const response = await fetchWithRetry(url, {
        ...options,
        headers: {
            ...tronRpcHeaders(url),
            ...(options.headers || {})
        }
    }, { fetchImpl, label: "trongrid" });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        const err = new Error(`Tron HTTP ${response.status}`);
        err.status = response.status;
        throw err;
    }

    return payload;
}

function collectTrc20Entries(accountData) {
    const rows = accountData?.trc20;

    if (Array.isArray(rows)) {
        return rows.flatMap((row) => Object.entries(row || {}));
    }

    if (rows && typeof rows === "object") {
        return Object.entries(rows);
    }

    return null;
}

function tronUsdtRaw(accountData, usdtContract) {
    const entries = collectTrc20Entries(accountData);

    if (!entries) {
        return null;
    }

    const match = entries.find(([contract]) => sameTronAddress(contract, usdtContract));
    return match ? String(match[1]) : null;
}

function parseConstantResult(payload) {
    const hex = payload?.constant_result?.[0]
        || payload?.transaction?.constant_result?.[0]
        || payload?.result?.constant_result?.[0];

    if (hex == null || hex === "") {
        return null;
    }

    return String(hex).startsWith("0x") ? String(hex) : `0x${hex}`;
}

async function fetchTronAccount(network, address, fetchImpl) {
    const queryAddress = /^T/i.test(address) ? address : tronAddressToBase58(address);
    let lastError = null;

    for (const host of tronHosts(network)) {
        try {
            const payload = await tronFetchJson(
                fetchImpl,
                `${host}/v1/accounts/${encodeURIComponent(queryAddress)}`
            );
            if (payload?.data?.[0]) {
                return payload.data[0];
            }

            if (payload && payload.balance != null) {
                return payload;
            }

        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error("Tron account HTTP failed");
}

async function fetchTronNativeFromWallet(network, address, fetchImpl) {
    const visibleAddress = /^T/i.test(address) ? address : tronAddressToBase58(address);
    let lastError = null;

    for (const host of tronHosts(network)) {
        try {
            const payload = await tronFetchJson(fetchImpl, `${host}/wallet/getaccount`, {
                method: "POST",
                body: JSON.stringify({
                    address: visibleAddress,
                    visible: true
                })
            });
            const raw = payload?.balance;

            if (raw == null && !payload?.address) {
                continue;
            }

            return String(raw ?? 0);
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error("Tron native balance unavailable");
}

async function fetchTronNative(accountData, network, address, fetchImpl) {
    if (accountData && (accountData.balance != null || Array.isArray(accountData.trc20) || accountData.address)) {
        const raw = String(accountData.balance ?? 0);
        return asset("TRX", network.nativeDecimals, {
            balance: formatUnits(raw, network.nativeDecimals),
            raw
        });
    }

    const raw = await fetchTronNativeFromWallet(network, address, fetchImpl);
    return asset("TRX", network.nativeDecimals, {
        balance: formatUnits(raw, network.nativeDecimals),
        raw
    });
}

async function fetchTronUsdtByCall(network, address, usdtContract, fetchImpl) {
    const owner = /^T/i.test(address) ? address : tronAddressToBase58(address);
    const token = /^T/i.test(usdtContract) ? usdtContract : tronAddressToBase58(usdtContract);
    const parameter = tronAddressToHex20(address).padStart(64, "0");
    let lastError = null;

    for (const host of tronHosts(network)) {
        try {
            const payload = await tronFetchJson(fetchImpl, `${host}/wallet/triggerconstantcontract`, {
                method: "POST",
                body: JSON.stringify({
                    owner_address: owner,
                    contract_address: token,
                    function_selector: "balanceOf(address)",
                    parameter,
                    visible: true
                })
            });
            const raw = parseConstantResult(payload);

            if (raw == null) {
                lastError = new Error(payload?.result?.message || "Empty TRC-20 constant_result");
                continue;
            }

            return String(BigInt(raw));
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error("TRC-20 balanceOf failed");
}

async function fetchTronUsdt(accountData, network, usdtContract, address, fetchImpl) {
    if (!usdtContract) {
        return asset("USDT", network.usdtDecimals, {
            error: "Missing TRON_USDT_CONTRACT"
        });
    }

    let raw = tronUsdtRaw(accountData, usdtContract);

    if (raw == null) {
        raw = await fetchTronUsdtByCall(network, address, usdtContract, fetchImpl);
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
            let accountData = null;

            try {
                accountData = await fetchTronAccount(network, address, fetchImpl);
            } catch (err) {
                logger.warn({ err: { message: err.message }, chainId: network.chainId }, "Tron account REST failed; trying wallet RPC");
            }

            try {
                native = await fetchTronNative(accountData, network, address, fetchImpl);
            } catch (err) {
                logger.error({ err, chainId: network.chainId }, "TRX balance read failed");
                native = asset("TRX", network.nativeDecimals, { error: err.message });
            }

            try {
                usdt = await fetchTronUsdt(accountData, network, contracts.usdt, address, fetchImpl);
            } catch (err) {
                logger.error({ err, chainId: network.chainId }, "TRC-20 USDT balance read failed");
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

async function attachGasQuotes(balances, deps = {}) {
    const { estimateApprovalGas } = require("./gasEstimate");
    const { getNetwork, getNetworkByChainId } = require("../config/networks");
    const { ethMinRaw, liveEthMeetsMin } = require("../config/evmGas");

    return Promise.all((balances || []).map(async (row) => {
        const key = row.network || getNetworkByChainId(row.chainId)?.key;

        if (!key) {
            return row;
        }

        try {
            const network = getNetwork(key, { requireContracts: false });
            const quote = await estimateApprovalGas({
                network: key,
                from: row.address,
                nativeBalanceRaw: row.native?.raw
            }, deps);

            return {
                ...row,
                gas: {
                    estimatedGas: quote.estimatedGas,
                    estimatedFee: key === "eth"
                        ? formatUnits(ethMinRaw().toString(), network.nativeDecimals)
                        : (quote.estimatedNativeCost
                            ? formatUnits(quote.estimatedNativeCost, network.nativeDecimals)
                            : null),
                    sufficient: key === "eth"
                        ? liveEthMeetsMin(quote.nativeBalance)
                        : quote.sufficient,
                    error: quote.error || null
                }
            };
        } catch (_err) {
            return {
                ...row,
                gas: {
                    estimatedGas: null,
                    estimatedFee: null,
                    sufficient: null
                }
            };
        }
    }));
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

        emitEvent("balances_started", { connectionId, timestamp: new Date().toISOString() });

        const prices = deps.prices || await getUsdPrices({ fetchImpl: deps.fetchImpl }).catch(() => emptyNullPrices());
        const { expandCardAccounts } = require("../utils/helpers");
        const accounts = expandCardAccounts(session.accounts || []);

        if (accounts.length !== (session.accounts || []).length) {
            store.updateSession(connectionId, { accounts });
        }

        const balances = await Promise.all(
            accounts.map((account) => fetchAccountBalance(account, { ...deps, prices }))
        );
        const quoted = await attachGasQuotes(balances, deps);

        const stored = store.updateSession(connectionId, {
            balances: quoted,
            totalUsd: totalUsd(quoted),
            balancesUpdatedAt: new Date().toISOString()
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
    encodeBalanceOf,
    sessionBalancesFresh,
    CACHE_MS
};
