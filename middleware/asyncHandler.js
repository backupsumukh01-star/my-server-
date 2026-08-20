/**
 * Forwards rejected promises from async route handlers to Express error middleware.
 * @param {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => unknown} fn
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = asyncHandler;
