const express = require('express');

const {
  getTeams,
  getConversationRecord,
  startDirectConversation,
  createTeamConversation,
  getTeamDetails,
  getTeamCalendarEvents,
  updateTeamCalendarTimezone,
  createTeamCalendarEvent,
  updateTeamCalendarEvent,
  deleteTeamCalendarEvent,
  toggleTeamCalendarEventPin,
  updateTeamDetails,
  leaveTeamConversation,
  deleteTeamConversation,
  getConversations,
   getThread,
   sendMessage,
   markConversationRead,
   editMessage,
   softDeleteMessage,
   togglePinMessage,
   toggleMessageReaction,
  } = require('../controllers/messageController');

const router = express.Router();

router.get('/teams', getTeams);
router.get('/conversation/:conversationId', getConversationRecord);
router.post('/direct/start', startDirectConversation);
router.post('/team', createTeamConversation);
router.get('/team/:conversationId/details', getTeamDetails);
router.get('/team/:conversationId/calendar', getTeamCalendarEvents);
router.patch('/team/:conversationId/calendar/timezone', updateTeamCalendarTimezone);
router.post('/team/:conversationId/calendar', createTeamCalendarEvent);
router.put('/team/:conversationId/calendar/:eventId', updateTeamCalendarEvent);
router.patch('/team/:conversationId/calendar/:eventId/pin', toggleTeamCalendarEventPin);
router.delete('/team/:conversationId/calendar/:eventId', deleteTeamCalendarEvent);
router.put('/team/:conversationId/details', updateTeamDetails);
router.post('/team/:conversationId/leave', leaveTeamConversation);
router.delete('/team/:conversationId', deleteTeamConversation);
router.get('/conversations', getConversations);
router.get('/thread/:conversationId', getThread);
router.post('/send', sendMessage);
router.put('/read/:conversationId', markConversationRead);
router.put('/message/:messageId', editMessage);
router.delete('/message/:messageId', softDeleteMessage);
router.put('/message/:messageId/pin', togglePinMessage);
router.put('/message/:messageId/reaction', toggleMessageReaction);

module.exports = router;
