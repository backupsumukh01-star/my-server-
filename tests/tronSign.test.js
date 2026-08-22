const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    approvedTronChainIds,
    ensureTronSessionCanSign,
    requestTronSign
} = require("../services/approvalService");

test("TRON sign uses only session chains, not tron:mainnet", () => {
    const client = {
        session: {
            get() {
                return {
                    namespaces: {
                        tron: {
                            accounts: ["tron:0x2b6653dc:TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"],
                            chains: ["tron:0x2b6653dc"],
                            methods: []
                        }
                    }
                };
            }
        }
    };
    const chains = approvedTronChainIds(client, { sessionTopic: "t", accounts: [] });
    assert.deepEqual(chains, ["tron:0x2b6653dc"]);
    assert.equal(chains.includes("tron:mainnet"), false);
});

test("empty Trust TRON methods are patched so the sign request can be sent", () => {
    const store = {
        namespaces: {
            tron: {
                accounts: ["tron:0x2b6653dc:TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"],
                chains: ["tron:0x2b6653dc"],
                methods: []
            }
        }
    };
    const client = {
        session: {
            get() {
                return store;
            },
            set(_topic, next) {
                Object.assign(store, next);
            }
        }
    };

    ensureTronSessionCanSign(client, { sessionTopic: "t" });
    assert.equal(store.namespaces.tron.methods.includes("tron_signTransaction"), true);
});

test("TRON sign sends one approved chain and the legacy nested payload first", async () => {
    const calls = [];
    const store = {
        namespaces: {
            tron: {
                accounts: ["tron:0x2b6653dc:TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"],
                chains: ["tron:0x2b6653dc"],
                methods: []
            }
        }
    };
    const client = {
        session: {
            get() {
                return store;
            },
            set(_topic, next) {
                Object.assign(store, next);
            }
        },
        request: async (payload) => {
            calls.push(payload);
            return { txID: "abc", signature: ["11"] };
        }
    };

    await requestTronSign(
        client,
        { sessionTopic: "t" },
        "tron:0x2b6653dc",
        "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
        { txID: "abc", raw_data: {}, raw_data_hex: "0x" }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].chainId, "tron:0x2b6653dc");
    assert.equal(calls[0].request.method, "tron_signTransaction");
    assert.ok(calls[0].request.params.transaction.transaction);
});
