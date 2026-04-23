const express = require('express');
const router = express.Router();
const multer = require('multer');

const upload = multer({ dest: 'uploads/' });

const {
  receiveSMS,
  sendSMS,
  getConversations,
  getTextingGroups,
  getTextingGroupConversations,
  getTextingGroupMessages,
  getMessages,
  markAsRead,
  markTextingGroupRead,
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
router.get('/texting-groups', getTextingGroups);
router.get('/texting-groups/:groupId/conversations', getTextingGroupConversations);

// 💬 Messages
router.get('/messages/:phone', getMessages);
router.get('/texting-groups/:groupId/messages/:phone', getTextingGroupMessages);

// ✅ Read
router.put('/read/:phone', markAsRead);
router.put('/texting-groups/:groupId/read/:phone', markTextingGroupRead);

// 🧹 Clear
router.delete('/clear', clearMessages);

module.exports = router;
