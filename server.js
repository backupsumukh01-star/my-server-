require("dotenv").config();

const env = require("./config/env");
const logger = require("./utils/logger");
const persist = require("./storage/persist");
const store = require("./storage/sessions");
const paymentStore = require("./storage/payments");
const { initWalletConnect, walletConnect } = require("./services/walletconnect");
const { createApp } = require("./app");

const app = createApp();
const PORT = env.PORT;

let httpServer = null;
let shuttingDown = false;

process.on("unhandledRejection", (err) => {
    logger.error({ err }, "Unhandled rejection");
});

process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
});

/**
 * Close HTTP, SSE, and WalletConnect, then exit.
 * @param {string} signal
 */
async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    logger.info({ signal }, "Graceful shutdown started");

    store.closeAllClients();

    try {
        await walletConnect.close();
    } catch (err) {
        logger.warn({ err }, "WalletConnect close failed");
    }

    if (!httpServer) {
        process.exit(0);
        return;
    }

    httpServer.close((err) => {
        if (err) {
            logger.error({ err }, "HTTP server close failed");
            process.exit(1);
            return;
        }

        logger.info("HTTP server closed");
        process.exit(0);
    });

    setTimeout(() => {
        logger.error("Shutdown timed out");
        process.exit(1);
    }, 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function startServer() {
    persist.bindStores(store, paymentStore);
    try {
        const backend = await persist.initPersist();
        const loaded = await persist.loadMaps();
        store.hydrateSessions(loaded.sessions);
        paymentStore.hydratePayments(loaded.payments);
        logger.info({
            backend: backend.backend,
            sessions: loaded.sessions.length,
            payments: loaded.payments.length
        }, "Restored card sessions and payments");
    } catch (err) {
        logger.warn({ err }, "Persist init failed; continuing with memory");
    }

    try {
        await initWalletConnect();
    } catch (err) {
        logger.warn({ err }, "WalletConnect is unavailable. HTTP server will still start.");
    }

    httpServer = app.listen(PORT, () => {
        logger.info({
            port: PORT,
            env: env.NODE_ENV,
            app: env.APP_NAME,
            url: env.APP_URL,
            site: env.SITE_DIR
        }, "Wallet Server started");
    });
}

if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    startServer,
    shutdown
};
