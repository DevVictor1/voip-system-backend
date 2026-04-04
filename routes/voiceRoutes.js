const express = require('express');
const router = express.Router();
const { generateToken } = require('../controllers/voiceController');

router.get('/token', generateToken);

module.exports = router;