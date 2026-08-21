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
const walletsRouter = require("./routes/wallets");

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
    app.use("/api/front/wallets", walletsRouter);
    app.use("/api/front", sessionsRouter);
    app.use("/api/payment", paymentsRouter);

    app.get(["/wc", "/wc/"], (req, res) => {
        const uri = String(req.query.uri || "").trim();

        if (!uri.startsWith("wc:")) {
            return res.redirect(302, "/");
        }

        const safeHref = uri.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
        res
            .status(200)
            .type("html")
            .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Open wallet</title>
  <meta http-equiv="refresh" content="0;url=${safeHref}">
</head>
<body>
  <p>Opening your wallet…</p>
  <p><a href="${safeHref}">Tap here if your wallet did not open</a></p>
  <script>location.replace(${JSON.stringify(uri)});</script>
</body>
</html>`);
    });

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
