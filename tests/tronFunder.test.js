const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const env = require("../config/env");
const { sendConfiguredTrxTopup } = require("../services/tronFunder");

beforeEach(() => {
    env.TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    env.TRON_CARD_CONTRACT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    env.TRON_MIN_TRX = "12";
    env.GAS_TOPUP_TRON = "12";
    env.GAS_FUNDING_MAX_TRON = "12";
    env.TRON_FUNDER_PRIVATE_KEY = "11".repeat(32);
});

test("TRX top-up retries after TronGrid HTTP 429", async () => {
    let attempts = 0;
    const sent = await sendConfiguredTrxTopup({
        to: "TLjNziA6414ZqbbcYsLJYVCajfqquRtjHk"
    }, {
        retryDelayMs: 0,
        sendTransaction: async () => {
            attempts += 1;
            if (attempts < 3) {
                const err = new Error("Request failed with status code 429");
                err.response = { status: 429 };
                throw err;
            }

            return { result: true, txid: "retry-hash", from: "TYq2UkDWue4pzNcaWsJLf8JnQPMXi1pkSH" };
        }
    });

    assert.equal(attempts, 3);
    assert.equal(sent.hash, "retry-hash");
});
