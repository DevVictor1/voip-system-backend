const express = require('express');

const {
  getTeams,
  getConversationRecord,
  startDirectConversation,
  getConversations,
  getThread,
  sendMessage,
  markConversationRead,
} = require('../controllers/messageController');

const router = express.Router();

router.get('/teams', getTeams);
router.get('/conversation/:conversationId', getConversationRecord);
router.post('/direct/start', startDirectConversation);
router.get('/conversations', getConversations);
router.get('/thread/:conversationId', getThread);
router.post('/send', sendMessage);
router.put('/read/:conversationId', markConversationRead);

module.exports = router;
