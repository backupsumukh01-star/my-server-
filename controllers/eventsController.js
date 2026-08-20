const { attachClient, detachClient } = require("../utils/events");
const logger = require("../utils/logger");
const { AppError } = require("../utils/errors");

/**
 * GET /api/front/events
 */
function subscribe(req, res) {
    try {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        if (typeof res.flushHeaders === "function") {
            res.flushHeaders();
        }

        attachClient(res);
        res.write("event: connected\ndata: {\"status\":\"connected\"}\n\n");

        const heartbeat = setInterval(() => {
            try {
                res.write(": ping\n\n");
            } catch (err) {
                clearInterval(heartbeat);
            }
        }, 25000);

        let closed = false;

        const onClose = () => {
            if (closed) {
                return;
            }

            closed = true;
            clearInterval(heartbeat);
            detachClient(res);
        };

        req.on("close", onClose);
    } catch (err) {
        logger.error({ err }, "SSE connection failed");
        throw new AppError("Failed to open event stream", 500, "SSE_ERROR");
    }
}

module.exports = {
    subscribe
};
