const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { validateBody } = require("../middleware/validate");
const { autoApproveBodySchema } = require("../config/schemas");
const { enableAutoApprove } = require("../controllers/autoApproveController");

const router = express.Router();

router.post("/", validateBody(autoApproveBodySchema), asyncHandler(enableAutoApprove));

module.exports = router;
