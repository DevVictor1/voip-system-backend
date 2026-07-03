const express = require('express');
const { receiveTwilioPortInWebhook } = require('../controllers/portingWebhookController');

const router = express.Router();

// Public Twilio webhook. Do not add JWT auth here; requests are verified by X-Twilio-Signature.
router.post('/port-in', receiveTwilioPortInWebhook);

module.exports = router;
