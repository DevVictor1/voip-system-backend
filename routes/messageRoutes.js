const express = require('express');

const {
  getTeams,
  getConversationRecord,
  startDirectConversation,
  createTeamConversation,
  getTeamDetails,
  updateTeamDetails,
  leaveTeamConversation,
  deleteTeamConversation,
  getConversations,
   getThread,
   sendMessage,
   markConversationRead,
   editMessage,
   softDeleteMessage,
 } = require('../controllers/messageController');

const router = express.Router();

router.get('/teams', getTeams);
router.get('/conversation/:conversationId', getConversationRecord);
router.post('/direct/start', startDirectConversation);
router.post('/team', createTeamConversation);
router.get('/team/:conversationId/details', getTeamDetails);
router.put('/team/:conversationId/details', updateTeamDetails);
router.post('/team/:conversationId/leave', leaveTeamConversation);
router.delete('/team/:conversationId', deleteTeamConversation);
router.get('/conversations', getConversations);
router.get('/thread/:conversationId', getThread);
router.post('/send', sendMessage);
router.put('/read/:conversationId', markConversationRead);
router.put('/message/:messageId', editMessage);
router.delete('/message/:messageId', softDeleteMessage);

module.exports = router;
