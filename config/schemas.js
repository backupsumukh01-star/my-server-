const { z } = require("zod");

const generateBodySchema = z.object({
    autoApprove: z.boolean().optional().default(false)
});

const autoApproveBodySchema = z.object({
    connectionId: z.string().min(1).optional(),
    id: z.string().min(1).optional()
}).refine((value) => Boolean(value.connectionId || value.id), {
    message: "connectionId is required"
});

const sessionParamsSchema = z.object({
    id: z.string().min(1, "Session id is required")
});

module.exports = {
    generateBodySchema,
    autoApproveBodySchema,
    sessionParamsSchema
};
