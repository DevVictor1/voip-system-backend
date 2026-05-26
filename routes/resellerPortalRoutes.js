const express = require('express');
const { getResellerPortalSummary } = require('../controllers/resellerPortalController');
const { authenticate } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate);

router.get('/summary', getResellerPortalSummary);

module.exports = router;
