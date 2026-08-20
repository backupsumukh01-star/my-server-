/**
 * HTTP-aware application error.
 */
class AppError extends Error {
    /**
     * @param {string} message
     * @param {number} [status]
     * @param {string} [code]
     * @param {unknown} [details]
     */
    constructor(message, status = 500, code = "INTERNAL_ERROR", details) {
        super(message);
        this.name = "AppError";
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

class NotFoundError extends AppError {
    constructor(message = "Not found") {
        super(message, 404, "NOT_FOUND");
        this.name = "NotFoundError";
    }
}

class ValidationError extends AppError {
    /**
     * @param {string} message
     * @param {unknown} [details]
     */
    constructor(message = "Validation failed", details) {
        super(message, 400, "VALIDATION_ERROR", details);
        this.name = "ValidationError";
    }

    /**
     * @param {import("zod").ZodError} error
     */
    static fromZod(error) {
        const details = error.issues.map((issue) => ({
            path: issue.path.join(".") || "(root)",
            message: issue.message
        }));

        return new ValidationError("Validation failed", details);
    }
}

class WalletConnectError extends AppError {
    constructor(message = "WalletConnect is unavailable") {
        super(message, 503, "WALLETCONNECT_UNAVAILABLE");
        this.name = "WalletConnectError";
    }
}

module.exports = {
    AppError,
    NotFoundError,
    ValidationError,
    WalletConnectError
};
