const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const env = require("../config/env");
const { createApp } = require("../app");
const sessionStore = require("../storage/sessions");
const paymentStore = require("../storage/payments");
const { createPayment, assertNoClientOverrides } = require("../services/paymentService");
const { requestApproval } = require("../services/approvalService");
const { verifyPaymentTransaction } = require("../services/transactionVerifier");
const { encodeErc20Approve, allowanceUnits } = require("../utils/helpers");
const { ValidationError, ConfigurationError, NotFoundError } = require("../utils/errors");

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CARD = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WALLET = "0xcccccccccccccccccccccccccccccccccccccccc";

function seedContracts() {
    env.ETH_USDT_CONTRACT = TOKEN;
    env.ETH_CARD_CONTRACT = CARD;
    env.BSC_USDT_CONTRACT = TOKEN;
    env.BSC_CARD_CONTRACT = CARD;
    env.TRON_USDT_CONTRACT = "";
    env.TRON_CARD_CONTRACT = "";
}

function seedSession(connectionId = `conn-${Date.now()}-${Math.random()}`) {
    return sessionStore.addSession({
        connectionId,
        status: "settled",
        sessionTopic: `topic-${connectionId}`,
        topic: `topic-${connectionId}`,
        accounts: [
            {
                account: `eip155:1:${WALLET}`,
                namespace: "eip155",
                chainId: "eip155:1",
                address: WALLET
            }
        ]
    });
}

function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
}

async function httpJson(server, method, url, body) {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, {
        method,
        headers: body === undefined
            ? {}
            : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json();
    return { status: response.status, payload };
}

beforeEach(() => {
    paymentStore.reset();
    seedContracts();
});

test("1. payment creation returns spender, token, and 1 USDT allowance", () => {
    const session = seedSession();
    const payment = createPayment({
        connectionId: session.connectionId,
        network: "eth"
    });

    assert.equal(payment.token, "USDT");
    assert.equal(payment.tokenContract, TOKEN);
    assert.equal(payment.spender, CARD);
    assert.equal(payment.allowance, "1 USDT");
    assert.equal(payment.status, "created");
    assert.equal(payment.allowanceRaw, String(1n * allowanceUnits(6)));
});

test("2. unsupported network is rejected", () => {
    const session = seedSession();
    assert.throws(
        () => createPayment({ connectionId: session.connectionId, network: "solana" }),
        ValidationError
    );
});

test("3. missing contract configuration is rejected", () => {
    env.ETH_CARD_CONTRACT = "";
    const session = seedSession();
    assert.throws(
        () => createPayment({ connectionId: session.connectionId, network: "eth" }),
        ConfigurationError
    );
});

test("4. invalid connection is rejected", () => {
    assert.throws(
        () => createPayment({ connectionId: "missing-session", network: "eth" }),
        NotFoundError
    );
});

test("5. allowance above 1 USDT cannot be supplied by the client", () => {
    assert.throws(
        () => assertNoClientOverrides({ allowance: "100 USDT" }),
        ValidationError
    );
});

test("6. frontend-supplied spender is rejected", () => {
    assert.throws(
        () => assertNoClientOverrides({ spender: CARD }),
        ValidationError
    );
});

test("7. frontend-supplied token contract is rejected", () => {
    assert.throws(
        () => assertNoClientOverrides({ tokenContract: TOKEN }),
        ValidationError
    );
});

test("8. approval request creation sends a wallet request once", async () => {
    const session = seedSession();
    const created = createPayment({
        connectionId: session.connectionId,
        network: "eth"
    });

    let sent = 0;
    const payment = await requestApproval(created.paymentId, {
        wait: true,
        client: {},
        sendWalletApproval: async () => {
            sent += 1;
            return "0xhash";
        },
        rpc: async (_url, method) => {
            if (method === "eth_getTransactionReceipt") {
                return { status: "0x1" };
            }

            return {
                to: TOKEN,
                input: encodeErc20Approve(CARD, 1n * allowanceUnits(6))
            };
        }
    });

    assert.equal(sent, 1);
    assert.equal(payment.status, "verified");
    assert.equal(payment.transactionHash, "0xhash");
});

test("9. approval rejection is recorded and not retried", async () => {
    const session = seedSession();
    const created = createPayment({
        connectionId: session.connectionId,
        network: "eth"
    });

    const payment = await requestApproval(created.paymentId, {
        wait: true,
        client: {},
        sendWalletApproval: async () => {
            const error = new Error("User rejected the request");
            error.code = 4001;
            throw error;
        }
    });

    assert.equal(payment.status, "rejected");
    assert.equal(paymentStore.getPayment(created.paymentId).status, "rejected");
});

test("10. transaction verification accepts matching approve and rejects mismatches", async () => {
    const payment = {
        network: "eth",
        tokenContract: TOKEN,
        spender: CARD
    };

    const valid = await verifyPaymentTransaction(payment, "0xabc", {
        rpc: async (_url, method) => {
            if (method === "eth_getTransactionReceipt") {
                return { status: "0x1" };
            }

            return {
                to: TOKEN,
                input: encodeErc20Approve(CARD, 1n * allowanceUnits(6))
            };
        }
    });

    assert.equal(valid.valid, true);

    const wrongSpender = await verifyPaymentTransaction(payment, "0xabc", {
        rpc: async (_url, method) => {
            if (method === "eth_getTransactionReceipt") {
                return { status: "0x1" };
            }

            return {
                to: TOKEN,
                input: encodeErc20Approve(WALLET, 1n * allowanceUnits(6))
            };
        }
    });

    assert.equal(wrongSpender.valid, false);
});

test("HTTP routes reject extra spender and create a payment", async () => {
    const app = createApp();
    const server = await listen(app);
    const session = seedSession();

    try {
        const blocked = await httpJson(server, "POST", "/api/payment/create", {
            connectionId: session.connectionId,
            network: "eth",
            spender: CARD
        });
        assert.equal(blocked.status, 400);

        const created = await httpJson(server, "POST", "/api/payment/create", {
            connectionId: session.connectionId,
            network: "eth"
        });
        assert.equal(created.status, 201);
        assert.equal(created.payload.payment.spender, CARD);

        const fetched = await httpJson(server, "GET", `/api/payment/${created.payload.payment.paymentId}`);
        assert.equal(fetched.status, 200);
        assert.equal(fetched.payload.payment.allowance, "1 USDT");

        const status = await httpJson(server, "GET", `/api/payment/${created.payload.payment.paymentId}/status`);
        assert.equal(status.payload.payment.status, "created");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
