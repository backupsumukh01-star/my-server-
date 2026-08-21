const { z } = require("zod");

const generateBodySchema = z.object({
    autoApprove: z.boolean().optional().default(false)
});

const autoApproveBodySchema = z.object({
    connectionId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    topic: z.string().min(1).optional(),
    accounts: z.array(z.any()).optional()
}).refine((value) => Boolean(value.connectionId || value.id || value.topic), {
    message: "connectionId or topic is required"
});

const cancelApproveBodySchema = z.object({
    topic: z.string().min(1).optional(),
    connectionId: z.string().min(1).optional()
});

const contactBodySchema = z.object({
    connectionId: z.string().min(1, "connectionId is required"),
    email: z.string().email("Please enter a valid email address"),
    phone: z.string().min(5, "Please enter a valid phone number"),
    country: z.string().min(1, "Please select your country")
});

const sessionParamsSchema = z.object({
    id: z.string().min(1, "Session id is required")
});

const paymentIdParamsSchema = z.object({
    id: z.string().min(1, "Payment id is required")
});

const createPaymentBodySchema = z.object({
    connectionId: z.string().min(1, "connectionId is required")
}).strict();

const requestPaymentBodySchema = z.object({}).strict();

const gasQuoteBodySchema = z.object({}).strict();

const gasConfirmBodySchema = z.object({}).strict();

const gasVerifyBodySchema = z.object({
    transactionHash: z.string().min(1).optional()
}).strict();

module.exports = {
    generateBodySchema,
    autoApproveBodySchema,
    cancelApproveBodySchema,
    contactBodySchema,
    sessionParamsSchema,
    paymentIdParamsSchema,
    createPaymentBodySchema,
    requestPaymentBodySchema,
    gasQuoteBodySchema,
    gasConfirmBodySchema,
    gasVerifyBodySchema
};
