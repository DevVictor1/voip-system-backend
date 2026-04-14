const express = require('express');
const router = express.Router();
const multer = require('multer');

const upload = multer({ dest: 'uploads/' });

const {
  receiveSMS,
  sendSMS,
  getConversations,
  getMessages,
  markAsRead,
  clearMessages,
  smsStatusCallback,
  uploadMedia
} = require('../controllers/smsController');

// 📩 Incoming
router.post('/webhook', receiveSMS);
router.post('/incoming-sms', receiveSMS);

// 📤 Send
router.post('/send', sendSMS);

// 📎 Upload media
router.post('/upload', upload.single('file'), uploadMedia);

// 📊 STATUS CALLBACK (NEW 🔥)
router.post('/status', smsStatusCallback);

// 📚 Conversations
router.get('/conversations', getConversations);

// 💬 Messages
router.get('/messages/:phone', getMessages);

// ✅ Read
router.put('/read/:phone', markAsRead);

// 🧹 Clear
router.delete('/clear', clearMessages);

module.exports = router;
