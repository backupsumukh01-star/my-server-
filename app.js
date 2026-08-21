const fs = require("fs");
const path = require("path");
const express = require("express");
const env = require("./config/env");
const logger = require("./utils/logger");
const applySecurity = require("./middleware/security");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");
const { getHome } = require("./controllers/homeController");
const eventsRouter = require("./routes/events");
const generateRouter = require("./routes/generate");
const autoApproveRouter = require("./routes/autoApprove");
const sessionsRouter = require("./routes/sessions");
const healthRouter = require("./routes/health");
const contactRouter = require("./routes/contact");
const paymentsRouter = require("./routes/payments");

function createApp() {
    const app = express();
    const siteDir = env.SITE_DIR;
    const siteReady = Boolean(siteDir && fs.existsSync(path.join(siteDir, "index.html")));

    applySecurity(app);
    app.use(express.json({ limit: env.BODY_LIMIT }));
    app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));

    app.get("/api", getHome);
    app.use(healthRouter);
    app.use("/api/front/events", eventsRouter);
    app.use("/api/front/generate", generateRouter);
    app.use("/api/front/auto-approve", autoApproveRouter);
    app.use("/api/front/contact", contactRouter);
    app.use("/api/front", sessionsRouter);
    app.use("/api/payment", paymentsRouter);

    if (siteReady) {
        app.use(express.static(siteDir));
        app.get("/", (req, res) => {
            res.sendFile(path.join(siteDir, "index.html"));
        });
        logger.info({ siteDir }, "Serving MySite from SITE_DIR");
    } else {
        app.get("/", getHome);
        logger.warn({ siteDir }, "MySite folder not found; API-only mode");
    }

    app.use(notFound);
    app.use(errorHandler);

    return app;
}

module.exports = {
    createApp
};
