const express = require("express");
const { subscribe } = require("../controllers/eventsController");

const router = express.Router();

router.get("/", subscribe);

module.exports = router;
