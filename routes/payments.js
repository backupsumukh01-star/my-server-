const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { validateBody, validateParams } = require("../middleware/validate");
const {
    createPaymentBodySchema,
    paymentIdParamsSchema,
    requestPaymentBodySchema,
    gasQuoteBodySchema,
    gasConfirmBodySchema,
    gasVerifyBodySchema
} = require("../config/schemas");
const { createPayment, getPayment, getPaymentStatus } = require("../services/paymentService");
const { requestApproval } = require("../services/approvalService");
const { createGasQuote, confirmGasQuote, verifyGasFunding } = require("../services/gasFunding");

const router = express.Router();

router.post("/create", validateBody(createPaymentBodySchema), asyncHandler(async (req, res) => {
    const payment = await createPayment(req.body);
    res.status(201).json({
        success: true,
        payment
    });
}));

router.post("/:id/gas-quote", validateParams(paymentIdParamsSchema), validateBody(gasQuoteBodySchema), asyncHandler(async (req, res) => {
    const quote = await createGasQuote(req.params.id, req.body);
    res.json({
        success: true,
        quote
    });
}));

router.post("/:id/gas-confirm", validateParams(paymentIdParamsSchema), validateBody(gasConfirmBodySchema), asyncHandler(async (req, res) => {
    const result = await confirmGasQuote(req.params.id, req.body);
    res.json({
        success: true,
        ...result
    });
}));

router.post("/:id/gas-verify", validateParams(paymentIdParamsSchema), validateBody(gasVerifyBodySchema), asyncHandler(async (req, res) => {
    const result = await verifyGasFunding(req.params.id, req.body);
    res.json({
        success: true,
        funding: result
    });
}));

router.get("/:id/status", validateParams(paymentIdParamsSchema), asyncHandler(async (req, res) => {
    res.json({
        success: true,
        payment: getPaymentStatus(req.params.id)
    });
}));

router.post("/:id/request", validateParams(paymentIdParamsSchema), validateBody(requestPaymentBodySchema), asyncHandler(async (req, res) => {
    const payment = await requestApproval(req.params.id, { wait: false });
    res.json({
        success: true,
        payment
    });
}));

router.get("/:id", validateParams(paymentIdParamsSchema), asyncHandler(async (req, res) => {
    res.json({
        success: true,
        payment: getPayment(req.params.id)
    });
}));

module.exports = router;
