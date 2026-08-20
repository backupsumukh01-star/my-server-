const express = require("express");
const env = require("./config/env");
const logger = require("./utils/logger");
const applySecurity = require("./middleware/security");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");
const { initWalletConnect, walletConnect } = require("./services/walletconnect");
const store = require("./storage/sessions");
const { getHome } = require("./controllers/homeController");
const eventsRouter = require("./routes/events");
const generateRouter = require("./routes/generate");
const autoApproveRouter = require("./routes/autoApprove");
const sessionsRouter = require("./routes/sessions");
const healthRouter = require("./routes/health");

const app = express();
const PORT = env.PORT;

applySecurity(app);
app.use(express.json({ limit: env.BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));

app.get("/", getHome);
app.use(healthRouter);
app.use("/api/front/events", eventsRouter);
app.use("/api/front/generate", generateRouter);
app.use("/api/front/auto-approve", autoApproveRouter);
app.use("/api/front", sessionsRouter);

app.use(notFound);
app.use(errorHandler);

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
            url: env.APP_URL
        }, "Wallet Server started");
    });
}

startServer();
