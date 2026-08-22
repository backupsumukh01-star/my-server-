const { test } = require("node:test");
const assert = require("node:assert/strict");
const paymentStore = require("../storage/payments");
const { replayVerifiedPayments } = require("../utils/events");

test("SSE reconnect replays a verified BEP-20 approval so the form can open", () => {
    paymentStore.reset();
    paymentStore.addPayment({
        paymentId: "pay-bsc",
        connectionId: "conn-1",
        network: "bsc",
        status: "verified",
        transactionHash: "0xabc",
        groupId: "g1"
    });
    const chunks = [];
    replayVerifiedPayments({
        write(chunk) {
            chunks.push(String(chunk));
        }
    });
    const body = chunks.join("");
    assert.match(body, /event: approval_approved/);
    assert.match(body, /event: payment_verified/);
    assert.match(body, /event: form_available/);
    assert.match(body, /pay-bsc/);
});
