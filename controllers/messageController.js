const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Team = require('../models/Team');
const User = require('../models/User');
const {
  INTERNAL_AGENTS,
  TEAM_CHANNELS,
  buildDmConversationId,
  getAgentMeta,
} = require('../config/chatConfig');

const INTERNAL_TYPES = ['internal_dm', 'team'];
const DEFAULT_TEAM_CREATOR = 'system';

const normalizeUserId = (userId) => {
  const normalized = String(userId || '').trim();
  return INTERNAL_AGENTS[normalized] ? normalized : '';
};

const resolveRole = (role) => (role === 'admin' ? 'admin' : 'agent');
const normalizeDepartment = (department) => {
  const normalized = String(department || '').trim().toLowerCase();
  return ['tech', 'support', 'sales'].includes(normalized) ? normalized : '';
};

const mapConfigTeamToTeamRecord = (team) => ({
  name: team.name,
  slug: team.id,
  members: team.members,
  department: normalizeDepartment(team.department),
  createdBy: DEFAULT_TEAM_CREATOR,
  isActive: true,
});

const mapTeamRecordToRuntime = (team) => ({
  id: team.slug,
  name: team.name,
  participants: team.members || [],
  department: normalizeDepartment(team.department),
});

const findConfigTeamById = (teamId) => {
  return TEAM_CHANNELS.find((team) => team.id === teamId) || null;
};

const ensureDefaultTeams = async () => {
  const configuredSlugs = TEAM_CHANNELS.map((team) => team.id);

  await Promise.all(
    TEAM_CHANNELS.map((team) =>
      Team.findOneAndUpdate(
        { slug: team.id },
        { $set: mapConfigTeamToTeamRecord(team) },
        { upsert: true, returnDocument: 'after' }
      )
    )
  );

  // Retire old system-defined team channels that no longer exist in config.
  await Team.updateMany(
    {
      createdBy: DEFAULT_TEAM_CREATOR,
      slug: { $nin: configuredSlugs },
      isActive: true,
    },
    {
      $set: { isActive: false },
    }
  );

  return Team.find({ isActive: true }).sort({ name: 1 });
};

const cloneTeamRecordWithMembers = (team, members) => {
  const record = typeof team?.toObject === 'function' ? team.toObject() : { ...(team || {}) };
  return {
    ...record,
    members,
    participants: members,
    department: normalizeDepartment(record.department),
  };
};

const resolveTeamMembers = async (team) => {
  const fallbackMembers = team?.members || team?.participants || [];
  const department = normalizeDepartment(team?.department);

  if (!department) {
    return getSortedParticipants(fallbackMembers);
  }

  const departmentUsers = await User.find({
    department,
    isActive: true,
    agentId: { $type: 'string', $ne: '' },
  })
    .select('agentId')
    .sort({ name: 1 });

  return getSortedParticipants([
    ...fallbackMembers,
    ...departmentUsers.map((user) => user.agentId).filter(Boolean),
  ]);
};

const getVisibleTeams = async (userId, role) => {
  const teams = await ensureDefaultTeams();
  const resolvedTeams = await Promise.all(
    teams.map(async (team) => cloneTeamRecordWithMembers(team, await resolveTeamMembers(team)))
  );

  if (role === 'admin') return resolvedTeams;
  return resolvedTeams.filter((team) => (team.members || []).includes(userId));
};

const ensureTeamConversation = async (team) => {
  if (!team) return null;

  const teamId = team.slug || team.id;
  const participants = await resolveTeamMembers(team);
  let conversation = await Conversation.findOne({
    $or: [
      { type: 'team', teamId },
      { type: 'team', conversationId: teamId },
    ],
  }).sort({ createdAt: 1 });

  if (conversation) {
    let shouldSave = false;

    if (!conversation.conversationId) {
      conversation.conversationId = teamId;
      shouldSave = true;
    }

    if (!conversation.title) {
      conversation.title = team.name;
      shouldSave = true;
    }

    if (conversation.teamId !== teamId) {
      conversation.teamId = teamId;
      shouldSave = true;
    }

    if ((conversation.participants || []).join('|') !== participants.join('|')) {
      conversation.participants = participants;
      shouldSave = true;
    }

    if (shouldSave) {
      await conversation.save();
    }

    return conversation;
  }

  return Conversation.create({
    conversationId: teamId,
    type: 'team',
    title: team.name,
    teamId,
    participants,
    createdBy: team.createdBy || DEFAULT_TEAM_CREATOR,
  });
};

const ensureTeamRecord = async ({ teamId, teamName, participants }) => {
  const resolvedTeamId = teamId || '';
  if (!resolvedTeamId) return null;

  let team = await Team.findOne({ slug: resolvedTeamId });

  if (!team) {
    const configTeam = findConfigTeamById(resolvedTeamId);
    const nextMembers = getSortedParticipants(participants || configTeam?.members || []);
    const nextName = teamName || configTeam?.name || '';
    const nextDepartment = normalizeDepartment(configTeam?.department);

    if (!nextName) {
      return null;
    }

    team = await Team.create({
      name: nextName,
      slug: resolvedTeamId,
      members: nextMembers,
      department: nextDepartment || null,
      createdBy: DEFAULT_TEAM_CREATOR,
      isActive: true,
    });
  } else if (participants?.length) {
    const nextMembers = getSortedParticipants(participants);
    if ((team.members || []).join('|') !== nextMembers.join('|')) {
      team.members = nextMembers;
      await team.save();
    }
  }

  await ensureTeamConversation(team);
  return team;
};

const findTeamByConversationId = async (conversationId) => {
  const teams = await ensureDefaultTeams();
  const team = teams.find((item) => item.slug === conversationId) || null;
  if (!team) return null;

  return cloneTeamRecordWithMembers(team, await resolveTeamMembers(team));
};

const syncConversationSummary = async (conversationId, type, conversationRecord = null) => {
  if (!conversationId || !type) return conversationRecord || null;

  const latestMessage = await Message.findOne({
    conversationId,
    conversationType: type,
  }).sort({ createdAt: -1 });

  const conversation = conversationRecord || await Conversation.findOne({
    conversationId,
    type,
  }).sort({ createdAt: 1 });

  if (!conversation) {
    return null;
  }

  const nextPreview = latestMessage?.body || '';
  const nextTimestamp = latestMessage?.createdAt || null;
  const currentPreview = conversation.lastMessagePreview || '';
  const currentTimestamp = conversation.lastMessageAt
    ? new Date(conversation.lastMessageAt).getTime()
    : null;
  const nextTimeValue = nextTimestamp
    ? new Date(nextTimestamp).getTime()
    : null;

  if (currentPreview !== nextPreview || currentTimestamp !== nextTimeValue) {
    conversation.lastMessagePreview = nextPreview;
    conversation.lastMessageAt = nextTimestamp;
    await conversation.save();
  }

  return conversation;
};

const buildInternalConversationMap = async (userId, role) => {
  const conversations = new Map();

  Object.entries(INTERNAL_AGENTS).forEach(([agentId, agent]) => {
    if (agentId === userId) return;

    const conversationId = buildDmConversationId(userId, agentId);
    conversations.set(conversationId, {
      conversationType: 'internal_dm',
      type: 'internal_dm',
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

  const visibleTeams = await getVisibleTeams(userId, role);

  for (const teamRecord of visibleTeams) {
    const teamConversation = await ensureTeamConversation(teamRecord);
    const team = mapTeamRecordToRuntime(teamRecord);

    conversations.set(teamConversation?.conversationId || team.id, {
      conversationType: 'team',
      type: 'team',
      id: teamConversation?.conversationId || team.id,
      conversationId: teamConversation?.conversationId || team.id,
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
  }

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
  ...mapConfigTeamToTeamRecord(team),
  source: 'config',
});

exports.getTeams = async (req, res) => {
  try {
    const teams = await ensureDefaultTeams();
    return res.json(teams.length > 0 ? teams : TEAM_CHANNELS.map(mapFallbackTeam));
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

    if (!currentUserId) {
      return res.status(400).json({ error: 'Invalid currentUserId' });
    }

    if (!targetUserId) {
      return res.status(400).json({ error: 'Invalid targetUserId' });
    }

    if (currentUserId === targetUserId) {
      return res.status(400).json({ error: 'Invalid participants' });
    }

    const conversation = await ensureDmConversationRecord({
      currentUserId,
      targetUserId,
      createdBy: currentUserId,
    });
    const syncedConversation = await syncConversationSummary(
      conversation?.conversationId,
      'internal_dm',
      conversation
    );

    return res.json(syncedConversation || conversation);
  } catch (error) {
    console.error('❌ Start direct conversation error:', error);
    res.status(500).json({ error: 'Failed to start direct conversation' });
  }
};

exports.getConversations = async (req, res) => {
  try {
    const userId = normalizeUserId(req.query.userId);
    const role = resolveRole(req.query.role);

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const conversations = await buildInternalConversationMap(userId, role);
    const dmRecords = await Conversation.find({
      type: 'internal_dm',
      participants: userId,
      isArchived: false,
    }).sort({ updatedAt: -1 });

    for (const dmRecord of dmRecords) {
      const conversation = await syncConversationSummary(
        dmRecord.conversationId,
        'internal_dm',
        dmRecord
      ) || dmRecord;
      const participants = getSortedParticipants(conversation.participants);
      const otherAgentId = participants.find((participant) => participant !== userId) || conversation.createdBy;
      const otherAgent = getAgentMeta(otherAgentId);
      const conversationId = conversation.conversationId || buildDmConversationId(...participants);

      conversations.set(conversationId, {
        conversationType: 'internal_dm',
        type: 'internal_dm',
        id: conversationId,
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
    }

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
            type: 'internal_dm',
            id: resolvedConversationId,
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
          const teamRecord = await ensureTeamRecord({
            teamId: message.teamId || message.conversationId,
            teamName: message.teamName || message.conversationId,
            participants: message.participants || [],
          });
          const teamConversation = teamRecord ? await ensureTeamConversation(teamRecord) : null;
          const teamParticipants = getSortedParticipants(teamRecord?.members || message.participants || []);
          const resolvedConversationId = teamConversation?.conversationId || message.conversationId;

          conversations.set(resolvedConversationId, {
            conversationType: 'team',
            type: 'team',
            id: resolvedConversationId,
            conversationId: resolvedConversationId,
            teamId: teamRecord?.slug || message.teamId || message.conversationId,
            teamName: teamRecord?.name || message.teamName || message.conversationId,
            participants: teamParticipants,
            name: teamRecord?.name || message.teamName || message.conversationId,
            role: 'Team Channel',
            lastMessage: '',
            updatedAt: null,
            unread: 0,
            isInternal: true,
            isTeam: true,
            previewFallback: `Start the conversation in ${teamRecord?.name || message.teamName || message.conversationId}`,
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

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const seededMap = await buildInternalConversationMap(userId, role);
    const seeded = seededMap.get(conversationId);
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
    const syncedDmConversation = dmConversation
      ? await syncConversationSummary(conversationId, 'internal_dm', dmConversation)
      : null;

    const teamRecord = !dmConversation
      ? await findTeamByConversationId(conversationId)
        || await ensureTeamRecord({
          teamId: messages[0]?.teamId || conversationId,
          teamName: messages[0]?.teamName,
          participants: messages[0]?.participants || [],
        })
      : null;
    const teamConversation = teamRecord
      ? await ensureTeamConversation(teamRecord)
      : null;
    const syncedTeamConversation = teamConversation
      ? await syncConversationSummary(conversationId, 'team', teamConversation)
      : null;

    const messageConversation = syncedDmConversation
      ? {
          conversationType: 'internal_dm',
          participants: syncedDmConversation.participants || [],
        }
      : syncedTeamConversation
      ? {
          conversationType: 'team',
          participants: syncedTeamConversation.participants || [],
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

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

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
      const team = await ensureTeamRecord({
        teamId: conversationId,
        teamName: req.body?.teamName,
      });

      if (!team) {
        return res.status(400).json({ error: 'Unknown team chat' });
      }

      const teamConversation = await ensureTeamConversation(team);
      const teamMembers = await resolveTeamMembers(team);

      payload = {
        from: userId,
        to: team.slug,
        body: trimmedBody,
        direction: 'outbound',
        conversationType,
        conversationId: teamConversation?.conversationId || team.slug,
        participants: teamMembers,
        teamId: team.slug,
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

    if (conversationType === 'internal_dm' || conversationType === 'team') {
      await Conversation.findOneAndUpdate(
        { conversationId: saved.conversationId, type: conversationType },
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

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

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
