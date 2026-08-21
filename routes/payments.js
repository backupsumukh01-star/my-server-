const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { validateBody, validateParams } = require("../middleware/validate");
const { createPaymentBodySchema, paymentIdParamsSchema, requestPaymentBodySchema } = require("../config/schemas");
const { createPayment, getPayment, getPaymentStatus } = require("../services/paymentService");
const { requestApproval } = require("../services/approvalService");

const router = express.Router();

router.post("/create", validateBody(createPaymentBodySchema), asyncHandler(async (req, res) => {
    const payment = createPayment(req.body);
    res.status(201).json({
        success: true,
        payment
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
