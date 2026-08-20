const { ZodError } = require("zod");
const logger = require("../utils/logger");
const { AppError, ValidationError } = require("../utils/errors");

/**
 * Central JSON error handler.
 */
function errorHandler(err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }

    let error = err;

    if (err instanceof ZodError) {
        error = ValidationError.fromZod(err);
    }

    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof AppError
        ? error.message
        : "Internal server error";

    if (status >= 500) {
        logger.error({ err: error, path: req.originalUrl }, error.message || "Unhandled error");
    } else {
        logger.warn({ path: req.originalUrl, code, details: error.details }, error.message);
    }

    const payload = {
        error: true,
        code,
        message
    };

    if (error.details) {
        payload.details = error.details;
    }

    res.status(status).json(payload);
}

module.exports = errorHandler;
