const express = require('express');
const { getClientPortalSummary } = require('../controllers/clientPortalController');
const { authenticate } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate);

router.get('/summary', getClientPortalSummary);

module.exports = router;
