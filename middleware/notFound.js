const { NotFoundError } = require("../utils/errors");

/**
 * Express 404 handler.
 */
function notFound(req, res, next) {
    next(new NotFoundError(`Cannot ${req.method} ${req.originalUrl}`));
}

module.exports = notFound;
