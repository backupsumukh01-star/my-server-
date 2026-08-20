const { ValidationError } = require("../utils/errors");

/**
 * Validate `req.body` with a Zod schema.
 * @param {import("zod").ZodTypeAny} schema
 */
function validateBody(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body ?? {});

        if (!result.success) {
            return next(ValidationError.fromZod(result.error));
        }

        req.body = result.data;
        return next();
    };
}

/**
 * Validate `req.params` with a Zod schema.
 * @param {import("zod").ZodTypeAny} schema
 */
function validateParams(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.params ?? {});

        if (!result.success) {
            return next(ValidationError.fromZod(result.error));
        }

        req.params = result.data;
        return next();
    };
}

module.exports = {
    validateBody,
    validateParams
};
