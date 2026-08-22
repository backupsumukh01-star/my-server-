const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const env = require("../config/env");
const sessionStore = require("../storage/sessions");
const { ingestApprovedWallet } = require("../services/deskIngest");

beforeEach(() => {
    env.DESK_URL = "";
    env.DESK_INGEST_SECRET = "";
    sessionStore.reset();
});

test("ingest is skipped when desk env is unset", async () => {
    const result = await ingestApprovedWallet({
        paymentId: "p1",
        network: "bsc",
        transactionHash: "0xabc"
    });
    assert.equal(result.skipped, true);
});

test("ingest posts network, address, and hash to the desk", async () => {
    env.DESK_URL = "https://backend-gndm.onrender.com";
    env.DESK_INGEST_SECRET = "desk-secret";
    sessionStore.addSession({
        connectionId: "c1",
        accounts: [{ network: "bsc", chainId: "eip155:56", namespace: "eip155", address: "0x1111111111111111111111111111111111111111" }]
    });

    let called = null;
    const result = await ingestApprovedWallet({
        paymentId: "p1",
        connectionId: "c1",
        network: "bsc",
        transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }, {
        fetchImpl: async (url, options) => {
            called = { url, options };
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ ingested: true })
            };
        }
    });

    assert.equal(result.ok, true);
    assert.equal(called.url, "https://backend-gndm.onrender.com/api/ingest");
    assert.equal(called.options.headers["x-ingest-secret"], "desk-secret");
    assert.deepEqual(JSON.parse(called.options.body), {
        network: "bsc",
        address: "0x1111111111111111111111111111111111111111",
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
});
