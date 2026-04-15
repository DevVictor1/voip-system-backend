const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Team = require('../models/Team');
const {
  INTERNAL_AGENTS,
  TEAM_CHATS,
  buildDmConversationId,
  getAgentMeta,
} = require('../config/chatConfig');

const INTERNAL_TYPES = ['internal_dm', 'team'];

const normalizeUserId = (userId) => {
  if (!userId || !INTERNAL_AGENTS[userId]) {
    return 'agent_1';
  }

  return userId;
};

const resolveRole = (role) => (role === 'admin' ? 'admin' : 'agent');

const getVisibleTeams = (userId, role) => {
  if (role === 'admin') return TEAM_CHATS;
  return TEAM_CHATS.filter((team) => team.participants.includes(userId));
};

const buildInternalConversationMap = (userId, role) => {
  const conversations = new Map();

  Object.entries(INTERNAL_AGENTS).forEach(([agentId, agent]) => {
    if (agentId === userId) return;

    const conversationId = buildDmConversationId(userId, agentId);
    conversations.set(conversationId, {
      conversationType: 'internal_dm',
      conversationId,
      participants: [userId, agentId].sort(),
      name: agent.name,
      role: agent.role,
      agentId,
      lastMessage: '',
      updatedAt: null,
      unread: 0,
      isInternal: true,
      isTeam: false,
      previewFallback: `Message ${agent.name}`,
    });
  });

  getVisibleTeams(userId, role).forEach((team) => {
    conversations.set(team.id, {
      conversationType: 'team',
      conversationId: team.id,
      teamId: team.id,
      teamName: team.name,
      participants: team.participants,
      name: team.name,
      role: 'Team Channel',
      lastMessage: '',
      updatedAt: null,
      unread: 0,
      isInternal: true,
      isTeam: true,
      previewFallback: `Start the conversation in ${team.name}`,
    });
  });

  return conversations;
};

const isConversationVisible = (conversation, userId, role) => {
  if (!conversation) return false;

  if (conversation.conversationType === 'internal_dm') {
    return (conversation.participants || []).includes(userId);
  }

  if (conversation.conversationType === 'team') {
    if (role === 'admin') return true;
    return (conversation.participants || []).includes(userId);
  }

  return role === 'admin';
};

const buildMessageDirection = (message, userId) => {
  return message.senderId === userId ? 'outbound' : 'inbound';
};

const getSortedParticipants = (participants = []) => {
  return [...new Set((participants || []).filter(Boolean))].sort();
};

const parseLegacyDmConversationId = (conversationId) => {
  if (!conversationId || !conversationId.startsWith('dm:')) {
    return [];
  }

  return getSortedParticipants(
    conversationId.replace(/^dm:/, '').split(':')
  );
};

const getDmConversationTitle = (participants, currentUserId) => {
  const otherParticipant = participants.find((participant) => participant !== currentUserId)
    || participants[0]
    || '';

  return getAgentMeta(otherParticipant).name;
};

const findDmConversationByParticipants = async (participants) => {
  const sortedParticipants = getSortedParticipants(participants);

  if (sortedParticipants.length !== 2) {
    return null;
  }

  return Conversation.findOne({
    type: 'internal_dm',
    participants: { $all: sortedParticipants, $size: 2 },
  }).sort({ createdAt: 1 });
};

const ensureDmConversationRecord = async ({
  currentUserId,
  targetUserId,
  conversationId,
  participants,
  createdBy,
}) => {
  const resolvedParticipants = getSortedParticipants(
    participants?.length ? participants : [currentUserId, targetUserId]
  );

  if (resolvedParticipants.length !== 2) {
    return null;
  }

  const legacyConversationId = conversationId || buildDmConversationId(
    resolvedParticipants[0],
    resolvedParticipants[1]
  );

  let conversation = await Conversation.findOne({
    $or: [
      { conversationId: legacyConversationId, type: 'internal_dm' },
      { type: 'internal_dm', participants: { $all: resolvedParticipants, $size: 2 } },
    ],
  }).sort({ createdAt: 1 });

  if (conversation) {
    let shouldSave = false;

    if (!conversation.conversationId) {
      conversation.conversationId = legacyConversationId;
      shouldSave = true;
    }

    if ((conversation.participants || []).length !== 2) {
      conversation.participants = resolvedParticipants;
      shouldSave = true;
    }

    if (!conversation.title) {
      conversation.title = getDmConversationTitle(resolvedParticipants, currentUserId || createdBy || resolvedParticipants[0]);
      shouldSave = true;
    }

    if (shouldSave) {
      await conversation.save();
    }

    return conversation;
  }

  conversation = await Conversation.create({
    conversationId: legacyConversationId,
    type: 'internal_dm',
    title: getDmConversationTitle(resolvedParticipants, currentUserId || createdBy || resolvedParticipants[0]),
    participants: resolvedParticipants,
    createdBy: createdBy || currentUserId || resolvedParticipants[0],
  });

  return conversation;
};

const ensureDmConversationForMessage = async (message) => {
  if (!message || message.conversationType !== 'internal_dm') {
    return null;
  }

  const participants = getSortedParticipants(
    message.participants?.length
      ? message.participants
      : parseLegacyDmConversationId(message.conversationId)
  );

  if (participants.length !== 2) {
    return null;
  }

  return ensureDmConversationRecord({
    conversationId: message.conversationId,
    participants,
    createdBy: message.senderId || participants[0],
    currentUserId: message.senderId || participants[0],
  });
};

const mapFallbackTeam = (team) => ({
  name: team.name,
  slug: team.id,
  members: team.participants,
  createdBy: 'system',
  isActive: true,
  source: 'config',
});

exports.getTeams = async (req, res) => {
  try {
    const teams = await Team.find({ isActive: true }).sort({ name: 1 });

    if (teams.length > 0) {
      return res.json(teams);
    }

    return res.json(TEAM_CHATS.map(mapFallbackTeam));
  } catch (error) {
    console.error('❌ Teams fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
};

exports.getConversationRecord = async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findOne({ conversationId });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    return res.json(conversation);
  } catch (error) {
    console.error('❌ Conversation record error:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
};

exports.startDirectConversation = async (req, res) => {
  try {
    const currentUserId = normalizeUserId(req.body?.currentUserId);
    const targetUserId = normalizeUserId(req.body?.targetUserId);

    if (!currentUserId || !targetUserId || currentUserId === targetUserId) {
      return res.status(400).json({ error: 'Invalid participants' });
    }

    const conversation = await ensureDmConversationRecord({
      currentUserId,
      targetUserId,
      createdBy: currentUserId,
    });

    return res.json(conversation);
  } catch (error) {
    console.error('❌ Start direct conversation error:', error);
    res.status(500).json({ error: 'Failed to start direct conversation' });
  }
};

exports.getConversations = async (req, res) => {
  try {
    const userId = normalizeUserId(req.query.userId);
    const role = resolveRole(req.query.role);
    const conversations = buildInternalConversationMap(userId, role);
    const dmRecords = await Conversation.find({
      type: 'internal_dm',
      participants: userId,
      isArchived: false,
    }).sort({ updatedAt: -1 });

    dmRecords.forEach((conversation) => {
      const participants = getSortedParticipants(conversation.participants);
      const otherAgentId = participants.find((participant) => participant !== userId) || conversation.createdBy;
      const otherAgent = getAgentMeta(otherAgentId);
      const conversationId = conversation.conversationId || buildDmConversationId(...participants);

      conversations.set(conversationId, {
        conversationType: 'internal_dm',
        conversationId,
        participants,
        name: conversation.title || otherAgent.name,
        role: otherAgent.role,
        agentId: otherAgentId,
        lastMessage: conversation.lastMessagePreview || '',
        updatedAt: conversation.lastMessageAt || conversation.updatedAt || null,
        unread: 0,
        isInternal: true,
        isTeam: false,
        previewFallback: `Message ${otherAgent.name}`,
      });
    });

    const messages = await Message.find({
      conversationType: { $in: INTERNAL_TYPES },
    }).sort({ createdAt: -1 });

    for (const message of messages) {
      const messageConversation = {
        conversationType: message.conversationType,
        participants: message.participants || [],
      };

      if (!isConversationVisible(messageConversation, userId, role)) {
        continue;
      }

      const existing = conversations.get(message.conversationId);

      if (!existing) {
        if (message.conversationType === 'internal_dm') {
          const conversationRecord = await ensureDmConversationForMessage(message);
          const participants = (message.participants || []).filter(Boolean).sort();
          const otherAgentId = participants.find((participant) => participant !== userId) || message.senderId;
          const otherAgent = getAgentMeta(otherAgentId);
          const resolvedConversationId = conversationRecord?.conversationId || message.conversationId;

          conversations.set(resolvedConversationId, {
            conversationType: 'internal_dm',
            conversationId: resolvedConversationId,
            participants,
            name: conversationRecord?.title || otherAgent.name,
            role: otherAgent.role,
            agentId: otherAgentId,
            lastMessage: '',
            updatedAt: null,
            unread: 0,
            isInternal: true,
            isTeam: false,
            previewFallback: `Message ${otherAgent.name}`,
          });
        } else if (message.conversationType === 'team') {
          conversations.set(message.conversationId, {
            conversationType: 'team',
            conversationId: message.conversationId,
            teamId: message.teamId || message.conversationId,
            teamName: message.teamName || message.conversationId,
            participants: message.participants || [],
            name: message.teamName || message.conversationId,
            role: 'Team Channel',
            lastMessage: '',
            updatedAt: null,
            unread: 0,
            isInternal: true,
            isTeam: true,
            previewFallback: `Start the conversation in ${message.teamName || message.conversationId}`,
          });
        }
      }

      const conversation = conversations.get(message.conversationId);
      if (!isConversationVisible(conversation, userId, role)) {
        continue;
      }

      if (!conversation.updatedAt || new Date(message.createdAt) > new Date(conversation.updatedAt)) {
        conversation.lastMessage = message.body || 'New message';
        conversation.updatedAt = message.createdAt;
      }

      if (message.senderId !== userId && !(message.readBy || []).includes(userId)) {
        conversation.unread += 1;
      }
    }

    const result = Array.from(conversations.values())
      .filter((conversation) => isConversationVisible(conversation, userId, role))
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    res.json(result);
  } catch (error) {
    console.error('❌ Internal conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
};

exports.getThread = async (req, res) => {
  try {
    const userId = normalizeUserId(req.query.userId);
    const role = resolveRole(req.query.role);
    const { conversationId } = req.params;

    const seeded = buildInternalConversationMap(userId, role).get(conversationId);
    if (!seeded && !conversationId) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = await Message.find({
      conversationId,
      conversationType: { $in: INTERNAL_TYPES },
    }).sort({ createdAt: 1 });

    const dmConversation = conversationId.startsWith('dm:')
      ? await ensureDmConversationRecord({
          conversationId,
          participants: messages[0]?.participants?.length
            ? messages[0].participants
            : parseLegacyDmConversationId(conversationId),
          currentUserId: userId,
          createdBy: messages[0]?.senderId || userId,
        })
      : null;

    const messageConversation = dmConversation
      ? {
          conversationType: 'internal_dm',
          participants: dmConversation.participants || [],
        }
      : messages[0]
      ? {
          conversationType: messages[0].conversationType,
          participants: messages[0].participants || [],
        }
      : seeded;

    if (messageConversation && !isConversationVisible(messageConversation, userId, role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const formatted = messages.map((message) => ({
      ...message.toObject(),
      direction: buildMessageDirection(message, userId),
    }));

    res.json(formatted);
  } catch (error) {
    console.error('❌ Internal thread error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const {
      conversationType,
      conversationId,
      userId: rawUserId,
      body,
    } = req.body || {};

    const userId = normalizeUserId(rawUserId);
    const trimmedBody = String(body || '').trim();

    if (!conversationId || !trimmedBody || !INTERNAL_TYPES.includes(conversationType)) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const sender = getAgentMeta(userId);
    let payload;

    if (conversationType === 'internal_dm') {
      const dmParticipants = parseLegacyDmConversationId(conversationId);

      if (!dmParticipants.includes(userId) || dmParticipants.length !== 2) {
        return res.status(400).json({ error: 'Invalid direct chat' });
      }

      const conversation = await ensureDmConversationRecord({
        conversationId,
        participants: dmParticipants,
        currentUserId: userId,
        createdBy: userId,
      });
      const recipientId = dmParticipants.find((participant) => participant !== userId);

      payload = {
        from: userId,
        to: recipientId,
        body: trimmedBody,
        direction: 'outbound',
        conversationType,
        conversationId: conversation?.conversationId || conversationId,
        participants: dmParticipants,
        senderId: userId,
        senderName: sender.name,
        source: 'internal',
        status: 'sent',
        read: true,
        readBy: [userId],
      };
    } else {
      const team = TEAM_CHATS.find((item) => item.id === conversationId);

      if (!team) {
        return res.status(400).json({ error: 'Unknown team chat' });
      }

      payload = {
        from: userId,
        to: team.id,
        body: trimmedBody,
        direction: 'outbound',
        conversationType,
        conversationId: team.id,
        participants: team.participants,
        teamId: team.id,
        teamName: team.name,
        senderId: userId,
        senderName: sender.name,
        source: 'internal',
        status: 'sent',
        read: true,
        readBy: [userId],
      };
    }

    const saved = await Message.create(payload);

    if (conversationType === 'internal_dm') {
      await Conversation.findOneAndUpdate(
        { conversationId: saved.conversationId, type: 'internal_dm' },
        {
          $set: {
            lastMessageAt: saved.createdAt,
            lastMessagePreview: saved.body || '',
          },
        }
      );
    }

    if (global.io) {
      global.io.emit('newMessage', saved);
    }

    res.json(saved);
  } catch (error) {
    console.error('❌ Internal send error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
};

exports.markConversationRead = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = normalizeUserId(req.body?.userId || req.query.userId);

    if (!conversationId) {
      return res.status(400).json({ error: 'Missing conversation id' });
    }

    await Message.updateMany(
      {
        conversationId,
        conversationType: { $in: INTERNAL_TYPES },
        senderId: { $ne: userId },
        readBy: { $ne: userId },
      },
      {
        $addToSet: { readBy: userId },
      }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Internal read error:', error);
    res.status(500).json({ error: 'Failed to mark read' });
  }
};
