const mongoose = require('mongoose');
const Message = require('../models/Message');
const MessageThreadComment = require('../models/MessageThreadComment');
const MessageThreadReadState = require('../models/MessageThreadReadState');
const ConversationNote = require('../models/ConversationNote');
const Conversation = require('../models/Conversation');
const Team = require('../models/Team');
const User = require('../models/User');
const GroupCalendarEvent = require('../models/GroupCalendarEvent');
const { isPlatformAdmin } = require('../utils/accessControl');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  INTERNAL_AGENTS,
  TEAM_CHANNELS,
  buildDmConversationId,
  getAgentMeta,
} = require('../config/chatConfig');

const INTERNAL_TYPES = ['internal_dm', 'team'];
const DEFAULT_TEAM_CREATOR = 'system';
const TEAM_DESCRIPTION_MAX_LENGTH = 500;
const TEAM_MENTION_PATTERN = /(^|\s)@([A-Za-z0-9._-]+)/g;
const TEAM_CALENDAR_TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Ho_Chi_Minh'];
const ALLOWED_MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

const INTERNAL_ATTACHMENT_UPLOAD_PATH_PREFIX = '/uploads/internal-chat/';
const TEAM_AVATAR_UPLOAD_PATH_PREFIX = '/uploads/team-avatars/';
const INTERNAL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_INTERNAL_ATTACHMENT_FILES = 10;
const ALLOWED_INTERNAL_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
]);
const LINK_PREVIEW_URL_PATTERN = /\bhttps?:\/\/[^\s<>"')]+/i;
const LINK_PREVIEW_META_PATTERN = /<meta\s+[^>]*?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*?>/gi;
const LINK_PREVIEW_TITLE_PATTERN = /<title[^>]*>([^<]*)<\/title>/i;
const LINK_PREVIEW_TIMEOUT_MS = 1200;
const LINK_PREVIEW_MAX_BYTES = 512 * 1024;
const DEFAULT_INTERNAL_THREAD_PAGE_SIZE = 50;
const MAX_INTERNAL_THREAD_PAGE_SIZE = 100;

const normalizeUserIdValue = (userId) => {
  const normalized = String(userId || '').trim();
  return normalized || '';
};

const normalizeUserId = async (userId) => {
  const normalized = normalizeUserIdValue(userId);

  if (!normalized) {
    return '';
  }

  const existingUser = await User.findOne({
    agentId: normalized,
    isActive: true,
  }).select('agentId');

  return existingUser?.agentId || '';
};

const resolveRole = (role) => (role === 'admin' ? 'admin' : 'agent');
const getVerifiedInternalActor = async (rawUserId) => {
  const normalized = normalizeUserIdValue(rawUserId);
  if (!normalized) {
    return { userId: '', role: 'agent', user: null };
  }

  const user = await User.findOne({
    agentId: normalized,
    isActive: true,
  }).select('agentId role');

  if (!user?.agentId) {
    return { userId: '', role: 'agent', user: null };
  }

  return {
    userId: user.agentId,
    role: isPlatformAdmin(user) ? 'admin' : 'agent',
    user,
  };
};

const getAuthenticatedInternalActor = (req) => {
  const userId = normalizeUserIdValue(req?.user?.agentId);
  if (!userId) {
    return { userId: '', role: 'agent', user: req?.user || null };
  }

  return {
    userId,
    role: isPlatformAdmin(req.user) ? 'admin' : 'agent',
    user: req.user,
  };
};

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
  avatarUrl: team.avatarUrl || '',
});

const getActiveInternalUsers = async () => {
  return User.find({
    isActive: true,
    agentId: { $type: 'string', $ne: '' },
  })
    .select('name role agentId department isActive avatarUrl')
    .sort({ name: 1, createdAt: 1 });
};

const findConfigTeamById = (teamId) => {
  return TEAM_CHANNELS.find((team) => team.id === teamId) || null;
};

const sanitizeTeamSlug = (value = '') => (
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
);

const isConfiguredDefaultTeam = (team) => {
  if (!team) return false;

  return Boolean(
    normalizeDepartment(team.department)
    || findConfigTeamById(team.slug || team.id)
  );
};

const isLegacyCustomSystemTeam = (team) => {
  if (!team) return false;

  return Boolean(
    team.createdBy === DEFAULT_TEAM_CREATOR
    && !isConfiguredDefaultTeam(team)
  );
};

const isSystemManagedTeam = (team) => {
  if (!team) return false;

  return isConfiguredDefaultTeam(team);
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
      department: { $in: ['tech', 'support', 'sales'] },
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

const getVisibleTeams = async (userId) => {
  const teams = await ensureDefaultTeams();
  const resolvedTeams = await Promise.all(
    teams.map(async (team) => cloneTeamRecordWithMembers(team, await resolveTeamMembers(team)))
  );

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

    if (!conversation.title || conversation.title !== team.name) {
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

const ensureTeamRecord = async ({ teamId, teamName, participants, allowMembershipUpdate = true }) => {
  const resolvedTeamId = teamId || '';
  if (!resolvedTeamId) return null;

  let team = await Team.findOne({ slug: resolvedTeamId });

  if (team && team.isActive === false) {
    return null;
  }

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
  } else if (allowMembershipUpdate && participants?.length) {
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

const getTeamDocumentByConversationId = async (conversationId) => {
  if (!conversationId) return null;

  const directMatch = await Team.findOne({
    isActive: true,
    slug: conversationId,
  });

  if (directMatch) {
    return directMatch;
  }

  const conversation = await Conversation.findOne({
    type: 'team',
    $or: [
      { conversationId },
      { teamId: conversationId },
    ],
  }).sort({ createdAt: 1 });

  if (!conversation) {
    return null;
  }

  const team = await Team.findOne({
    slug: conversation.teamId || conversation.conversationId,
    isActive: true,
  });

  if (!team) {
    return null;
  }

  return team;
};

const getTeamByConversationId = async (conversationId) => {
  const team = await getTeamDocumentByConversationId(conversationId);

  if (!team) {
    return null;
  }

  return cloneTeamRecordWithMembers(team, await resolveTeamMembers(team));
};

const buildTeamMemberDirectory = async () => {
  const users = await getActiveInternalUsers();
  return users.reduce((acc, user) => {
    if (user?.agentId) {
      acc[user.agentId] = user;
    }
    return acc;
  }, {});
};

const resolveTeamManagementAccess = async (team, currentUserId) => {
  const members = await resolveTeamMembers(team);
  const normalizedUserId = normalizeUserIdValue(currentUserId);
  const creatorId = normalizeUserIdValue(team?.createdBy);
  const isMember = Boolean(normalizedUserId && members.includes(normalizedUserId));
  const isOwner = Boolean(normalizedUserId && creatorId && creatorId === normalizedUserId);
  const manageable = !isSystemManagedTeam(team);
  const canManage = manageable && isMember && isOwner;

  return {
    members,
    creatorId,
    isMember,
    isOwner,
    manageable,
    canManage,
  };
};

const buildTeamDetailsPayload = async (team, currentUserId, role) => {
  const access = await resolveTeamManagementAccess(team, currentUserId);
  const { members } = access;
  const userDirectory = await buildTeamMemberDirectory();

  if (!access.isMember) {
    return null;
  }

  return {
    conversationId: team.slug || team.id,
    teamId: team.slug || team.id,
    teamName: team.name,
    description: typeof team.description === 'string' ? team.description : '',
    avatarUrl: typeof team.avatarUrl === 'string' ? team.avatarUrl : '',
    avatarFileName: typeof team.avatarFileName === 'string' ? team.avatarFileName : '',
    avatarMimeType: typeof team.avatarMimeType === 'string' ? team.avatarMimeType : '',
    avatarUpdatedAt: team.avatarUpdatedAt || null,
    memberCount: members.length,
    createdBy: team.createdBy || '',
    department: normalizeDepartment(team.department) || '',
    isSystemManaged: !access.manageable,
    isOwner: access.isOwner,
    canManage: access.canManage,
    canLeave: access.manageable && access.isMember && !access.isOwner,
    canDelete: access.canManage,
    managementNote: access.manageable
      ? (
        isLegacyCustomSystemTeam(team)
          ? 'This group was created before ownership tracking was added. Only the recorded creator can manage it.'
          : ''
      )
      : 'This team is managed by workspace defaults and can only be viewed here.',
    members: members.map((agentId) => {
      const user = userDirectory[agentId];
      const fallbackMeta = getAgentMeta(agentId);
      const departmentLabel = teamDepartmentLabel(user?.department || fallbackMeta?.department || '');

      return {
        agentId,
        name: user?.name || fallbackMeta?.name || agentId,
        role: departmentLabel || (user?.role === 'admin' ? 'Admin' : user?.role || fallbackMeta?.role || 'Teammate'),
        department: departmentLabel,
        avatarUrl: user?.avatarUrl || '',
        isCurrentUser: agentId === currentUserId,
      };
    }),
  };
};

const resolveValidParticipantIds = async (participantIds = [], { includeCurrentUser = '' } = {}) => {
  const normalized = getSortedParticipants([
    ...participantIds,
    ...(includeCurrentUser ? [includeCurrentUser] : []),
  ]);

  if (normalized.length === 0) {
    return [];
  }

  const activeUsers = await User.find({
    isActive: true,
    agentId: { $in: normalized },
  }).select('agentId');

  const validIds = new Set(activeUsers.map((user) => user.agentId).filter(Boolean));

  return normalized.filter((agentId) => validIds.has(agentId));
};

const generateUniqueTeamSlug = async (name) => {
  const base = sanitizeTeamSlug(name) || 'team-chat';
  let slug = base;
  let suffix = 2;

  while (await Team.exists({ slug })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }

  return slug;
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

  const nextPreview = latestMessage ? buildMessagePreview(latestMessage) : '';
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

const buildCommentSnippet = (value = '') => {
  const snippet = String(value || '').replace(/\s+/g, ' ').trim();
  if (!snippet) return '';
  return snippet.length > 140 ? `${snippet.slice(0, 140).trim()}...` : snippet;
};

const buildFormattedInternalMessage = (message, userId, threadReadState = null) => {
  const rawMessage = typeof message?.toObject === 'function' ? message.toObject() : { ...(message || {}) };
  const isPersonalChatMessage = rawMessage.conversationType === 'internal_dm';
  const latestThreadCommentAt = rawMessage.latestThreadCommentAt
    ? new Date(rawMessage.latestThreadCommentAt)
    : null;
  const lastSeenCommentAt = threadReadState?.lastSeenCommentAt
    ? new Date(threadReadState.lastSeenCommentAt)
    : null;
  const hasReadableThreadTimestamp = latestThreadCommentAt && !Number.isNaN(latestThreadCommentAt.getTime());
  const hasReadableSeenTimestamp = lastSeenCommentAt && !Number.isNaN(lastSeenCommentAt.getTime());
  const latestThreadCommentSenderId = String(rawMessage.latestThreadCommentSenderId || '').trim();
  const hasUnreadThreadReplies = Boolean(
    isPersonalChatMessage
    && Number(rawMessage.commentCount || 0) > 0
    && hasReadableThreadTimestamp
    && latestThreadCommentSenderId
    && latestThreadCommentSenderId !== String(userId || '').trim()
    && (!hasReadableSeenTimestamp || latestThreadCommentAt.getTime() > lastSeenCommentAt.getTime())
  );

  return {
    ...rawMessage,
    direction: buildMessageDirection(message, userId),
    hasUnreadThreadReplies,
    latestThreadCommentSnippet: rawMessage.latestThreadCommentSnippet || '',
  };
};

const getThreadReadStatesByMessageId = async (messages = [], userId = '') => {
  const parentMessageIds = messages
    .filter((message) => (
      message?.conversationType === 'internal_dm'
      && Number(message?.commentCount || 0) > 0
    ))
    .map((message) => String(message?._id || '').trim())
    .filter(Boolean);

  if (!parentMessageIds.length || !userId) {
    return new Map();
  }

  const readStates = await MessageThreadReadState.find({
    userId,
    parentMessageId: { $in: parentMessageIds },
  }).lean();

  return readStates.reduce((acc, readState) => {
    acc.set(String(readState.parentMessageId || ''), readState);
    return acc;
  }, new Map());
};

const buildThreadCommentPayload = (comment) => ({
  ...comment.toObject(),
});

const syncMessageCommentCount = async (messageId, latestComment = null) => {
  const parentMessageId = String(messageId || '').trim();
  if (!parentMessageId) return null;

  const nextCount = await MessageThreadComment.countDocuments({ parentMessageId });
  const nextSet = {
    commentCount: nextCount,
  };

  if (latestComment) {
    nextSet.latestThreadCommentId = String(latestComment._id || '');
    nextSet.latestThreadCommentAt = latestComment.createdAt || new Date();
    nextSet.latestThreadCommentSenderId = String(latestComment.senderId || '');
    nextSet.latestThreadCommentSenderName = String(latestComment.senderName || '');
    nextSet.latestThreadCommentSnippet = buildCommentSnippet(latestComment.body);
  }

  return Message.findByIdAndUpdate(
    parentMessageId,
    {
      $set: nextSet,
    },
    {
      new: true,
    }
  );
};

const emitInternalMessageMutation = (eventName, message) => {
  if (!global.io || !eventName || !message) {
    return;
  }

  global.io.emit(eventName, message);
};

const emitSocketEventToUser = (userId, eventName, payload) => {
  if (!global.io || !userId || !eventName) {
    return;
  }

  const socketIds = global.connectedUserSockets?.[userId];

  if (socketIds && socketIds.size > 0) {
    socketIds.forEach((socketId) => {
      global.io.to(socketId).emit(eventName, payload);
    });
    return;
  }

  const socketId = global.connectedUsers?.[userId];
  if (socketId) {
    global.io.to(socketId).emit(eventName, payload);
  }
};

const emitConversationNoteEvent = ({
  participants = [],
  eventName = '',
  payload = null,
}) => {
  if (!eventName || !payload) {
    return;
  }

  const uniqueParticipants = [...new Set(
    (participants || [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];

  if (uniqueParticipants.length === 0) {
    if (global.io) {
      global.io.emit(eventName, payload);
    }
    return;
  }

  uniqueParticipants.forEach((participantId) => {
    emitSocketEventToUser(participantId, eventName, payload);
  });
};

const buildConversationNotePayload = (note) => ({
  ...(typeof note?.toObject === 'function' ? note.toObject() : { ...(note || {}) }),
});

const extractMentionHandles = (value = '') => {
  const safeValue = String(value || '');
  const handles = [];
  let match;

  while ((match = TEAM_MENTION_PATTERN.exec(safeValue)) !== null) {
    const handle = String(match[2] || '').trim().toLowerCase();
    if (handle) {
      handles.push(handle);
    }
  }

  TEAM_MENTION_PATTERN.lastIndex = 0;
  return [...new Set(handles)];
};

const resolveTeamMentionMetadata = async (body, participantIds = []) => {
  const handles = extractMentionHandles(body);
  const participantSet = new Set(
    (participantIds || [])
      .map((participantId) => String(participantId || '').trim())
      .filter(Boolean)
  );

  if (handles.length === 0 || participantSet.size === 0) {
    return {
      mentionedUserIds: [],
      mentionedUsernames: [],
    };
  }

  const matchedUsers = await User.find({
    isActive: true,
    agentId: { $in: Array.from(participantSet) },
  }).select('agentId');

  const lookup = matchedUsers.reduce((acc, user) => {
    const agentId = String(user?.agentId || '').trim();
    if (agentId) {
      acc.set(agentId.toLowerCase(), agentId);
    }
    return acc;
  }, new Map());

  const mentionedUserIds = [];
  handles.forEach((handle) => {
    const agentId = lookup.get(handle);
    if (agentId && !mentionedUserIds.includes(agentId)) {
      mentionedUserIds.push(agentId);
    }
  });

  return {
    mentionedUserIds,
    mentionedUsernames: [...mentionedUserIds],
  };
};

const buildMentionNotificationPreview = (value = '') => {
  const trimmed = String(value || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
};

const buildInternalAttachmentUrl = (fileName) => {
  const safeFileName = encodeURIComponent(String(fileName || '').replace(/[\\/]/g, ''));
  return `${INTERNAL_ATTACHMENT_UPLOAD_PATH_PREFIX}${safeFileName}`;
};

const INTERNAL_ATTACHMENT_ROOT_DIR = path.resolve(process.cwd(), 'uploads', 'internal-chat');
const TEAM_AVATAR_ROOT_DIR = path.resolve(process.cwd(), 'uploads', 'team-avatars');

const buildTeamAvatarUrl = (fileName) => {
  const safeFileName = encodeURIComponent(String(fileName || '').replace(/[\\/]/g, ''));
  return `${TEAM_AVATAR_UPLOAD_PATH_PREFIX}${safeFileName}`;
};

const resolveTeamAvatarAbsolutePath = (storagePath = '') => {
  const normalizedPath = String(storagePath || '').trim().replace(/\\/g, '/');
  if (!normalizedPath.startsWith('team-avatars/')) {
    return '';
  }

  const relativePath = normalizedPath.slice('team-avatars/'.length).trim();
  if (!relativePath) {
    return '';
  }

  const resolvedPath = path.resolve(TEAM_AVATAR_ROOT_DIR, relativePath);
  const expectedPrefix = `${TEAM_AVATAR_ROOT_DIR}${path.sep}`;

  if (resolvedPath !== TEAM_AVATAR_ROOT_DIR && !resolvedPath.startsWith(expectedPrefix)) {
    return '';
  }

  return resolvedPath;
};

const cleanupTeamAvatarFileByStoragePath = async (storagePath = '') => {
  const absolutePath = resolveTeamAvatarAbsolutePath(storagePath);
  if (!absolutePath) return;

  await fs.promises.unlink(absolutePath).catch(() => {});
};

const cleanupTeamAvatarUploadFile = async (file = null) => {
  if (!file?.path) return;

  const resolvedPath = path.resolve(file.path);
  const expectedPrefix = `${TEAM_AVATAR_ROOT_DIR}${path.sep}`;
  if (resolvedPath !== TEAM_AVATAR_ROOT_DIR && !resolvedPath.startsWith(expectedPrefix)) {
    return;
  }

  await fs.promises.unlink(resolvedPath).catch(() => {});
};

const detectTeamAvatarFileType = async (file = null) => {
  if (!file?.path) return '';

  const resolvedPath = path.resolve(file.path);
  const expectedPrefix = `${TEAM_AVATAR_ROOT_DIR}${path.sep}`;
  if (resolvedPath !== TEAM_AVATAR_ROOT_DIR && !resolvedPath.startsWith(expectedPrefix)) {
    return '';
  }

  let handle;
  try {
    handle = await fs.promises.open(resolvedPath, 'r');
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    if (bytesRead >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'jpeg';
    }

    if (
      bytesRead >= 8
      && buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4e
      && buffer[3] === 0x47
      && buffer[4] === 0x0d
      && buffer[5] === 0x0a
      && buffer[6] === 0x1a
      && buffer[7] === 0x0a
    ) {
      return 'png';
    }

    if (
      bytesRead >= 12
      && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return 'webp';
    }
  } catch (error) {
    return '';
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }

  return '';
};

const validateTeamAvatarFileSignature = async (file = null) => {
  const detectedType = await detectTeamAvatarFileType(file);
  const mimetype = String(file?.mimetype || '').trim().toLowerCase();
  const extension = path.extname(file?.originalname || '').toLowerCase();

  if (!detectedType) {
    return false;
  }

  if (detectedType === 'jpeg') {
    return mimetype === 'image/jpeg' && ['.jpg', '.jpeg'].includes(extension);
  }

  if (detectedType === 'png') {
    return mimetype === 'image/png' && extension === '.png';
  }

  if (detectedType === 'webp') {
    return mimetype === 'image/webp' && extension === '.webp';
  }

  return false;
};

const buildTeamAvatarFields = (file) => ({
  avatarUrl: buildTeamAvatarUrl(file.filename),
  avatarStoragePath: path.posix.join('team-avatars', file.filename),
  avatarFileName: file.originalname || file.filename,
  avatarMimeType: String(file.mimetype || '').trim().toLowerCase(),
  avatarUpdatedAt: new Date(),
});

const resolveInternalAttachmentAbsolutePath = (storagePath = '') => {
  const normalizedPath = String(storagePath || '').trim().replace(/\\/g, '/');
  if (!normalizedPath.startsWith('internal-chat/')) {
    return '';
  }

  const relativePath = normalizedPath.slice('internal-chat/'.length).trim();
  if (!relativePath) {
    return '';
  }

  const resolvedPath = path.resolve(INTERNAL_ATTACHMENT_ROOT_DIR, relativePath);
  const expectedPrefix = `${INTERNAL_ATTACHMENT_ROOT_DIR}${path.sep}`;

  if (resolvedPath !== INTERNAL_ATTACHMENT_ROOT_DIR && !resolvedPath.startsWith(expectedPrefix)) {
    return '';
  }

  return resolvedPath;
};

const normalizeInternalAttachment = (attachment = null) => {
  if (!attachment || typeof attachment !== 'object') {
    return null;
  }

  const fileName = String(attachment.fileName || '').trim();
  const fileType = String(attachment.fileType || '').trim().toLowerCase();
  const fileUrl = String(attachment.fileUrl || '').trim();
  const storagePath = String(attachment.storagePath || '').trim();
  const fileSize = Number(attachment.fileSize || 0);

  if (!fileName || !fileType || !fileUrl || !storagePath) {
    return null;
  }

  if (!ALLOWED_INTERNAL_ATTACHMENT_TYPES.has(fileType)) {
    return null;
  }

  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > INTERNAL_ATTACHMENT_MAX_BYTES) {
    return null;
  }

  const normalizedPath = storagePath.replace(/\\/g, '/');
  if (!normalizedPath.startsWith('internal-chat/')) {
    return null;
  }

  const normalizedUrlPath = fileUrl.replace(/^https?:\/\/[^/]+/i, '');
  if (!normalizedUrlPath.startsWith(INTERNAL_ATTACHMENT_UPLOAD_PATH_PREFIX)) {
    return null;
  }

  return {
    fileName,
    fileType,
    fileSize,
    fileUrl,
    storagePath: normalizedPath,
  };
};

const getInternalAttachmentKind = (fileType = '', fileName = '') => {
  const normalizedType = String(fileType || '').toLowerCase();
  if (normalizedType.startsWith('image/')) return 'image';
  return 'document';
};

const normalizeInternalAttachments = (attachments = []) => {
  if (!Array.isArray(attachments)) return [];

  const normalized = [];
  const seen = new Set();

  attachments.slice(0, MAX_INTERNAL_ATTACHMENT_FILES).forEach((item) => {
    const attachment = normalizeInternalAttachment(item);
    if (!attachment) return;

    const key = [
      attachment.storagePath,
      attachment.fileName,
      attachment.fileSize,
    ].join('|');

    if (seen.has(key)) return;
    seen.add(key);
    normalized.push(attachment);
  });

  return normalized;
};

const buildInternalAttachmentPayload = (file) => {
  const fileType = String(file.mimetype || '').trim().toLowerCase();
  const fileName = String(file.originalname || file.filename || '').trim();

  return {
    fileName,
    fileType,
    fileSize: file.size,
    fileUrl: buildInternalAttachmentUrl(file.filename),
    storagePath: path.posix.join('internal-chat', file.filename),
    kind: getInternalAttachmentKind(fileType, fileName),
  };
};

const cleanupInternalUploadedFiles = async (files = []) => {
  await Promise.all(
    files.map((file) => (
      file?.path
        ? fs.promises.unlink(file.path).catch(() => {})
        : Promise.resolve()
    ))
  );
};

const buildMessagePreview = (message) => {
  if (!message) return '';
  if (message.isDeleted) return 'This message was deleted';

  const body = String(message.body || '').trim();
  if (body) return body;

  const attachmentName = String(
    message.attachment?.fileName || message.attachments?.[0]?.fileName || ''
  ).trim();
  return attachmentName ? `Attachment: ${attachmentName}` : '';
};

const normalizeMessageBody = (value = '') => (
  String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
);

const decodeHtmlEntities = (value = '') => (
  String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/&apos;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim()
);

const getHtmlMetaValue = (html = '', names = []) => {
  if (!html || !Array.isArray(names) || names.length === 0) return '';

  const normalizedNames = names.map((name) => String(name || '').trim().toLowerCase()).filter(Boolean);
  let match;

  while ((match = LINK_PREVIEW_META_PATTERN.exec(html)) !== null) {
    const key = String(match[1] || '').trim().toLowerCase();
    if (!normalizedNames.includes(key)) {
      continue;
    }

    const value = decodeHtmlEntities(match[2] || '');
    if (value) {
      LINK_PREVIEW_META_PATTERN.lastIndex = 0;
      return value;
    }
  }

  LINK_PREVIEW_META_PATTERN.lastIndex = 0;
  return '';
};

const normalizeLinkPreviewUrl = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.toString();
  } catch (error) {
    return '';
  }
};

const extractFirstPreviewUrl = (body = '') => {
  const match = String(body || '').match(LINK_PREVIEW_URL_PATTERN);
  return normalizeLinkPreviewUrl(match?.[0] || '');
};

const buildAbsolutePreviewAssetUrl = (value = '', baseUrl = '') => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    return new URL(raw, baseUrl).toString();
  } catch (error) {
    return '';
  }
};

const fetchLinkPreviewMetadata = async (body = '') => {
  const previewUrl = extractFirstPreviewUrl(body);
  if (!previewUrl) {
    return null;
  }

  try {
    const response = await axios.get(previewUrl, {
      timeout: LINK_PREVIEW_TIMEOUT_MS,
      maxRedirects: 5,
      maxContentLength: LINK_PREVIEW_MAX_BYTES,
      responseType: 'text',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; VoIPInternalChatLinkPreview/1.0)',
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    if (!contentType.includes('text/html')) {
      return null;
    }

    const html = String(response.data || '').slice(0, LINK_PREVIEW_MAX_BYTES);
    if (!html) {
      return null;
    }

    const parsedUrl = new URL(response.request?.res?.responseUrl || previewUrl);
    const title = getHtmlMetaValue(html, ['og:title', 'twitter:title'])
      || decodeHtmlEntities((html.match(LINK_PREVIEW_TITLE_PATTERN) || [])[1] || '');
    const description = getHtmlMetaValue(html, ['og:description', 'twitter:description', 'description']);
    const siteName = getHtmlMetaValue(html, ['og:site_name']) || parsedUrl.hostname.replace(/^www\./i, '');
    const image = buildAbsolutePreviewAssetUrl(
      getHtmlMetaValue(html, ['og:image', 'twitter:image', 'twitter:image:src']),
      parsedUrl.toString()
    );

    if (!title && !description && !siteName && !image) {
      return null;
    }

    return {
      url: parsedUrl.toString(),
      domain: parsedUrl.hostname.replace(/^www\./i, ''),
      title: title || parsedUrl.hostname.replace(/^www\./i, ''),
      description,
      siteName,
      image,
    };
  } catch (error) {
    return null;
  }
};

const toValidDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

const canAccessTeam = async (team, userId, role) => {
  if (!team || !userId) return false;
  if (role === 'admin') return true;

  const members = await resolveTeamMembers(team);
  return members.includes(userId);
};

const canManageCalendarEvent = (event, userId, role) => {
  if (!event || !userId) return false;
  return role === 'admin' || String(event.createdBy || '') === String(userId || '');
};

const buildGroupCalendarEventPayload = async (event) => {
  const eventRecord = typeof event?.toObject === 'function' ? event.toObject() : { ...(event || {}) };
  const creatorId = String(eventRecord.createdBy || '').trim();
  const creator = creatorId
    ? await User.findOne({ agentId: creatorId, isActive: true }).select('name agentId')
    : null;

  return {
    ...eventRecord,
    createdByName: creator?.name || creator?.agentId || creatorId || 'Teammate',
  };
};

const validateCalendarEventInput = ({
  title,
  startAt,
  endAt,
}) => {
  const normalizedTitle = String(title || '').trim();

  if (!normalizedTitle) {
    return 'Event title is required';
  }

  if (!startAt || !endAt) {
    return 'Start time and end time are required';
  }

  if (endAt <= startAt) {
    return 'End time must be after start time';
  }

  return '';
};

const emitTeamCalendarUpdate = async ({
  team,
  conversationId = '',
  action = '',
  event = null,
  eventId = '',
}) => {
  if (!global.io || !team?.slug) {
    return;
  }

  const participants = await resolveTeamMembers(team);
  const payload = {
    conversationId: conversationId || team.slug,
    teamId: team.slug,
    calendarTimezone: team.calendarTimezone || 'America/New_York',
    action,
    eventId: String(eventId || event?._id || ''),
    event: event ? await buildGroupCalendarEventPayload(event) : null,
  };

  participants.forEach((participantId) => {
    emitSocketEventToUser(participantId, 'teamCalendarUpdated', payload);
  });
};

const normalizeCalendarTimezone = (value = '') => {
  const timezone = String(value || '').trim();
  return TEAM_CALENDAR_TIMEZONES.includes(timezone) ? timezone : 'America/New_York';
};

const resolveInternalMessageAccess = async ({
  messageId,
  rawUserId,
  rawRole,
  allowAdminDelete = false,
}) => {
  const actor = await getVerifiedInternalActor(rawUserId);
  const { userId, role } = actor;

  if (!userId) {
    return { error: { status: 400, body: { error: 'Invalid userId' } } };
  }

  if (!mongoose.Types.ObjectId.isValid(messageId)) {
    return { error: { status: 400, body: { error: 'Invalid messageId' } } };
  }

  const message = await Message.findById(messageId);
  if (!message || !INTERNAL_TYPES.includes(message.conversationType)) {
    return { error: { status: 404, body: { error: 'Message not found' } } };
  }

  const visible = isConversationVisible({
    conversationType: message.conversationType,
    participants: message.participants || [],
  }, userId, role);

  if (!visible) {
    return { error: { status: 403, body: { error: 'Not allowed' } } };
  }

  const isSender = message.senderId === userId;
  const canDeleteAsAdmin = allowAdminDelete && role === 'admin';

  return {
    userId,
    role,
    message,
    isSender,
    canDeleteAsAdmin,
  };
};

const resolveInternalConversationAccess = async ({
  conversationId,
  conversationType,
  rawUserId,
  rawRole,
}) => {
  const actor = await getVerifiedInternalActor(rawUserId);
  const { userId, role } = actor;
  const normalizedConversationId = String(conversationId || '').trim();
  const normalizedConversationType = String(conversationType || '').trim();

  if (!userId) {
    return { error: { status: 400, body: { error: 'Invalid userId' } } };
  }

  if (!normalizedConversationId || !INTERNAL_TYPES.includes(normalizedConversationType)) {
    return { error: { status: 400, body: { error: 'Invalid conversation' } } };
  }

  if (normalizedConversationType === 'internal_dm') {
    const participants = parseLegacyDmConversationId(normalizedConversationId);
    const conversationRecord = await ensureDmConversationRecord({
      conversationId: normalizedConversationId,
      participants,
      currentUserId: userId,
      createdBy: participants[0] || userId,
    });

    if (!conversationRecord) {
      return { error: { status: 404, body: { error: 'Conversation not found' } } };
    }

    if (!isConversationVisible({
      conversationType: 'internal_dm',
      participants: conversationRecord.participants || participants,
    }, userId, role)) {
      return { error: { status: 403, body: { error: 'Not allowed' } } };
    }

    return {
      userId,
      role,
      conversationId: conversationRecord.conversationId || normalizedConversationId,
      conversationType: 'internal_dm',
      participants: conversationRecord.participants || participants,
      conversationRecord,
      team: null,
    };
  }

  const team = await getTeamDocumentByConversationId(normalizedConversationId);
  if (!team) {
    return { error: { status: 404, body: { error: 'Conversation not found' } } };
  }

  const canAccess = await canAccessTeam(team, userId, role);
  if (!canAccess) {
    return { error: { status: 403, body: { error: 'Not allowed' } } };
  }

  const conversationRecord = await ensureTeamConversation(team);
  const participants = await resolveTeamMembers(team);

  return {
    userId,
    role,
    conversationId: conversationRecord?.conversationId || team.slug || normalizedConversationId,
    conversationType: 'team',
    participants,
    conversationRecord,
    team,
  };
};

const buildInternalConversationMap = async (userId, role) => {
  const conversations = new Map();
  const activeUsers = await getActiveInternalUsers();

  activeUsers.forEach((user) => {
    const agentId = user?.agentId;
    if (!agentId || agentId === userId) return;

    const fallbackMeta = getAgentMeta(agentId);
    const displayName = user.name || fallbackMeta.name || agentId;
    const roleLabel = normalizeDepartment(user.department)
      ? teamDepartmentLabel(user.department)
      : (user.role === 'admin' ? 'Admin' : user.role || fallbackMeta.role || 'Agent');
    const conversationId = buildDmConversationId(userId, agentId);

    conversations.set(conversationId, {
      conversationType: 'internal_dm',
      type: 'internal_dm',
      conversationId,
      participants: [userId, agentId].sort(),
      name: displayName,
      role: roleLabel,
      agentId,
      avatarUrl: user.avatarUrl || '',
      lastMessage: '',
      updatedAt: null,
      unread: 0,
      unreadMentionCount: 0,
      latestUnreadMentionMessageId: '',
      isInternal: true,
      isTeam: false,
      previewFallback: `Message ${displayName}`,
    });
  });

  const visibleTeams = await getVisibleTeams(userId);

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
      avatarUrl: team.avatarUrl || '',
      role: 'Team Channel',
      lastMessage: '',
      lastMessageSenderName: '',
      updatedAt: null,
      unread: 0,
      unreadMentionCount: 0,
      latestUnreadMentionMessageId: '',
      isInternal: true,
      isTeam: true,
      previewFallback: `Start the conversation in ${team.name}`,
    });
  }

  return conversations;
};

const teamDepartmentLabel = (department) => {
  const normalized = normalizeDepartment(department);

  if (normalized === 'tech') return 'Tech Support';
  if (normalized === 'support') return 'Customer Support';
  if (normalized === 'sales') return 'Sales';
  return '';
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

const isConversationVisibleForRead = (conversation, userId) => {
  if (!conversation || !userId) return false;

  if (conversation.conversationType === 'internal_dm') {
    return (conversation.participants || []).includes(userId);
  }

  if (conversation.conversationType === 'team') {
    return (conversation.participants || []).includes(userId);
  }

  return false;
};

const buildMessageDirection = (message, userId) => {
  return message.senderId === userId ? 'outbound' : 'inbound';
};

const emitInternalMessageStatus = ({
  conversationId,
  conversationType,
  messageIds = [],
  status,
  userId = '',
}) => {
  if (!global.io || !conversationId || !conversationType || !status || messageIds.length === 0) {
    return;
  }

  global.io.emit('internalMessageStatus', {
    conversationId,
    conversationType,
    messageIds: messageIds.map((id) => String(id)),
    status,
    userId: userId || '',
  });
};

const getSortedParticipants = (participants = []) => {
  return [...new Set((participants || []).filter(Boolean))].sort();
};

const LEGACY_INTERNAL_AGENT_IDS = new Set(Object.keys(INTERNAL_AGENTS || {}));

const getOtherParticipant = (participants = [], currentUserId = '') => {
  return participants.find((participant) => participant !== currentUserId)
    || participants[0]
    || '';
};

const isLegacyInternalParticipant = (participantId = '') => {
  return LEGACY_INTERNAL_AGENT_IDS.has(String(participantId || '').trim());
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
    const actor = getAuthenticatedInternalActor(req);

    if (!actor.userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const teams = await getVisibleTeams(actor.userId);
    return res.json(teams);
  } catch (error) {
    console.error('❌ Teams fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
};

exports.getConversationRecord = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const actor = getAuthenticatedInternalActor(req);

    if (!actor.userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const conversation = await Conversation.findOne({ conversationId });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (conversation.type === 'team' || conversation.conversationType === 'team') {
      const team = await getTeamDocumentByConversationId(conversationId);
      if (!team) {
        return res.status(404).json({ error: 'Team not found' });
      }

      const members = await resolveTeamMembers(team);
      if (!members.includes(actor.userId)) {
        return res.status(403).json({ error: 'Not allowed' });
      }
    }

    return res.json(conversation);
  } catch (error) {
    console.error('❌ Conversation record error:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
};

exports.startDirectConversation = async (req, res) => {
  try {
    const currentUserId = await normalizeUserId(req.body?.currentUserId);
    const targetUserId = await normalizeUserId(req.body?.targetUserId);

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

exports.createTeamConversation = async (req, res) => {
  try {
    const actor = getAuthenticatedInternalActor(req);
    const { userId, role } = actor;
    const teamName = String(req.body?.teamName || '').trim();
    const participantIds = Array.isArray(req.body?.participantIds) ? req.body.participantIds : [];

    if (!userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (!teamName) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const members = await resolveValidParticipantIds(participantIds, { includeCurrentUser: userId });

    if (members.length < 2) {
      return res.status(400).json({ error: 'Select at least one teammate' });
    }

    const slug = await generateUniqueTeamSlug(teamName);
    const team = await Team.create({
      name: teamName,
      slug,
      members,
      department: null,
      createdBy: userId,
      isActive: true,
    });

    const conversation = await ensureTeamConversation(team);
    const payload = await buildTeamDetailsPayload(team, userId, role);

    return res.status(201).json({
      ...payload,
      conversationType: 'team',
      type: 'team',
      id: conversation?.conversationId || team.slug,
      conversationId: conversation?.conversationId || team.slug,
      teamId: team.slug,
      name: team.name,
      role: 'Group chat',
      lastMessage: '',
      updatedAt: conversation?.updatedAt || team.updatedAt,
      unread: 0,
      isInternal: true,
      isTeam: true,
      previewFallback: `Start the conversation in ${team.name}`,
    });
  } catch (error) {
    console.error('❌ Create team conversation error:', error);
    res.status(500).json({ error: 'Failed to create group chat' });
  }
};

exports.deleteTeamConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const actor = getAuthenticatedInternalActor(req);
    const { userId, role } = actor;

    if (!userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    if (isSystemManagedTeam(team)) {
      return res.status(400).json({ error: 'This team is managed by workspace defaults' });
    }

    const access = await resolveTeamManagementAccess(team, userId, role);

    if (!access.isMember) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (!access.canManage) {
      return res.status(403).json({ error: 'Only the group creator can delete this group' });
    }

    team.members = [];
    team.isActive = false;
    await team.save();

    await Conversation.updateMany(
      {
        type: 'team',
        $or: [
          { teamId: team.slug },
          { conversationId: team.slug },
        ],
      },
      {
        $set: {
          participants: [],
          title: team.name,
          isArchived: true,
        },
      }
    );

    await GroupCalendarEvent.deleteMany({ teamId: team.slug });

    return res.json({
      success: true,
      conversationId: team.slug,
      teamId: team.slug,
    });
  } catch (error) {
    console.error('❌ Delete team error:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
};

exports.getTeamDetails = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const actor = getAuthenticatedInternalActor(req);
    const { userId, role } = actor;

    if (!userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const payload = await buildTeamDetailsPayload(team, userId, role);

    if (!payload) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    return res.json(payload);
  } catch (error) {
    console.error('❌ Team details error:', error);
    res.status(500).json({ error: 'Failed to fetch team details' });
  }
};

exports.getTeamCalendarEvents = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const actor = await getVerifiedInternalActor(req.query.userId);
    const { userId, role } = actor;

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const canAccess = await canAccessTeam(team, userId, role);
    if (!canAccess) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const events = await GroupCalendarEvent.find({ teamId: team.slug })
      .sort({ isPinned: -1, pinnedAt: 1, startAt: 1, createdAt: 1 });
    const payload = await Promise.all(events.map((event) => buildGroupCalendarEventPayload(event)));

    return res.json({
      conversationId,
      teamId: team.slug,
      teamName: team.name,
      calendarTimezone: normalizeCalendarTimezone(team.calendarTimezone),
      events: payload,
    });
  } catch (error) {
    console.error('❌ Team calendar fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch group calendar events' });
  }
};

exports.updateTeamCalendarTimezone = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const actor = await getVerifiedInternalActor(req.body?.userId);
    const { userId, role } = actor;
    const nextTimezone = String(req.body?.calendarTimezone || '').trim();

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    if (!TEAM_CALENDAR_TIMEZONES.includes(nextTimezone)) {
      return res.status(400).json({ error: 'Unsupported calendar timezone' });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const canAccess = await canAccessTeam(team, userId, role);
    if (!canAccess) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    team.calendarTimezone = nextTimezone;
    await team.save();

    await emitTeamCalendarUpdate({
      team,
      conversationId,
      action: 'timezoneUpdated',
    });

    return res.json({
      success: true,
      conversationId,
      teamId: team.slug,
      calendarTimezone: normalizeCalendarTimezone(team.calendarTimezone),
    });
  } catch (error) {
    console.error('❌ Team calendar timezone update error:', error);
    return res.status(500).json({ error: 'Failed to update calendar timezone' });
  }
};

exports.createTeamCalendarEvent = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const actor = await getVerifiedInternalActor(req.body?.userId);
    const { userId, role } = actor;
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim();
    const startAt = toValidDate(req.body?.startAt);
    const endAt = toValidDate(req.body?.endAt);

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const validationError = validateCalendarEventInput({ title, startAt, endAt });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const canAccess = await canAccessTeam(team, userId, role);
    if (!canAccess) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const event = await GroupCalendarEvent.create({
      teamId: team.slug,
      title,
      description,
      startAt,
      endAt,
      createdBy: userId,
    });

    await emitTeamCalendarUpdate({
      team,
      conversationId,
      action: 'created',
      event,
    });

    return res.status(201).json(await buildGroupCalendarEventPayload(event));
  } catch (error) {
    console.error('❌ Team calendar create error:', error);
    return res.status(500).json({ error: 'Failed to create group calendar event' });
  }
};

exports.updateTeamCalendarEvent = async (req, res) => {
  try {
    const { conversationId, eventId } = req.params;
    const actor = await getVerifiedInternalActor(req.body?.userId);
    const { userId, role } = actor;
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim();
    const startAt = toValidDate(req.body?.startAt);
    const endAt = toValidDate(req.body?.endAt);

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const validationError = validateCalendarEventInput({ title, startAt, endAt });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const canAccess = await canAccessTeam(team, userId, role);
    if (!canAccess) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const event = await GroupCalendarEvent.findOne({ _id: eventId, teamId: team.slug });
    if (!event) {
      return res.status(404).json({ error: 'Calendar event not found' });
    }

    if (!canManageCalendarEvent(event, userId, role)) {
      return res.status(403).json({ error: 'Only the event creator or an admin can update this event' });
    }

    event.title = title;
    event.description = description;
    event.startAt = startAt;
    event.endAt = endAt;
    await event.save();

    await emitTeamCalendarUpdate({
      team,
      conversationId,
      action: 'updated',
      event,
    });

    return res.json(await buildGroupCalendarEventPayload(event));
  } catch (error) {
    console.error('❌ Team calendar update error:', error);
    return res.status(500).json({ error: 'Failed to update group calendar event' });
  }
};

exports.deleteTeamCalendarEvent = async (req, res) => {
  try {
    const { conversationId, eventId } = req.params;
    const actor = await getVerifiedInternalActor(req.body?.userId || req.query?.userId);
    const { userId, role } = actor;

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const canAccess = await canAccessTeam(team, userId, role);
    if (!canAccess) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const event = await GroupCalendarEvent.findOne({ _id: eventId, teamId: team.slug });
    if (!event) {
      return res.status(404).json({ error: 'Calendar event not found' });
    }

    if (!canManageCalendarEvent(event, userId, role)) {
      return res.status(403).json({ error: 'Only the event creator or an admin can delete this event' });
    }

    await GroupCalendarEvent.deleteOne({ _id: event._id });

    await emitTeamCalendarUpdate({
      team,
      conversationId,
      action: 'deleted',
      eventId: event._id,
    });

    return res.json({ success: true, eventId: String(event._id) });
  } catch (error) {
    console.error('❌ Team calendar delete error:', error);
    return res.status(500).json({ error: 'Failed to delete group calendar event' });
  }
};

exports.toggleTeamCalendarEventPin = async (req, res) => {
  try {
    const { conversationId, eventId } = req.params;
    const actor = await getVerifiedInternalActor(req.body?.userId);
    const { userId, role } = actor;
    const shouldPin = Boolean(req.body?.pinned);

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const canAccess = await canAccessTeam(team, userId, role);
    if (!canAccess) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const event = await GroupCalendarEvent.findOne({ _id: eventId, teamId: team.slug });
    if (!event) {
      return res.status(404).json({ error: 'Calendar event not found' });
    }

    if (!canManageCalendarEvent(event, userId, role)) {
      return res.status(403).json({ error: 'Only the event creator or an admin can pin this event' });
    }

    if (shouldPin) {
      await GroupCalendarEvent.updateMany(
        { teamId: team.slug, _id: { $ne: event._id }, isPinned: true },
        { $set: { isPinned: false, pinnedAt: null } }
      );
      event.isPinned = true;
      event.pinnedAt = new Date();
    } else {
      event.isPinned = false;
      event.pinnedAt = null;
    }

    await event.save();

    await emitTeamCalendarUpdate({
      team,
      conversationId,
      action: shouldPin ? 'pinned' : 'unpinned',
      event,
    });

    return res.json(await buildGroupCalendarEventPayload(event));
  } catch (error) {
    console.error('❌ Team calendar pin toggle error:', error);
    return res.status(500).json({ error: 'Failed to update calendar event pin state' });
  }
};

exports.updateTeamDetails = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const actor = getAuthenticatedInternalActor(req);
    const { userId, role } = actor;
    const nextName = String(req.body?.teamName || '').trim();
    const requestedMemberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds : null;
    const hasDescriptionUpdate = Object.prototype.hasOwnProperty.call(req.body || {}, 'description');
    const nextDescription = hasDescriptionUpdate ? String(req.body.description || '').trim() : null;

    if (!userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const access = await resolveTeamManagementAccess(team, userId, role);

    if (!access.isMember) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (isSystemManagedTeam(team)) {
      return res.status(400).json({ error: 'This team is managed by workspace defaults' });
    }

    if (!access.canManage) {
      return res.status(403).json({ error: 'Only the group creator can update this group' });
    }

    if (hasDescriptionUpdate && typeof req.body.description !== 'string') {
      return res.status(400).json({ error: 'Group description must be text' });
    }

    if (hasDescriptionUpdate && nextDescription.length > TEAM_DESCRIPTION_MAX_LENGTH) {
      return res.status(400).json({ error: `Group description must be ${TEAM_DESCRIPTION_MAX_LENGTH} characters or less` });
    }

    if (nextName) {
      team.name = nextName;
    }

    if (hasDescriptionUpdate) {
      team.description = nextDescription;
    }

    if (requestedMemberIds) {
      const nextMembers = await resolveValidParticipantIds(requestedMemberIds);

      if (nextMembers.length === 0) {
        return res.status(400).json({ error: 'A group must have at least one member' });
      }

      if (access.creatorId && !nextMembers.includes(access.creatorId)) {
        return res.status(400).json({ error: 'The group creator cannot be removed without transferring ownership first' });
      }

      team.members = nextMembers;
    }

    await team.save();
    const conversation = await ensureTeamConversation(team);
    await syncConversationSummary(conversation?.conversationId || team.slug, 'team', conversation);

    const payload = await buildTeamDetailsPayload(team, userId, role);
    return res.json(payload);
  } catch (error) {
    console.error('❌ Update team details error:', error);
    res.status(500).json({ error: 'Failed to update team details' });
  }
};

exports.uploadTeamAvatar = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const actor = getAuthenticatedInternalActor(req);
    const { userId, role } = actor;

    if (!userId) {
      await cleanupTeamAvatarUploadFile(req.file);
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Avatar image is required' });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      await cleanupTeamAvatarUploadFile(req.file);
      return res.status(404).json({ error: 'Team not found' });
    }

    const access = await resolveTeamManagementAccess(team, userId, role);

    if (!access.isMember) {
      await cleanupTeamAvatarUploadFile(req.file);
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (isSystemManagedTeam(team)) {
      await cleanupTeamAvatarUploadFile(req.file);
      return res.status(400).json({ error: 'This team is managed by workspace defaults' });
    }

    if (!access.canManage) {
      await cleanupTeamAvatarUploadFile(req.file);
      return res.status(403).json({ error: 'Only the group creator can update this group avatar' });
    }

    const hasValidImageSignature = await validateTeamAvatarFileSignature(req.file);
    if (!hasValidImageSignature) {
      await cleanupTeamAvatarUploadFile(req.file);
      return res.status(400).json({ error: 'Avatar file must be a valid JPG, PNG, or WebP image' });
    }

    const previousStoragePath = team.avatarStoragePath || '';
    const nextAvatarFields = buildTeamAvatarFields(req.file);

    Object.assign(team, nextAvatarFields);

    try {
      await team.save();
    } catch (error) {
      await cleanupTeamAvatarUploadFile(req.file);
      throw error;
    }

    if (previousStoragePath && previousStoragePath !== team.avatarStoragePath) {
      await cleanupTeamAvatarFileByStoragePath(previousStoragePath);
    }

    const payload = await buildTeamDetailsPayload(team, userId, role);
    return res.json(payload);
  } catch (error) {
    console.error('Team avatar upload error:', error);
    return res.status(500).json({ error: 'Failed to update group avatar' });
  }
};

exports.removeTeamAvatar = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const actor = getAuthenticatedInternalActor(req);
    const { userId, role } = actor;

    if (!userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const access = await resolveTeamManagementAccess(team, userId, role);

    if (!access.isMember) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (isSystemManagedTeam(team)) {
      return res.status(400).json({ error: 'This team is managed by workspace defaults' });
    }

    if (!access.canManage) {
      return res.status(403).json({ error: 'Only the group creator can remove this group avatar' });
    }

    const previousStoragePath = team.avatarStoragePath || '';

    team.avatarUrl = '';
    team.avatarStoragePath = '';
    team.avatarFileName = '';
    team.avatarMimeType = '';
    team.avatarUpdatedAt = null;

    await team.save();

    if (previousStoragePath) {
      await cleanupTeamAvatarFileByStoragePath(previousStoragePath);
    }

    const payload = await buildTeamDetailsPayload(team, userId, role);
    return res.json(payload);
  } catch (error) {
    console.error('Team avatar removal error:', error);
    return res.status(500).json({ error: 'Failed to remove group avatar' });
  }
};

exports.leaveTeamConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const actor = getAuthenticatedInternalActor(req);
    const { userId, role } = actor;

    if (!userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const team = await getTeamDocumentByConversationId(conversationId);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    if (isSystemManagedTeam(team)) {
      return res.status(400).json({ error: 'This team is managed by workspace defaults' });
    }

    const access = await resolveTeamManagementAccess(team, userId, role);
    const currentMembers = access.members;

    if (!access.isMember) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    if (access.isOwner) {
      return res.status(400).json({ error: 'The group creator cannot leave this group. Delete the group or transfer ownership first.' });
    }

    const remainingMembers = currentMembers.filter((memberId) => memberId !== userId);

    if (remainingMembers.length === 0) {
      team.members = [];
      team.isActive = false;
      await team.save();

      await Conversation.findOneAndUpdate(
        {
          type: 'team',
          $or: [
            { teamId: team.slug },
            { conversationId: team.slug },
          ],
        },
        {
          $set: {
            participants: [],
            title: team.name,
            isArchived: true,
          },
        }
      );

      return res.json({ success: true, archived: true });
    }

    team.members = remainingMembers;
    await team.save();
    await ensureTeamConversation(team);

    return res.json({ success: true, archived: false });
  } catch (error) {
    console.error('❌ Leave team error:', error);
    res.status(500).json({ error: 'Failed to leave group' });
  }
};

exports.getConversations = async (req, res) => {
  try {
    const actor = getAuthenticatedInternalActor(req);
    const { userId, role } = actor;

    if (!userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const conversations = await buildInternalConversationMap(userId, role);
    const activeUsers = await getActiveInternalUsers();
    const activeUsersByAgentId = activeUsers.reduce((acc, user) => {
      if (user?.agentId) {
        acc[user.agentId] = user;
      }
      return acc;
    }, {});
    const activeUserAgentIds = new Set(
      activeUsers
        .map((user) => normalizeUserIdValue(user?.agentId))
        .filter(Boolean)
    );
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
      const otherAgentId = getOtherParticipant(participants, userId) || conversation.createdBy;

      if (!otherAgentId || isLegacyInternalParticipant(otherAgentId) || !activeUserAgentIds.has(otherAgentId)) {
        continue;
      }

      const otherAgent = getAgentMeta(otherAgentId);
      const otherAgentRecord = activeUsersByAgentId[otherAgentId];
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
        avatarUrl: otherAgentRecord?.avatarUrl || '',
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
    const teamReadAccessCache = new Map();

    for (const message of messages) {
      let currentTeamMembers = null;

      if (message.conversationType === 'team') {
        const teamKey = String(message.teamId || message.conversationId || '').trim();
        if (!teamKey) {
          continue;
        }

        let cachedAccess = teamReadAccessCache.get(teamKey);
        if (!cachedAccess) {
          const teamRecord = await ensureTeamRecord({
            teamId: message.teamId || message.conversationId,
            teamName: message.teamName || message.conversationId,
            participants: message.participants || [],
            allowMembershipUpdate: false,
          });
          const teamMembers = teamRecord ? await resolveTeamMembers(teamRecord) : [];
          cachedAccess = {
            teamRecord,
            members: teamMembers,
            allowed: teamMembers.includes(userId),
          };
          teamReadAccessCache.set(teamKey, cachedAccess);
        }

        if (!cachedAccess.allowed) {
          continue;
        }

        currentTeamMembers = cachedAccess.members;
      }

      const messageConversation = {
        conversationType: message.conversationType,
        participants: message.conversationType === 'team'
          ? currentTeamMembers || []
          : message.participants || [],
      };

      if (!isConversationVisibleForRead(messageConversation, userId)) {
        continue;
      }

      const existing = conversations.get(message.conversationId);

      if (!existing) {
        if (message.conversationType === 'internal_dm') {
          const participants = (message.participants || []).filter(Boolean).sort();
          const otherAgentId = getOtherParticipant(participants, userId) || message.senderId;

          if (!otherAgentId || isLegacyInternalParticipant(otherAgentId) || !activeUserAgentIds.has(otherAgentId)) {
            continue;
          }

          const conversationRecord = await ensureDmConversationForMessage(message);
          const otherAgent = getAgentMeta(otherAgentId);
          const otherAgentRecord = activeUsersByAgentId[otherAgentId];
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
            avatarUrl: otherAgentRecord?.avatarUrl || '',
            lastMessage: '',
            updatedAt: null,
            unread: 0,
            unreadMentionCount: 0,
            latestUnreadMentionMessageId: '',
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
            avatarUrl: teamRecord?.avatarUrl || '',
            role: 'Team Channel',
            lastMessage: '',
            lastMessageSenderName: '',
            updatedAt: null,
            unread: 0,
            unreadMentionCount: 0,
            latestUnreadMentionMessageId: '',
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
        conversation.lastMessage = buildMessagePreview(message) || 'New message';
        conversation.lastMessageSenderName = message.senderName
          || getAgentMeta(message.senderId).name
          || '';
        conversation.updatedAt = message.createdAt;
      }

      if (message.senderId !== userId && !(message.readBy || []).includes(userId)) {
        conversation.unread += 1;

        if (
          message.conversationType === 'team'
          && !message.isDeleted
          && (message.mentionedUserIds || []).includes(userId)
        ) {
          conversation.unreadMentionCount = Number(conversation.unreadMentionCount || 0) + 1;
          conversation.latestUnreadMentionMessageId = String(message._id || '');
        }
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

function normalizeInternalThreadLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERNAL_THREAD_PAGE_SIZE;
  return Math.min(parsed, MAX_INTERNAL_THREAD_PAGE_SIZE);
}

function buildInternalThreadCursorQuery({ beforeCreatedAt, beforeId }) {
  const cursorDate = beforeCreatedAt ? new Date(beforeCreatedAt) : null;
  if (!cursorDate || Number.isNaN(cursorDate.getTime())) return {};

  const cursorClauses = [{ createdAt: { $lt: cursorDate } }];

  if (beforeId && mongoose.Types.ObjectId.isValid(beforeId)) {
    cursorClauses.push({
      createdAt: cursorDate,
      _id: { $lt: new mongoose.Types.ObjectId(beforeId) },
    });
  }

  return { $or: cursorClauses };
}

function buildMessageCursor(message) {
  if (!message?._id || !message?.createdAt) return null;

  return {
    createdAt: message.createdAt,
    id: String(message._id),
  };
}

exports.getThread = async (req, res) => {
  try {
    const actor = getAuthenticatedInternalActor(req);
    const { userId, role } = actor;
    const { conversationId } = req.params;
    const shouldPaginate = req.query.paginated === 'true' && String(conversationId || '').startsWith('dm:');
    const pageLimit = normalizeInternalThreadLimit(req.query.limit);

    if (!userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const seededMap = await buildInternalConversationMap(userId, role);
    const seeded = seededMap.get(conversationId);
    if (!seeded && !conversationId) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const baseMessageQuery = {
      conversationId,
      conversationType: { $in: INTERNAL_TYPES },
    };
    const cursorQuery = shouldPaginate
      ? buildInternalThreadCursorQuery({
          beforeCreatedAt: req.query.beforeCreatedAt,
          beforeId: req.query.beforeId,
        })
      : {};
    const messageQuery = Object.keys(cursorQuery).length > 0
      ? { $and: [baseMessageQuery, cursorQuery] }
      : baseMessageQuery;

    const messages = shouldPaginate
      ? (await Message.find(messageQuery)
        .sort({ createdAt: -1, _id: -1 })
        .limit(pageLimit + 1)
        .lean())
        .reverse()
      : await Message.find(messageQuery).sort({ createdAt: 1 });
    const hasMoreBefore = shouldPaginate && messages.length > pageLimit;
    const pageMessages = shouldPaginate && hasMoreBefore ? messages.slice(1) : messages;

    const dmConversation = conversationId.startsWith('dm:')
      ? await ensureDmConversationRecord({
          conversationId,
          participants: pageMessages[0]?.participants?.length
            ? pageMessages[0].participants
            : parseLegacyDmConversationId(conversationId),
          currentUserId: userId,
          createdBy: pageMessages[0]?.senderId || userId,
        })
      : null;
    const syncedDmConversation = dmConversation
      ? await syncConversationSummary(conversationId, 'internal_dm', dmConversation)
      : null;

    const teamRecord = !dmConversation
      ? await findTeamByConversationId(conversationId)
        || await ensureTeamRecord({
          teamId: pageMessages[0]?.teamId || conversationId,
          teamName: pageMessages[0]?.teamName,
          participants: pageMessages[0]?.participants || [],
          allowMembershipUpdate: false,
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
      : pageMessages[0]
      ? {
          conversationType: pageMessages[0].conversationType,
          participants: pageMessages[0].participants || [],
        }
      : seeded;

    if (messageConversation && !isConversationVisibleForRead(messageConversation, userId)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const threadReadStatesByMessageId = await getThreadReadStatesByMessageId(pageMessages, userId);
    const formatted = pageMessages.map((message) => buildFormattedInternalMessage(
      message,
      userId,
      threadReadStatesByMessageId.get(String(message?._id || '')) || null
    ));

    if (shouldPaginate) {
      return res.json({
        messages: formatted,
        pagination: {
          limit: pageLimit,
          hasMoreBefore,
          oldestCursor: buildMessageCursor(pageMessages[0]),
          newestCursor: buildMessageCursor(pageMessages[pageMessages.length - 1]),
        },
      });
    }

    res.json(formatted);
  } catch (error) {
    console.error('❌ Internal thread error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
};

exports.uploadInternalAttachment = async (req, res) => {
  try {
    if (!req.user || !req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileType = String(req.file.mimetype || '').trim().toLowerCase();
    if (!ALLOWED_INTERNAL_ATTACHMENT_TYPES.has(fileType)) {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    if (!Number.isFinite(req.file.size) || req.file.size <= 0 || req.file.size > INTERNAL_ATTACHMENT_MAX_BYTES) {
      return res.status(400).json({ error: 'File is too large' });
    }

    return res.json({
      attachment: buildInternalAttachmentPayload(req.file),
    });
  } catch (error) {
    console.error('Internal attachment upload error:', error);
    await cleanupInternalUploadedFiles(req.file ? [req.file] : []);
    return res.status(500).json({ error: 'Upload failed' });
  }
};

exports.uploadInternalAttachments = async (req, res) => {
  const uploadedFiles = Array.isArray(req.files) ? req.files : [];

  try {
    if (!req.user) {
      await cleanupInternalUploadedFiles(uploadedFiles);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    if (uploadedFiles.length > MAX_INTERNAL_ATTACHMENT_FILES) {
      await cleanupInternalUploadedFiles(uploadedFiles);
      return res.status(400).json({ error: `You can upload up to ${MAX_INTERNAL_ATTACHMENT_FILES} files at once` });
    }

    const attachments = uploadedFiles.map((file) => {
      const fileType = String(file.mimetype || '').trim().toLowerCase();

      if (!ALLOWED_INTERNAL_ATTACHMENT_TYPES.has(fileType)) {
        throw new Error('Unsupported file type');
      }

      if (!Number.isFinite(file.size) || file.size <= 0 || file.size > INTERNAL_ATTACHMENT_MAX_BYTES) {
        throw new Error('Each file must be 10 MB or smaller');
      }

      return buildInternalAttachmentPayload(file);
    });

    return res.json({ attachments });
  } catch (error) {
    console.error('Internal attachments upload error:', error);
    await cleanupInternalUploadedFiles(uploadedFiles);
    return res.status(400).json({ error: error?.message || 'Upload failed' });
  }
};

exports.downloadInternalAttachment = async (req, res) => {
  try {
    if (!req.user?.agentId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { messageId } = req.params;
    const access = await resolveInternalMessageAccess({
      messageId,
      rawUserId: req.user.agentId,
      rawRole: req.user.role,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const { message } = access;
    const requestedIndex = Number.parseInt(req.params.attachmentIndex, 10);
    const normalizedAttachments = normalizeInternalAttachments(message?.attachments || []);
    const legacyAttachment = message?.attachment && typeof message.attachment === 'object'
      ? message.attachment
      : null;
    const attachment = Number.isInteger(requestedIndex)
      ? normalizedAttachments[requestedIndex] || (requestedIndex === 0 ? legacyAttachment : null)
      : (legacyAttachment || normalizedAttachments[0] || null);

    if (!attachment?.storagePath || !attachment?.fileName || !attachment?.fileType) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const absolutePath = resolveInternalAttachmentAbsolutePath(attachment.storagePath);
    if (!absolutePath) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    try {
      await fs.promises.access(absolutePath, fs.constants.R_OK);
    } catch (error) {
      return res.status(404).json({ error: 'Attachment file is unavailable' });
    }

    const shouldDownload = ['1', 'true', 'yes'].includes(
      String(req.query.download || '').trim().toLowerCase()
    );
    const safeFileName = String(attachment.fileName || 'attachment').replace(/[\r\n"]/g, '').trim() || 'attachment';

    res.setHeader('Content-Type', attachment.fileType || 'application/octet-stream');
    res.setHeader('Content-Length', String(Number(attachment.fileSize || 0) || fs.statSync(absolutePath).size));
    res.setHeader(
      'Content-Disposition',
      `${shouldDownload ? 'attachment' : 'inline'}; filename="${safeFileName}"`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');

    return res.sendFile(absolutePath);
  } catch (error) {
    console.error('Internal attachment download error:', error);
    return res.status(500).json({ error: 'Failed to access attachment' });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const {
      conversationType,
      conversationId,
      userId: rawUserId,
      attachment: rawAttachment,
      attachments: rawAttachments,
      forwardedFromMessageId,
      replyTo: rawReplyTo,
    } = req.body || {};

    const actor = await getVerifiedInternalActor(rawUserId);
    const { userId, role } = actor;
    const rawMessageText = req.body?.body ?? req.body?.content ?? req.body?.text ?? '';
    const normalizedBody = normalizeMessageBody(rawMessageText);
    const trimmedBody = normalizedBody.trim();
    const hasBodyContent = trimmedBody.length > 0;
    const attachment = normalizeInternalAttachment(rawAttachment);
    const hasRawAttachments = Array.isArray(rawAttachments);
    if (hasRawAttachments && rawAttachments.length > MAX_INTERNAL_ATTACHMENT_FILES) {
      return res.status(400).json({ error: `You can send up to ${MAX_INTERNAL_ATTACHMENT_FILES} attachments at once` });
    }

    const attachments = hasRawAttachments
      ? rawAttachments.map((item) => normalizeInternalAttachment(item))
      : [];

    if (hasRawAttachments && attachments.some((item) => !item)) {
      return res.status(400).json({ error: 'Invalid attachment' });
    }

    const normalizedAttachments = normalizeInternalAttachments(attachments);
    const primaryAttachment = normalizedAttachments[0] || attachment || null;
    const hasAttachments = Boolean(primaryAttachment || normalizedAttachments.length > 0);

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    if (!conversationId || (!hasBodyContent && !hasAttachments) || !INTERNAL_TYPES.includes(conversationType)) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const sender = getAgentMeta(userId);
    const replyTo = rawReplyTo && typeof rawReplyTo === 'object'
      ? {
          messageId: String(rawReplyTo.messageId || rawReplyTo.id || '').trim() || null,
          senderName: String(rawReplyTo.senderName || rawReplyTo.senderLabel || '').trim() || '',
          body: String(rawReplyTo.body || '').trim() || '',
        }
      : null;
    const sanitizedReplyTo = replyTo?.messageId
      ? replyTo
      : null;
    const linkPreview = hasAttachments ? null : await fetchLinkPreviewMetadata(normalizedBody);
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
        body: normalizedBody,
        attachment: primaryAttachment,
        attachments: normalizedAttachments,
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
        forwardedFromMessageId: String(forwardedFromMessageId || '').trim() || null,
        replyTo: sanitizedReplyTo,
        linkPreview,
        mentionedUserIds: [],
        mentionedUsernames: [],
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

      if (role !== 'admin' && !teamMembers.includes(userId)) {
        return res.status(403).json({ error: 'Not allowed' });
      }

      const mentionMetadata = await resolveTeamMentionMetadata(trimmedBody, teamMembers);

      payload = {
        from: userId,
        to: team.slug,
        body: normalizedBody,
        attachment: primaryAttachment,
        attachments: normalizedAttachments,
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
        forwardedFromMessageId: String(forwardedFromMessageId || '').trim() || null,
        replyTo: sanitizedReplyTo,
        linkPreview,
        mentionedUserIds: mentionMetadata.mentionedUserIds,
        mentionedUsernames: mentionMetadata.mentionedUsernames,
      };
    }

    const saved = await Message.create(payload);

    const connectedUsers = global.connectedUsers || {};
    const deliveryRecipients = conversationType === 'internal_dm'
      ? [payload.to].filter(Boolean)
      : (payload.participants || []).filter((participantId) => participantId && participantId !== userId);
    const hasConnectedRecipient = deliveryRecipients.some((participantId) => Boolean(connectedUsers[participantId]));

    if (hasConnectedRecipient && ['queued', 'sent'].includes(saved.status)) {
      saved.status = 'delivered';
      await saved.save();
    }

    if (conversationType === 'internal_dm' || conversationType === 'team') {
      await Conversation.findOneAndUpdate(
        { conversationId: saved.conversationId, type: conversationType },
        {
          $set: {
            lastMessageAt: saved.createdAt,
            lastMessagePreview: buildMessagePreview(saved),
          },
        }
      );
    }

    if (global.io) {
      global.io.emit('newMessage', saved);
    }

    if (conversationType === 'team' && Array.isArray(saved.mentionedUserIds)) {
      saved.mentionedUserIds
        .filter((mentionedUserId) => mentionedUserId && mentionedUserId !== userId)
        .forEach((mentionedUserId) => {
          emitSocketEventToUser(mentionedUserId, 'teamMentionNotification', {
            teamId: saved.teamId || saved.conversationId,
            conversationId: saved.conversationId,
            messageId: String(saved._id || ''),
            senderName: saved.senderName || sender.name || userId,
            previewText: buildMentionNotificationPreview(saved.body),
          });
        });
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
    const actor = await getVerifiedInternalActor(req.body?.userId || req.query.userId);
    const { userId, role } = actor;

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    if (!conversationId) {
      return res.status(400).json({ error: 'Missing conversation id' });
    }

    const targetMessages = await Message.find(
      {
        conversationId,
        conversationType: { $in: INTERNAL_TYPES },
        senderId: { $ne: userId },
        readBy: { $ne: userId },
      }
    ).select('_id conversationType status participants');

    if (targetMessages.length === 0) {
      return res.json({ success: true });
    }

    const conversationType = targetMessages[0]?.conversationType || 'internal_dm';
    const canReadConversation = isConversationVisible({
      conversationType,
      participants: targetMessages[0]?.participants || [],
    }, userId, role);

    if (!canReadConversation) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const targetIds = targetMessages.map((message) => message._id);

    await Message.updateMany(
      { _id: { $in: targetIds } },
      {
        $addToSet: { readBy: userId },
        $set: { read: true },
      }
    );

    if (conversationType === 'internal_dm') {
      await Message.updateMany(
        { _id: { $in: targetIds } },
        {
          $set: { status: 'read' },
        }
      );

      emitInternalMessageStatus({
        conversationId,
        conversationType,
        messageIds: targetIds,
        status: 'read',
        userId,
      });
    } else {
      const deliveredIds = targetMessages
        .filter((message) => ['queued', 'sent'].includes(message.status))
        .map((message) => message._id);

      if (deliveredIds.length > 0) {
        await Message.updateMany(
          { _id: { $in: deliveredIds } },
          {
            $set: { status: 'delivered' },
          }
        );

        emitInternalMessageStatus({
          conversationId,
          conversationType,
          messageIds: deliveredIds,
          status: 'delivered',
          userId,
        });
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Internal read error:', error);
    res.status(500).json({ error: 'Failed to mark read' });
  }
};

exports.editMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const access = await resolveInternalMessageAccess({
      messageId,
      rawUserId: req.body?.userId,
      rawRole: req.body?.role,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const { message, isSender, userId } = access;
    const nextBody = normalizeMessageBody(req.body?.body);

    if (!isSender) {
      return res.status(403).json({ error: 'Only the sender can edit this message' });
    }

    if (!nextBody.trim()) {
      return res.status(400).json({ error: 'Message body is required' });
    }

    if (message.isDeleted) {
      return res.status(400).json({ error: 'Deleted messages cannot be edited' });
    }

    if (message.body === nextBody) {
      return res.json(buildFormattedInternalMessage(message, userId));
    }

    if (!message.originalText) {
      message.originalText = message.body || '';
    }

    message.body = nextBody;
    message.linkPreview = message.attachment ? null : await fetchLinkPreviewMetadata(nextBody);
    if (message.conversationType === 'team') {
      const mentionMetadata = await resolveTeamMentionMetadata(nextBody, message.participants || []);
      message.mentionedUserIds = mentionMetadata.mentionedUserIds;
      message.mentionedUsernames = mentionMetadata.mentionedUsernames;
    }
    message.editedAt = new Date();
    await message.save();

    await syncConversationSummary(message.conversationId, message.conversationType);

    const formatted = buildFormattedInternalMessage(message, userId);
    emitInternalMessageMutation('internalMessageUpdated', formatted);

    return res.json(formatted);
  } catch (error) {
    console.error('❌ Internal edit message error:', error);
    return res.status(500).json({ error: 'Failed to edit message' });
  }
};

exports.softDeleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const access = await resolveInternalMessageAccess({
      messageId,
      rawUserId: req.body?.userId || req.query?.userId,
      rawRole: req.body?.role || req.query?.role,
      allowAdminDelete: true,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const { message, isSender, canDeleteAsAdmin, userId } = access;

    if (!isSender && !canDeleteAsAdmin) {
      return res.status(403).json({ error: 'Only the sender can delete this message' });
    }

    if (!message.isDeleted) {
      if (!message.originalText) {
        message.originalText = message.body || '';
      }

      message.isDeleted = true;
      message.deletedAt = new Date();
      message.isPinned = false;
      message.pinnedAt = null;
      message.pinnedBy = null;
      message.reactions = [];
      message.linkPreview = null;
      message.body = '';
      await message.save();
    }

    await syncConversationSummary(message.conversationId, message.conversationType);

    const formatted = buildFormattedInternalMessage(message, userId);
    emitInternalMessageMutation('internalMessageDeleted', formatted);

    return res.json(formatted);
  } catch (error) {
    console.error('❌ Internal delete message error:', error);
    return res.status(500).json({ error: 'Failed to delete message' });
  }
};

exports.togglePinMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const access = await resolveInternalMessageAccess({
      messageId,
      rawUserId: req.body?.userId,
      rawRole: req.body?.role,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const { message, userId } = access;
    const shouldPin = Boolean(req.body?.pinned);

    if (shouldPin) {
      message.isPinned = true;
      message.pinnedAt = new Date();
      message.pinnedBy = userId;
    } else {
      message.isPinned = false;
      message.pinnedAt = null;
      message.pinnedBy = null;
    }

    await message.save();

    const formatted = buildFormattedInternalMessage(message, userId);
    emitInternalMessageMutation('internalMessageUpdated', formatted);

    return res.json(formatted);
  } catch (error) {
    console.error('âŒ Internal pin message error:', error);
    return res.status(500).json({ error: 'Failed to update pinned message' });
  }
};

exports.toggleMessageReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const access = await resolveInternalMessageAccess({
      messageId,
      rawUserId: req.body?.userId,
      rawRole: req.body?.role,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const { message, userId } = access;
    const emoji = String(req.body?.emoji || '').trim();

    if (!ALLOWED_MESSAGE_REACTIONS.includes(emoji)) {
      return res.status(400).json({ error: 'Unsupported reaction' });
    }

    if (message.isDeleted) {
      return res.status(400).json({ error: 'Deleted messages cannot be reacted to' });
    }

    const userRecord = await User.findOne({
      agentId: userId,
      isActive: true,
    }).select('name agentId');

    const fallbackAgent = getAgentMeta(userId);
    const reactionUserName = String(
      userRecord?.name || fallbackAgent?.name || userRecord?.agentId || userId
    ).trim();

    const existingReactions = Array.isArray(message.reactions) ? message.reactions : [];
    const nextReactions = existingReactions.filter((reaction) => reaction?.userId !== userId);
    const existingReaction = existingReactions.find((reaction) => reaction?.userId === userId);

    if (!existingReaction || existingReaction.emoji !== emoji) {
      nextReactions.push({
        emoji,
        userId,
        userName: reactionUserName,
        createdAt: new Date(),
      });
    }

    message.reactions = nextReactions;
    await message.save();

    const formatted = buildFormattedInternalMessage(message, userId);
    emitInternalMessageMutation('internalMessageUpdated', formatted);

    return res.json(formatted);
  } catch (error) {
    console.error('❌ Internal reaction update error:', error);
    return res.status(500).json({ error: 'Failed to update reaction' });
  }
};

exports.getConversationNotes = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const access = await resolveInternalConversationAccess({
      conversationId,
      conversationType: req.query?.conversationType,
      rawUserId: req.query?.userId,
      rawRole: req.query?.role,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const notes = await ConversationNote.find({
      conversationId: access.conversationId,
      conversationType: access.conversationType,
    }).sort({ updatedAt: -1, createdAt: -1 });

    return res.json({
      notes: notes.map((note) => buildConversationNotePayload(note)),
    });
  } catch (error) {
    console.error('Conversation notes fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch notes' });
  }
};

exports.createConversationNote = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const access = await resolveInternalConversationAccess({
      conversationId,
      conversationType: req.body?.conversationType,
      rawUserId: req.body?.userId,
      rawRole: req.body?.role,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ error: 'Note body is required' });
    }

    const userRecord = await User.findOne({
      agentId: access.userId,
      isActive: true,
    }).select('name agentId');
    const fallbackAgent = getAgentMeta(access.userId);
    const authorName = String(
      userRecord?.name || fallbackAgent?.name || userRecord?.agentId || access.userId
    ).trim();

    const note = await ConversationNote.create({
      conversationId: access.conversationId,
      conversationType: access.conversationType,
      authorId: access.userId,
      authorName,
      body,
    });

    const payload = {
      conversationId: access.conversationId,
      conversationType: access.conversationType,
      note: buildConversationNotePayload(note),
    };

    emitConversationNoteEvent({
      participants: access.participants,
      eventName: 'conversationNoteCreated',
      payload,
    });

    return res.status(201).json(payload);
  } catch (error) {
    console.error('Conversation note create error:', error);
    return res.status(500).json({ error: 'Failed to create note' });
  }
};

exports.updateConversationNote = async (req, res) => {
  try {
    const { noteId } = req.params;
    const note = await ConversationNote.findById(noteId);

    if (!note) {
      return res.status(404).json({ error: 'Note not found' });
    }

    const access = await resolveInternalConversationAccess({
      conversationId: note.conversationId,
      conversationType: note.conversationType,
      rawUserId: req.body?.userId,
      rawRole: req.body?.role,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const canManage = access.role === 'admin' || String(note.authorId || '') === access.userId;
    if (!canManage) {
      return res.status(403).json({ error: 'Only the note author can edit this note' });
    }

    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ error: 'Note body is required' });
    }

    note.body = body;
    await note.save();

    const payload = {
      conversationId: note.conversationId,
      conversationType: note.conversationType,
      note: buildConversationNotePayload(note),
    };

    emitConversationNoteEvent({
      participants: access.participants,
      eventName: 'conversationNoteUpdated',
      payload,
    });

    return res.json(payload);
  } catch (error) {
    console.error('Conversation note update error:', error);
    return res.status(500).json({ error: 'Failed to update note' });
  }
};

exports.deleteConversationNote = async (req, res) => {
  try {
    const { noteId } = req.params;
    const note = await ConversationNote.findById(noteId);

    if (!note) {
      return res.status(404).json({ error: 'Note not found' });
    }

    const access = await resolveInternalConversationAccess({
      conversationId: note.conversationId,
      conversationType: note.conversationType,
      rawUserId: req.body?.userId || req.query?.userId,
      rawRole: req.body?.role || req.query?.role,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const canManage = access.role === 'admin' || String(note.authorId || '') === access.userId;
    if (!canManage) {
      return res.status(403).json({ error: 'Only the note author can delete this note' });
    }

    const deletedNoteId = String(note._id || '');
    await note.deleteOne();

    const payload = {
      conversationId: note.conversationId,
      conversationType: note.conversationType,
      noteId: deletedNoteId,
    };

    emitConversationNoteEvent({
      participants: access.participants,
      eventName: 'conversationNoteDeleted',
      payload,
    });

    return res.json(payload);
  } catch (error) {
    console.error('Conversation note delete error:', error);
    return res.status(500).json({ error: 'Failed to delete note' });
  }
};

exports.getMessageThreadComments = async (req, res) => {
  try {
    const { messageId } = req.params;
    const access = await resolveInternalMessageAccess({
      messageId,
      rawUserId: req.query?.userId,
      rawRole: req.query?.role,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const { message, userId } = access;
    const comments = await MessageThreadComment.find({
      parentMessageId: String(message._id || ''),
    }).sort({ createdAt: 1 });

    const syncedMessage = await syncMessageCommentCount(message._id) || message;
    const readState = message.conversationType === 'internal_dm'
      ? await MessageThreadReadState.findOne({
          parentMessageId: String(message._id || ''),
          userId,
        }).lean()
      : null;
    const rootMessage = buildFormattedInternalMessage(syncedMessage, userId, readState);

    return res.json({
      rootMessage,
      commentCount: Number(rootMessage.commentCount || comments.length || 0),
      readState,
      comments: comments.map((comment) => buildThreadCommentPayload(comment)),
    });
  } catch (error) {
    console.error('❌ Message thread fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch threaded comments' });
  }
};

exports.markMessageThreadCommentsRead = async (req, res) => {
  try {
    const { messageId } = req.params;
    const access = await resolveInternalMessageAccess({
      messageId,
      rawUserId: req.body?.userId || req.query?.userId,
      rawRole: req.body?.role || req.query?.role,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const { message, userId } = access;

    if (message.conversationType !== 'internal_dm') {
      return res.status(400).json({ error: 'Thread read state is available for personal chats only' });
    }

    const latestComment = await MessageThreadComment.findOne({
      parentMessageId: String(message._id || ''),
    }).sort({ createdAt: -1 });

    const readState = await MessageThreadReadState.findOneAndUpdate(
      {
        parentMessageId: String(message._id || ''),
        userId,
      },
      {
        $set: {
          clientAccountId: message.clientAccountId || null,
          parentMessageId: String(message._id || ''),
          conversationId: message.conversationId,
          conversationType: message.conversationType,
          userId,
          lastSeenCommentId: latestComment ? String(latestComment._id || '') : '',
          lastSeenCommentAt: latestComment?.createdAt || null,
          lastOpenedAt: new Date(),
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    return res.json({
      success: true,
      readState,
      rootMessage: buildFormattedInternalMessage(message, userId, readState),
    });
  } catch (error) {
    console.error('❌ Message thread read state error:', error);
    return res.status(500).json({ error: 'Failed to mark threaded comments read' });
  }
};

exports.createMessageThreadComment = async (req, res) => {
  try {
    const { messageId } = req.params;
    const access = await resolveInternalMessageAccess({
      messageId,
      rawUserId: req.body?.userId,
      rawRole: req.body?.role,
    });

    if (access.error) {
      return res.status(access.error.status).json(access.error.body);
    }

    const { message, userId } = access;
    const body = String(req.body?.body || '').trim();

    if (!body) {
      return res.status(400).json({ error: 'Comment body is required' });
    }

    if (message.isDeleted) {
      return res.status(400).json({ error: 'Deleted messages cannot receive comments' });
    }

    const userRecord = await User.findOne({
      agentId: userId,
      isActive: true,
    }).select('name agentId');
    const fallbackAgent = getAgentMeta(userId);
    const senderName = String(
      userRecord?.name || fallbackAgent?.name || userRecord?.agentId || userId
    ).trim();

    const savedComment = await MessageThreadComment.create({
      parentMessageId: String(message._id || ''),
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      participants: message.participants || [],
      teamId: message.teamId || null,
      teamName: message.teamName || null,
      senderId: userId,
      senderName,
      body,
    });

    const updatedParentMessage = await syncMessageCommentCount(message._id, savedComment);
    const formattedParentMessage = updatedParentMessage
      ? buildFormattedInternalMessage(updatedParentMessage, userId)
      : buildFormattedInternalMessage(message, userId);
    const commentPayload = buildThreadCommentPayload(savedComment);

    emitInternalMessageMutation('internalMessageUpdated', formattedParentMessage);

    if (global.io) {
      global.io.emit('messageThreadCommentCreated', {
        parentMessageId: String(message._id || ''),
        conversationId: message.conversationId,
        conversationType: message.conversationType,
        commentCount: Number(formattedParentMessage.commentCount || 0),
        comment: commentPayload,
      });
    }

    return res.status(201).json({
      rootMessage: formattedParentMessage,
      commentCount: Number(formattedParentMessage.commentCount || 0),
      comment: commentPayload,
    });
  } catch (error) {
    console.error('❌ Message thread create error:', error);
    return res.status(500).json({ error: 'Failed to create threaded comment' });
  }
};
