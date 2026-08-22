const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { checkApplied } = require("../controllers/appliedController");

const router = express.Router();
router.post("/", asyncHandler(checkApplied));

module.exports = router;
