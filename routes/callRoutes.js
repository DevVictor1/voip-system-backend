const express = require('express');
const router = express.Router();

const callController = require('../controllers/callController');

// 📞 MAKE CALL
router.post('/call', callController.makeCall);

// 📊 GET ALL CALLS
router.get('/logs', callController.getCalls);

// 🔥 NEW: GET CALLS BY NUMBER
router.get('/by-number/:phone', callController.getCallsByNumber);

// 🧹 CLEAR
router.delete('/clear', callController.clearCalls);

// 📡 STATUS
router.post('/call-status', callController.handleCallStatus);

// 📞 INCOMING
router.post('/incoming-call', callController.handleIncomingCall);

// 🎧 RECORDING
router.post('/recording-status', callController.handleRecordingStatus);

// 📞 OUTBOUND TWIML
router.post('/outbound-call', callController.handleOutboundCall);

module.exports = router;