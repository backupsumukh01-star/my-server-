const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const env = require("../config/env");
const { listMobileWallets } = require("../services/walletList");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
    const wallets = await listMobileWallets({ platform: req.query.platform });
    res.json({
        projectId: env.PROJECT_ID,
        wallets
    });
}));

module.exports = router;
