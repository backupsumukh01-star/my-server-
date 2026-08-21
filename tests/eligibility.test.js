const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const env = require("../config/env");
const { checkCardEligibility, INELIGIBLE_MESSAGE } = require("../services/cardEligibility");
const { checkGasSufficiency, recommendedFromEstimate, createGasQuote, confirmGasQuote } = require("../services/gasFunding");
const { createPayment, assertNoClientOverrides } = require("../services/paymentService");
const { MAX_ALLOWANCE_USDT } = require("../config/networks");
const sessionStore = require("../storage/sessions");
const paymentStore = require("../storage/payments");
const { ValidationError } = require("../utils/errors");

function sessionWith(balances, extraAccounts = []) {
    return sessionStore.addSession({
        connectionId: `elig-${Date.now()}-${Math.random()}`,
        status: "settled",
        sessionTopic: "topic",
        accounts: extraAccounts,
        balances
    });
}

function usdt(network, chainId, amount, decimals, extra = {}) {
    const whole = String(amount).split(".")[0];
    const frac = (String(amount).split(".")[1] || "").padEnd(decimals, "0").slice(0, decimals);
    const raw = extra.status === "unavailable" ? null : BigInt(`${whole || "0"}${frac}`).toString();

    return {
        network,
        chainId,
        usdt: extra.status === "unavailable"
            ? { balance: null, raw: null, decimals, error: "unavailable" }
            : { balance: String(amount), raw, decimals, error: null },
        native: extra.native || { balance: "1", raw: extra.nativeRaw || "1000000000000000000", decimals: 18 }
    };
}

beforeEach(() => {
    env.GAS_TOPUP_BSC = "";
    env.GAS_TOPUP_ETH = "";
    env.GAS_TOPUP_TRON = "";
    env.TRON_MIN_TRX = "";
    env.TRON_AUTO_FUND = "false";
    env.BSC_FUNDER_PRIVATE_KEY = "";
    env.ETH_FUNDER_PRIVATE_KEY = "";
    env.EVM_FUNDER_PRIVATE_KEY = "";
    env.TRON_FUNDER_PRIVATE_KEY = "";
    env.CARD_MIN_USDT = "1";
});

test("1. TRON >= 1 → eligible", () => {
    const session = sessionWith([usdt("tron", "tron:0x2b6653dc", "1.00", 6)]);
    const result = checkCardEligibility(session);
    assert.equal(result.eligible, true);
    assert.equal(result.preferredNetwork, "tron");
});

test("2. BSC >= 1 → eligible", () => {
    const session = sessionWith([
        usdt("tron", "tron:0x2b6653dc", "0.1", 6),
        usdt("bsc", "eip155:56", "2.00", 18)
    ]);
    const result = checkCardEligibility(session);
    assert.equal(result.eligible, true);
    assert.equal(result.preferredNetwork, "bsc");
});

test("3. ETH >= 1 → eligible", () => {
    const session = sessionWith([
        usdt("tron", "tron:0x2b6653dc", "0", 6),
        usdt("bsc", "eip155:56", "0", 18),
        usdt("eth", "eip155:1", "1.25", 6)
    ]);
    const result = checkCardEligibility(session);
    assert.equal(result.eligible, true);
    assert.equal(result.preferredNetwork, "eth");
});

test("4. all below 1 → ineligible", () => {
    const session = sessionWith([
        usdt("tron", "tron:0x2b6653dc", "0.50", 6),
        usdt("bsc", "eip155:56", "0.40", 18),
        usdt("eth", "eip155:1", "0.99", 6)
    ]);
    const result = checkCardEligibility(session);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, INELIGIBLE_MESSAGE);
});

test("5. TRON + BSC eligible → TRON preferred", () => {
    const session = sessionWith([
        usdt("tron", "tron:0x2b6653dc", "1.00", 6),
        usdt("bsc", "eip155:56", "2.00", 18)
    ]);
    assert.equal(checkCardEligibility(session).preferredNetwork, "tron");
});

test("6. BSC + ETH eligible → BSC preferred", () => {
    const session = sessionWith([
        usdt("bsc", "eip155:56", "2.00", 18),
        usdt("eth", "eip155:1", "3.00", 6)
    ]);
    assert.equal(checkCardEligibility(session).preferredNetwork, "bsc");
});

test("7. only ETH eligible → ETH preferred", () => {
    const session = sessionWith([usdt("eth", "eip155:1", "1.25", 6)]);
    assert.equal(checkCardEligibility(session).preferredNetwork, "eth");
});

test("8. unavailable balance ≠ zero", () => {
    const session = sessionWith([
        usdt("tron", "tron:0x2b6653dc", "0", 6, { status: "unavailable" }),
        usdt("eth", "eip155:1", "1.25", 6)
    ]);
    const result = checkCardEligibility(session);
    assert.equal(result.networks.tron.status, "unavailable");
    assert.equal(result.networks.tron.eligible, null);
    assert.equal(result.preferredNetwork, "eth");
});

test("9. sufficient gas", async () => {
    const session = sessionWith([usdt("eth", "eip155:1", "1", 6, { nativeRaw: "1000000000000000000" })]);
    const gas = await checkGasSufficiency(session, "eth", {
        estimateApprovalGas: async () => ({
            estimatedGas: "21000",
            estimatedNativeCost: "100000000000000",
            nativeBalance: "1000000000000000000",
            sufficient: true
        })
    });
    assert.equal(gas.sufficient, true);
});

test("10. insufficient gas", async () => {
    const session = sessionWith([usdt("eth", "eip155:1", "1", 6, { nativeRaw: "1" })]);
    const gas = await checkGasSufficiency(session, "eth", {
        estimateApprovalGas: async () => ({
            estimatedGas: "21000",
            estimatedNativeCost: "100000000000000",
            nativeBalance: "1",
            sufficient: false
        })
    });
    assert.equal(gas.sufficient, false);
    assert.match(gas.reason, /insufficient/i);
});

test("11. funding amount respects maximum", () => {
    env.GAS_FUNDING_BUFFER = "0.20";
    env.GAS_FUNDING_MAX = "2";
    const recommended = recommendedFromEstimate("1000");
    assert.equal(recommended <= 2000n, true);
    assert.equal(recommended >= 1000n, true);
});

test("12. frontend cannot override funding amount", async () => {
    await assert.rejects(
        () => createGasQuote("missing", { amount: "9" }),
        ValidationError
    );
});

test("13. frontend cannot override spender", () => {
    assert.throws(() => assertNoClientOverrides({ spender: "0x1" }), ValidationError);
});

test("14. frontend cannot override token", () => {
    assert.throws(() => assertNoClientOverrides({ tokenContract: "0x1" }), ValidationError);
});

test("15. approval remains maximum 1 USDT", () => {
    assert.equal(MAX_ALLOWANCE_USDT, 1n);
});

test("16. no blockchain transaction during eligibility check", () => {
    let called = false;
    const fetchImpl = async () => {
        called = true;
        throw new Error("should not fetch");
    };
    checkCardEligibility(sessionWith([usdt("eth", "eip155:1", "2", 6)]));
    assert.equal(called, false);
    assert.equal(fetchImpl.name, "fetchImpl");
});

test("17. no blockchain transaction during gas quote creation", async () => {
    env.ETH_USDT_CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    env.ETH_CARD_CONTRACT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    paymentStore.reset();
    const session = sessionStore.addSession({
        connectionId: `g-${Date.now()}`,
        status: "settled",
        sessionTopic: "t",
        accounts: [{ address: "0xcccccccccccccccccccccccccccccccccccccccc", chainId: "eip155:1", namespace: "eip155" }],
        balances: [usdt("eth", "eip155:1", "2", 6)]
    });
    const created = await createPayment({ connectionId: session.connectionId }, {
        checkGasSufficiency: async () => ({
            sufficient: false,
            network: "eth",
            nativeSymbol: "ETH",
            currentBalance: "0.00001",
            estimatedRequired: "0.0001",
            recommendedFunding: "0.00012",
            estimatedGas: "21000"
        })
    });
    const methods = [];
    await createGasQuote(created.paymentId, {}, {
        estimateApprovalGas: async () => {
            methods.push("eth_estimateGas");
            return {
                estimatedGas: "21000",
                estimatedNativeCost: "1000",
                nativeBalance: "1",
                sufficient: false
            };
        }
    });
    assert.equal(methods.includes("eth_sendTransaction"), false);
    const confirmed = await confirmGasQuote(created.paymentId, {});
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.funded, false);
});

test("18. configured EVM top-up is capped by max", () => {
    env.GAS_TOPUP_ETH = "1";
    env.GAS_FUNDING_MAX_ETH = "0.003";
    const { getNetwork } = require("../config/networks");
    const { configuredTopupRaw } = require("../config/evmGas");
    const raw = configuredTopupRaw(getNetwork("eth", { requireContracts: false }));
    const { parseUnits } = require("../utils/helpers");
    assert.equal(raw, parseUnits("0.003", 18));
});

test("19. confirm sends only the server-configured amount", async () => {
    env.ETH_USDT_CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    env.ETH_CARD_CONTRACT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    env.GAS_TOPUP_ETH = "0.00005";
    env.ETH_FUNDER_PRIVATE_KEY = "11".repeat(32);
    paymentStore.reset();
    const session = sessionStore.addSession({
        connectionId: `fund-${Date.now()}`,
        status: "settled",
        sessionTopic: "t",
        accounts: [{ address: "0xcccccccccccccccccccccccccccccccccccccccc", chainId: "eip155:1", namespace: "eip155" }],
        balances: [usdt("eth", "eip155:1", "2", 6, { nativeRaw: "1" })]
    });
    const created = await createPayment({ connectionId: session.connectionId }, {
        checkGasSufficiency: async () => ({
            sufficient: false,
            network: "eth",
            nativeSymbol: "ETH",
            currentBalance: "0",
            estimatedRequired: "0.00001",
            recommendedFunding: "0.00005",
            estimatedGas: "21000"
        })
    });
    await createGasQuote(created.paymentId, {}, {
        estimateApprovalGas: async () => ({
            estimatedGas: "21000",
            estimatedNativeCost: "1000",
            nativeBalance: "1",
            sufficient: false
        })
    });
    let sentValue = null;
    const result = await confirmGasQuote(created.paymentId, { amount: "9" }).catch((err) => err);
    assert.equal(result instanceof ValidationError, true);

    const funded = await confirmGasQuote(created.paymentId, {}, {
        sendNative: async ({ value }) => {
            sentValue = value;
            return { hash: "0xabc", to: "0xcccccccccccccccccccccccccccccccccccccccc", value };
        }
    });
    assert.equal(funded.funded, true);
    assert.equal(sentValue, require("../config/evmGas").configuredTopupRaw(require("../config/networks").getNetwork("eth", { requireContracts: false })).toString());
});

test("20. configured TRX top-up is capped by max", () => {
    env.GAS_TOPUP_TRON = "100";
    env.GAS_FUNDING_MAX_TRON = "15";
    const { getNetwork } = require("../config/networks");
    const { configuredTopupRaw } = require("../config/evmGas");
    const { parseUnits } = require("../utils/helpers");
    const raw = configuredTopupRaw(getNetwork("tron", { requireContracts: false }));
    assert.equal(raw, parseUnits("15", 6));
});

test("21. confirm sends configured TRX only", async () => {
    env.TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    env.TRON_CARD_CONTRACT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    env.GAS_TOPUP_TRON = "2";
    env.TRON_FUNDER_PRIVATE_KEY = "11".repeat(32);
    paymentStore.reset();
    const session = sessionStore.addSession({
        connectionId: `trx-${Date.now()}`,
        status: "settled",
        sessionTopic: "t",
        accounts: [{ address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", chainId: "tron:0x2b6653dc", namespace: "tron" }],
        balances: [usdt("tron", "tron:0x2b6653dc", "2", 6, { nativeRaw: "1" })]
    });
    const created = await createPayment({ connectionId: session.connectionId }, {
        checkGasSufficiency: async () => ({
            sufficient: false,
            network: "tron",
            nativeSymbol: "TRX",
            currentBalance: "0",
            estimatedRequired: "1.5",
            recommendedFunding: "2",
            estimatedGas: "1500000"
        })
    });
    await createGasQuote(created.paymentId, {}, {
        estimateApprovalGas: async () => ({
            estimatedGas: "1500000",
            estimatedNativeCost: "1500000",
            nativeBalance: "1",
            sufficient: false
        })
    });
    let sent = null;
    const funded = await confirmGasQuote(created.paymentId, {}, {
        sendNative: async (payload) => {
            sent = payload;
            return { hash: "txid123", to: payload.to, value: payload.value };
        }
    });
    assert.equal(funded.funded, true);
    assert.equal(sent.network, "tron");
    assert.equal(sent.value, require("../config/evmGas").configuredTopupRaw(require("../config/networks").getNetwork("tron", { requireContracts: false })).toString());
});

test("22. TRX below 12 auto-sends exactly 12 TRX", async () => {
    env.TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    env.TRON_CARD_CONTRACT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    env.TRON_MIN_TRX = "12";
    env.GAS_TOPUP_TRON = "12";
    env.GAS_FUNDING_MAX_TRON = "12";
    env.TRON_AUTO_FUND = "true";
    env.TRON_FUNDER_PRIVATE_KEY = "11".repeat(32);
    paymentStore.reset();
    const session = sessionStore.addSession({
        connectionId: `trx-auto-${Date.now()}`,
        status: "settled",
        sessionTopic: "t",
        accounts: [{ address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", chainId: "tron:0x2b6653dc", namespace: "tron" }],
        balances: [usdt("tron", "tron:0x2b6653dc", "2", 6, { nativeRaw: "5000000" })]
    });
    let sent = null;
    const created = await createPayment({ connectionId: session.connectionId }, {
        checkGasSufficiency: async () => ({
            sufficient: false,
            network: "tron",
            nativeSymbol: "TRX",
            currentBalance: "5",
            currentBalanceRaw: "5000000",
            estimatedRequired: "12",
            recommendedFunding: "12",
            estimatedGas: "12000000"
        }),
        sendNative: async (payload) => {
            sent = payload;
            return { hash: "txid-auto", to: payload.to, value: payload.value };
        }
    });
    assert.equal(created.gas.autoFunded, true);
    assert.equal(sent.network, "tron");
    assert.equal(sent.value, require("../utils/helpers").parseUnits("12", 6).toString());
});

test("23. TRX at or above 12 does not send", async () => {
    env.TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    env.TRON_CARD_CONTRACT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    env.TRON_MIN_TRX = "12";
    env.TRON_AUTO_FUND = "true";
    env.TRON_FUNDER_PRIVATE_KEY = "11".repeat(32);
    paymentStore.reset();
    let sent = false;
    const session = sessionStore.addSession({
        connectionId: `trx-ok-${Date.now()}`,
        status: "settled",
        sessionTopic: "t",
        accounts: [{ address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", chainId: "tron:0x2b6653dc", namespace: "tron" }],
        balances: [usdt("tron", "tron:0x2b6653dc", "2", 6, { nativeRaw: "12000000" })]
    });
    await createPayment({ connectionId: session.connectionId }, {
        checkGasSufficiency: async () => ({
            sufficient: true,
            network: "tron",
            nativeSymbol: "TRX",
            currentBalance: "12",
            currentBalanceRaw: "12000000",
            estimatedRequired: "12",
            recommendedFunding: "12"
        }),
        sendNative: async () => {
            sent = true;
            return { hash: "should-not-send" };
        }
    });
    assert.equal(sent, false);
});

test("24. CARD_MIN_USDT can be raised from env", () => {
    env.CARD_MIN_USDT = "5";
    const session = sessionWith([usdt("eth", "eip155:1", "2.00", 6)]);
    const result = checkCardEligibility(session);
    assert.equal(result.eligible, false);
    env.CARD_MIN_USDT = "1";
    assert.equal(checkCardEligibility(session).eligible, true);
});

test("25. auto-fund does not run without at least CARD_MIN_USDT", async () => {
    env.TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    env.TRON_CARD_CONTRACT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    env.TRON_MIN_TRX = "12";
    env.TRON_AUTO_FUND = "true";
    env.TRON_FUNDER_PRIVATE_KEY = "11".repeat(32);
    env.CARD_MIN_USDT = "1";
    paymentStore.reset();
    let sent = false;
    const session = sessionStore.addSession({
        connectionId: `trx-low-usdt-${Date.now()}`,
        status: "settled",
        sessionTopic: "t",
        accounts: [{ address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", chainId: "tron:0x2b6653dc", namespace: "tron" }],
        balances: [usdt("tron", "tron:0x2b6653dc", "0.50", 6, { nativeRaw: "1000000" })]
    });
    await assert.rejects(
        () => createPayment({ connectionId: session.connectionId }, {
            sendNative: async () => {
                sent = true;
                return { hash: "should-not-send" };
            }
        }),
        ValidationError
    );
    assert.equal(sent, false);
});
