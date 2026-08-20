const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { validateParams } = require("../middleware/validate");
const { sessionParamsSchema } = require("../config/schemas");
const { listSessions, getSession } = require("../controllers/sessionsController");

const router = express.Router();

router.get("/sessions", asyncHandler(listSessions));
router.get("/session/:id", validateParams(sessionParamsSchema), asyncHandler(getSession));

module.exports = router;
