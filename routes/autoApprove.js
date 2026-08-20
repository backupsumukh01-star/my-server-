const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { validateBody } = require("../middleware/validate");
const { autoApproveBodySchema, cancelApproveBodySchema } = require("../config/schemas");
const { enableAutoApprove, cancelAutoApprove } = require("../controllers/autoApproveController");

const router = express.Router();

router.post("/", validateBody(autoApproveBodySchema), asyncHandler(enableAutoApprove));
router.post("/cancel", validateBody(cancelApproveBodySchema), asyncHandler(cancelAutoApprove));

module.exports = router;
