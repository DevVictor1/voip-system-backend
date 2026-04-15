const express = require('express');

const {
  getConversations,
  getThread,
  sendMessage,
  markConversationRead,
} = require('../controllers/messageController');

const router = express.Router();

router.get('/conversations', getConversations);
router.get('/thread/:conversationId', getThread);
router.post('/send', sendMessage);
router.put('/read/:conversationId', markConversationRead);

module.exports = router;
