const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { validateBody } = require("../middleware/validate");
const { generateBodySchema } = require("../config/schemas");
const { generate } = require("../controllers/generateController");

const router = express.Router();

router.post("/", validateBody(generateBodySchema), asyncHandler(generate));

module.exports = router;
