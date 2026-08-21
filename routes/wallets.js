const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { listMobileWallets } = require("../services/walletList");

const router = express.Router();

router.get("/", asyncHandler(async (_req, res) => {
    const wallets = await listMobileWallets();
    res.json({ wallets });
}));

module.exports = router;
