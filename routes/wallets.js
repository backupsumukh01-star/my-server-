const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const env = require("../config/env");

const router = express.Router();

router.get("/", asyncHandler(async (_req, res) => {
    res.json({
        projectId: env.PROJECT_ID
    });
}));

module.exports = router;
