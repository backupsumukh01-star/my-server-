const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { validateBody } = require("../middleware/validate");
const { contactBodySchema } = require("../config/schemas");
const { submitContact } = require("../controllers/contactController");

const router = express.Router();

router.post("/", validateBody(contactBodySchema), asyncHandler(submitContact));

module.exports = router;
