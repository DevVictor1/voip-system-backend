const Message = require('../models/Message');
const Contact = require('../models/Contact');
const User = require('../models/User');
const TextingGroup = require('../models/TextingGroup');
const ClientPhoneNumber = require('../models/ClientPhoneNumber');
const twilio = require('twilio');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { getUserRole, isPlatformAdmin } = require('../utils/accessControl');
const { getClientAccountIdString, resolveUserPrimaryClientAccount } = require('../utils/clientOwnership');
const {
  incrementAgentWorkload,
  normalizeAgentId,
  syncLifecycleWorkload,
} = require('../utils/agentWorkload');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const SMS_SEND_DEBUG_ENABLED = String(process.env.SMS_SEND_DEBUG || 'true').trim().toLowerCase() !== 'false';

const logSmsSendDebug = (stage, payload = {}) => {
  if (!SMS_SEND_DEBUG_ENABLED) return;

  console.log('[TEMP sms:send-debug]', stage, payload);
};

const formatToE164 = (input) => {
  try {
    if (!input) return null;

    let phoneNumber = parsePhoneNumberFromString(input);

    if (!phoneNumber) {
      phoneNumber = parsePhoneNumberFromString(input, 'NG');
    }

    if (phoneNumber && phoneNumber.isValid()) {
      return phoneNumber.format('E.164');
    }

    return null;
  } catch (err) {
    console.error('PHONE FORMAT ERROR:', err.message);
    return null;
  }
};

const normalize = (num) => {
  if (!num) return '';
  return num.replace(/\D/g, '').slice(-10);
};

const getSmsUserIdentity = (user) => String(user?.agentId || user?._id || '').trim();

const ensureAbsoluteHttpsUrl = (value) => {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const BASE_CUSTOMER_MESSAGE_QUERY = {
  $or: [
    { conversationType: { $exists: false } },
    { conversationType: 'customer' },
  ],
};

const DIRECT_CUSTOMER_MESSAGE_QUERY = {
  $and: [
    BASE_CUSTOMER_MESSAGE_QUERY,
    {
      $or: [
        { textingGroupId: { $exists: false } },
        { textingGroupId: null },
        { textingGroupId: '' },
      ],
    },
  ],
};

const findContactByPhone = async (phone, clientAccountId = null) => {
  const normalized = normalize(phone);
  const scopedClientAccountId = getClientAccountIdString(clientAccountId);

  if (scopedClientAccountId) {
    const contacts = await Contact.find({
      'phones.number': normalized,
      $or: [
        { clientAccountId: scopedClientAccountId },
        { clientAccountId: null },
        { clientAccountId: { $exists: false } },
      ],
    }).sort({ updatedAt: -1, createdAt: -1 });

    return contacts.find((contact) => getClientAccountIdString(contact.clientAccountId) === scopedClientAccountId)
      || contacts[0]
      || null;
  }

  return Contact.findOne({
    'phones.number': normalized,
    $or: [
      { clientAccountId: null },
      { clientAccountId: { $exists: false } },
    ],
  });
};

const attachClientAccountToContactIfMissing = async (contact, clientAccountId) => {
  const resolvedClientAccountId = getClientAccountIdString(clientAccountId);
  if (!contact?._id || !resolvedClientAccountId || contact.clientAccountId) {
    return contact;
  }

  contact.clientAccountId = resolvedClientAccountId;
  return contact.save();
};

const normalizeAssignedNumber = (value) => normalize(value || '');

const stripPhoneFormatting = (value) => String(value || '').replace(/[^\d+]/g, '').trim();

const doPhoneNumbersMatch = (left, right) => {
  const leftNormalized = normalizeAssignedNumber(left);
  const rightNormalized = normalizeAssignedNumber(right);

  if (leftNormalized && rightNormalized && leftNormalized === rightNormalized) {
    return true;
  }

  const leftE164 = formatToE164(left);
  const rightE164 = formatToE164(right);

  if (leftE164 && rightE164 && leftE164 === rightE164) {
    return true;
  }

  const leftStripped = stripPhoneFormatting(left);
  const rightStripped = stripPhoneFormatting(right);

  return Boolean(leftStripped && rightStripped && leftStripped === rightStripped);
};

const findTextingGroupBySlug = async (groupId, clientAccountId = null) => {
  if (!groupId) return null;

  return TextingGroup.findOne({
    slug: String(groupId).trim().toLowerCase(),
    isActive: true,
    ...(clientAccountId ? { clientAccountId } : {}),
  });
};

const findTextingGroupByAssignedNumber = async (phoneNumber, clientAccountId = null) => {
  const normalized = normalizeAssignedNumber(phoneNumber);
  if (!normalized) return null;

  const activeGroups = await TextingGroup.find({
    isActive: true,
    assignedNumber: { $type: 'string', $ne: '' },
    ...(clientAccountId ? { clientAccountId } : {}),
  });

  return activeGroups.find((group) => doPhoneNumbersMatch(group.assignedNumber, phoneNumber)) || null;
};

const findClientNumberByPhone = async (phoneNumber) => {
  const normalizedPhone = normalizeAssignedNumber(phoneNumber);
  if (!normalizedPhone) return null;

  const activeNumbers = await ClientPhoneNumber.find({
    status: 'active',
    archivedAt: null,
    phoneNumber: { $type: 'string', $ne: '' },
  }).select('phoneNumber clientAccountId assignedUserId capabilities status archivedAt');

  return activeNumbers.find((numberRecord) => doPhoneNumbersMatch(numberRecord.phoneNumber, phoneNumber)) || null;
};

const getUserClientAccountId = async (req) => {
  const contextClientId = getClientAccountIdString(req.accountContext?.selectedClientAccountId)
    || getClientAccountIdString(req.accountContext?.primaryClientAccountId);
  if (contextClientId) return contextClientId;

  return getClientAccountIdString(await resolveUserPrimaryClientAccount(req.user));
};

const isLegacyGlobalSmsUser = async (req) => {
  if (isPlatformAdmin(req.user)) return true;

  const role = getUserRole(req.user);
  if (role !== 'agent') return false;

  const clientAccountId = await getUserClientAccountId(req);
  return !clientAccountId;
};

const buildSmsClientScopeQuery = async (req) => {
  if (isPlatformAdmin(req.user)) {
    return {};
  }

  const clientAccountId = await getUserClientAccountId(req);
  if (clientAccountId) {
    return { clientAccountId };
  }

  return {
    $or: [
      { clientAccountId: null },
      { clientAccountId: { $exists: false } },
    ],
  };
};

const isSmsCapabilityAllowed = (numberRecord, requiresMms = false) => {
  if (!numberRecord || String(numberRecord.status || '').toLowerCase() !== 'active') return false;
  if (requiresMms) return Boolean(numberRecord.capabilities?.mms);
  return Boolean(numberRecord.capabilities?.sms);
};

const canUseClientSmsNumber = async (req, numberRecord, requiresMms = false) => {
  if (!isSmsCapabilityAllowed(numberRecord, requiresMms)) return false;
  if (isPlatformAdmin(req.user)) return true;

  const userClientAccountId = await getUserClientAccountId(req);
  const numberClientAccountId = getClientAccountIdString(numberRecord.clientAccountId);
  if (userClientAccountId && numberClientAccountId && userClientAccountId === numberClientAccountId) {
    return true;
  }

  const assignedUserId = getClientAccountIdString(numberRecord.assignedUserId);
  return Boolean(assignedUserId && assignedUserId === getClientAccountIdString(req.user?._id));
};

const listAllowedClientSmsNumbers = async (req, requiresMms = false) => {
  const clientAccountId = await getUserClientAccountId(req);
  if (!clientAccountId && !isPlatformAdmin(req.user)) return [];

  const query = {
    status: 'active',
    archivedAt: null,
    phoneNumber: { $type: 'string', $ne: '' },
    ...(requiresMms ? { 'capabilities.mms': true } : { 'capabilities.sms': true }),
    ...(isPlatformAdmin(req.user) || !clientAccountId ? {} : { clientAccountId }),
  };

  const numbers = await ClientPhoneNumber.find(query)
    .select('phoneNumber clientAccountId assignedUserId capabilities status archivedAt')
    .sort({ updatedAt: -1, createdAt: -1 });

  const allowed = [];
  for (const numberRecord of numbers) {
    if (await canUseClientSmsNumber(req, numberRecord, requiresMms)) {
      allowed.push(numberRecord);
    }
  }

  return allowed;
};

const resolveOutboundSmsSender = async ({ req, requestedFrom = '', textingGroup = null, requiresMms = false }) => {
  const defaultNumber = String(process.env.TWILIO_PHONE_NUMBER || '').trim();
  const requestedNumber = String(requestedFrom || '').trim();
  const groupNumber = String(textingGroup?.assignedNumber || '').trim();

  if (groupNumber) {
    const clientNumber = await findClientNumberByPhone(groupNumber);
    if (clientNumber) {
      const allowed = await canUseClientSmsNumber(req, clientNumber, requiresMms);
      if (!allowed) {
        return { error: requiresMms ? 'MMS is not enabled for this texting group number' : 'SMS is not enabled for this texting group number' };
      }

      return {
        phoneNumber: clientNumber.phoneNumber,
        clientAccountId: clientNumber.clientAccountId,
        source: 'texting_group_client_number',
      };
    }

    if (textingGroup.clientAccountId && !(await isLegacyGlobalSmsUser(req))) {
      return { error: 'Texting group number is not available for SMS/MMS sending' };
    }

    if (groupNumber) {
      return {
        phoneNumber: groupNumber,
        clientAccountId: textingGroup.clientAccountId || null,
        source: 'texting_group_legacy_number',
      };
    }
  }

  if (requestedNumber) {
    const clientNumber = await findClientNumberByPhone(requestedNumber);
    if (!clientNumber) {
      return { error: 'Selected sender number is not available' };
    }

    const allowed = await canUseClientSmsNumber(req, clientNumber, requiresMms);
    if (!allowed) {
      return { error: 'Selected sender number is not allowed for this user' };
    }

    return {
      phoneNumber: clientNumber.phoneNumber,
      clientAccountId: clientNumber.clientAccountId,
      source: 'client_number',
    };
  }

  const allowedClientNumbers = await listAllowedClientSmsNumbers(req, requiresMms);
  if (allowedClientNumbers.length > 0) {
    return {
      phoneNumber: allowedClientNumbers[0].phoneNumber,
      clientAccountId: allowedClientNumbers[0].clientAccountId,
      source: 'client_number_default',
    };
  }

  if (defaultNumber && await isLegacyGlobalSmsUser(req)) {
    return {
      phoneNumber: defaultNumber,
      clientAccountId: null,
      source: 'legacy_default',
    };
  }

  return {
    error: requiresMms
      ? 'No authorized MMS sender number is available'
      : 'No authorized SMS sender number is available',
  };
};

const getTextingGroupAccessQuery = (userId, role, clientAccountId = null) => {
  if (role === 'admin' || role === 'platform_admin') {
    return {
      isActive: true,
      ...(clientAccountId ? { clientAccountId } : {}),
    };
  }

  return {
    isActive: true,
    members: userId,
    ...(clientAccountId ? { clientAccountId } : {}),
  };
};

const resolveTextingGroup = async ({ contact, assignedNumber, clientAccountId = null }) => {
  const contactGroupId = String(contact?.textingGroupId || '').trim().toLowerCase();

  if (contactGroupId) {
    const matchedGroup = await findTextingGroupBySlug(contactGroupId, clientAccountId);
    if (matchedGroup) {
      return matchedGroup;
    }
  }

  return findTextingGroupByAssignedNumber(assignedNumber, clientAccountId);
};

const getCounterpartPhoneForMessage = (message) => {
  if (!message) return '';
  const isOutgoing = message.direction === 'outbound';
  return normalize(isOutgoing ? message.to : message.from);
};

const getTextingGroupThreadQuery = (groupId, phone, clientScopeQuery = {}) => {
  const normalizedPhone = normalize(phone);

  return {
    $and: [
      BASE_CUSTOMER_MESSAGE_QUERY,
      clientScopeQuery,
      { textingGroupId: String(groupId || '').trim().toLowerCase() },
      {
        $or: [
          { from: normalizedPhone },
          { to: normalizedPhone },
          { conversationId: normalizedPhone },
        ],
      },
    ],
  };
};

const getTextingGroupContactPayload = (contact, group) => {
  if (!contact || !group) return null;

  contact.textingGroupId = group.slug;
  contact.textingGroupName = group.name;
  return contact.save();
};

const findOrCreateContactByPhone = async (phone, clientAccountId = null) => {
  const normalized = normalize(phone);

  if (!normalized) {
    return null;
  }

  const existingContact = await findContactByPhone(normalized, clientAccountId);
  if (existingContact) {
    return attachClientAccountToContactIfMissing(existingContact, clientAccountId);
  }

  const createdContact = await Contact.create({
    clientAccountId: getClientAccountIdString(clientAccountId) || null,
    firstName: '',
    lastName: '',
    phones: [
      {
        label: 'mobile',
        number: normalized,
      },
    ],
    assignedTo: null,
    isUnassigned: true,
    assignmentStatus: 'open',
  });

  console.log('[sms:contact] Created new contact for inbound number', normalized);
  return createdContact;
};

const AUTO_ASSIGNABLE_USER_QUERY = {
  agentId: { $type: 'string', $ne: '' },
  isActive: true,
  isAssignable: true,
  status: 'available',
  $expr: {
    $lt: [
      { $ifNull: ['$currentActiveChats', 0] },
      { $ifNull: ['$maxActiveChats', 5] },
    ],
  },
};

const hasAssignedAgent = (contact) => Boolean(normalizeAgentId(contact?.assignedTo));
const isReopenableAssignmentStatus = (status) => ['resolved', 'closed'].includes(
  String(status || '').trim().toLowerCase()
);

const findLeastLoadedAssignableAgent = async () => {
  return User.findOne(AUTO_ASSIGNABLE_USER_QUERY)
    .select('agentId name currentActiveChats maxActiveChats')
    .sort({ currentActiveChats: 1, createdAt: 1, name: 1 });
};

const tryAutoAssignContact = async (contact) => {
  if (!contact?._id || hasAssignedAgent(contact)) {
    return null;
  }

  const selectedAgent = await findLeastLoadedAssignableAgent();

  if (!selectedAgent?.agentId) {
    console.log('[sms:auto-assign] No eligible agent available for contact', String(contact._id));
    return null;
  }

  const assignedContact = await Contact.findOneAndUpdate(
    {
      _id: contact._id,
      $or: [
        { assignedTo: null },
        { assignedTo: '' },
        { assignedTo: { $exists: false } },
      ],
    },
    {
      $set: {
        assignedTo: selectedAgent.agentId,
        isUnassigned: false,
      },
    },
    {
      returnDocument: 'after',
    }
  );

  if (!assignedContact) {
    return null;
  }

  const updatedAgent = await incrementAgentWorkload(selectedAgent.agentId, { respectCapacity: true });

  console.log(
    '[sms:auto-assign] Assigned contact',
    String(contact._id),
    'to',
    selectedAgent.agentId,
    updatedAgent
      ? `(workload ${updatedAgent.currentActiveChats}/${updatedAgent.maxActiveChats})`
      : '(workload increment skipped)'
  );

  return assignedContact;
};

const tryReopenContact = async (contact) => {
  const previousStatus = String(contact?.assignmentStatus || 'open').trim().toLowerCase();

  if (!contact?._id || !isReopenableAssignmentStatus(previousStatus)) {
    return null;
  }

  const reopenedContact = await Contact.findOneAndUpdate(
    {
      _id: contact._id,
      assignmentStatus: previousStatus,
    },
    {
      $set: {
        assignmentStatus: 'open',
      },
    },
    {
      returnDocument: 'after',
    }
  );

  if (!reopenedContact) {
    return null;
  }

  const workload = await syncLifecycleWorkload(
    reopenedContact.assignedTo,
    previousStatus,
    'open'
  );

  console.log(
    '[sms:auto-reopen] Reopened contact',
    String(contact._id),
    reopenedContact.assignedTo
      ? `for ${reopenedContact.assignedTo}${workload.incremented ? ` (workload ${workload.incremented.currentActiveChats}/${workload.incremented.maxActiveChats})` : ' (workload unchanged)'}`
      : 'without assigned agent'
  );

  return reopenedContact;
};

exports.receiveSMS = async (req, res) => {
  try {
    const { From, To, Body } = req.body;
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const media = [];

    if (numMedia > 0) {
      for (let i = 0; i < numMedia; i += 1) {
        media.push(req.body[`MediaUrl${i}`]);
      }
    }

    console.log('Incoming SMS:', From, Body);

    const inboundClientNumber = await findClientNumberByPhone(To);
    const inboundClientAccountId = inboundClientNumber?.clientAccountId || null;
    let contact = await findOrCreateContactByPhone(From, inboundClientAccountId);
    const textingGroup = await resolveTextingGroup({
      contact,
      assignedNumber: To,
      clientAccountId: inboundClientAccountId,
    });

    if (contact) {
      contact = await tryReopenContact(contact) || contact;
    }

    if (contact && textingGroup) {
      contact = await getTextingGroupContactPayload(contact, textingGroup) || contact;
    }

    if (contact && !hasAssignedAgent(contact)) {
      await tryAutoAssignContact(contact);
    }

    const message = await Message.create({
      clientAccountId: inboundClientAccountId || textingGroup?.clientAccountId || null,
      from: normalize(From),
      to: normalize(To),
      fromFull: From,
      toFull: To,
      body: Body,
      media,
      direction: 'inbound',
      conversationType: 'customer',
      conversationId: normalize(From),
      textingGroupId: textingGroup?.slug || null,
      textingGroupName: textingGroup?.name || null,
      source: 'sms',
      read: false,
      readBy: [],
      status: 'received',
    });

    if (global.io) {
      global.io.emit('newMessage', message);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('RECEIVE ERROR:', error);
    res.sendStatus(500);
  }
};

exports.sendSMS = async (req, res) => {
  try {
    const { to, body, message, mediaUrl, textingGroupId } = req.body;
    const authenticatedUserId = getSmsUserIdentity(req.user);
    const authenticatedSenderName = req.user?.name || req.user?.email || authenticatedUserId;
    const authenticatedRole = getUserRole(req.user);
    const text = body || message;

    if (!to || (!text && !mediaUrl)) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const normalizedTo = normalize(to);
    const formattedTo = formatToE164(to);
    const requestContext = textingGroupId ? 'texting-group' : 'direct';
    const mediaList = mediaUrl
      ? (Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl])
      : undefined;
    const requiresMms = Array.isArray(mediaList) && mediaList.length > 0;

    logSmsSendDebug('request-received', {
      context: requestContext,
      originalTo: to,
      normalizedTo,
      formattedTo,
      originalFrom: req.body?.from || req.body?.fromNumber || req.body?.senderNumber || '',
      textingGroupId: textingGroupId || null,
      hasTextingGroupContext: Boolean(textingGroupId),
      senderName: authenticatedSenderName || null,
      userId: authenticatedUserId || null,
      role: authenticatedRole || null,
      hasMedia: requiresMms,
      bodyLength: String(text || '').length,
      bodyPreview: String(text || '').slice(0, 80),
    });

    if (!formattedTo) {
      logSmsSendDebug('request-rejected-invalid-number', {
        context: requestContext,
        originalTo: to,
        normalizedTo,
        formattedTo,
      });
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    const textingGroup = textingGroupId
      ? await findTextingGroupBySlug(textingGroupId)
      : null;

    if (textingGroupId && !textingGroup) {
      return res.status(404).json({ error: 'Texting group not found' });
    }

    if (textingGroup) {
      const canUseGroup = textingGroup.members.includes(String(authenticatedUserId)) || isPlatformAdmin(req.user);
      if (!canUseGroup) {
        return res.status(403).json({ error: 'You are not a member of this texting group' });
      }
    }

    console.log('Sending SMS to:', formattedTo);

    const senderResolution = await resolveOutboundSmsSender({
      req,
      requestedFrom: req.body?.from || req.body?.fromNumber || req.body?.senderNumber,
      textingGroup,
      requiresMms,
    });

    if (senderResolution.error) {
      return res.status(403).json({ error: senderResolution.error });
    }

    const payload = {
      body: text,
      from: senderResolution.phoneNumber,
      to: formattedTo,
      mediaUrl: mediaList,
    };

    logSmsSendDebug('twilio-payload', {
      context: requestContext,
      originalTo: to,
      normalizedTo,
      formattedTo,
      from: payload.from,
      fromSource: senderResolution.source,
      textingGroupId: textingGroup?.slug || null,
      textingGroupName: textingGroup?.name || null,
      mediaCount: mediaList?.length || 0,
    });

    const baseUrl = ensureAbsoluteHttpsUrl(process.env.BASE_URL);
    if (baseUrl) {
      payload.statusCallback = `${baseUrl}/api/sms/status`;
    }

    const twilioRes = await client.messages.create(payload);

    logSmsSendDebug('twilio-response', {
      context: requestContext,
      originalTo: to,
      normalizedTo,
      formattedTo,
      from: payload.from,
      sid: twilioRes.sid,
      status: twilioRes.status || null,
      errorCode: twilioRes.errorCode || null,
      errorMessage: twilioRes.errorMessage || null,
    });

    const contact = await findOrCreateContactByPhone(normalizedTo, senderResolution.clientAccountId);
    if (contact && textingGroup) {
      await getTextingGroupContactPayload(contact, textingGroup);
    }

    const saved = await Message.create({
      clientAccountId: senderResolution.clientAccountId || textingGroup?.clientAccountId || null,
      sid: twilioRes.sid,
      from: normalize(senderResolution.phoneNumber),
      to: normalizedTo,
      fromFull: senderResolution.phoneNumber,
      toFull: to,
      body: text,
      media: mediaList || [],
      direction: 'outbound',
      conversationType: 'customer',
      conversationId: normalizedTo,
      textingGroupId: textingGroup?.slug || null,
      textingGroupName: textingGroup?.name || null,
      senderId: authenticatedUserId || null,
      senderName: authenticatedSenderName || null,
      source: 'sms',
      status: twilioRes.status || 'queued',
      read: true,
      readBy: authenticatedUserId ? [String(authenticatedUserId)] : [],
    });

    if (global.io) {
      global.io.emit('newMessage', saved);
    }

    logSmsSendDebug('message-saved', {
      context: requestContext,
      sid: saved.sid || null,
      conversationId: saved.conversationId,
      textingGroupId: saved.textingGroupId || null,
      textingGroupName: saved.textingGroupName || null,
      storedTo: saved.to,
      storedToFull: saved.toFull,
      storedFrom: saved.from,
      storedFromFull: saved.fromFull,
      storedStatus: saved.status,
    });

    res.json(saved);
  } catch (error) {
    logSmsSendDebug('send-error', {
      originalTo: req.body?.to || null,
      textingGroupId: req.body?.textingGroupId || null,
      errorMessage: error?.message || String(error),
      errorCode: error?.code || null,
      twilioCode: error?.status || error?.errorCode || null,
    });
    console.error('SEND ERROR:', error);
    res.status(500).json({ error: 'Send failed' });
  }
};

exports.smsStatusCallback = async (req, res) => {
  try {
    const { MessageSid, MessageStatus } = req.body;

    await Message.findOneAndUpdate(
      { sid: MessageSid },
      { status: MessageStatus }
    );

    if (global.io) {
      global.io.emit('messageStatus', {
        sid: MessageSid,
        status: MessageStatus,
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('STATUS ERROR:', err);
    res.sendStatus(500);
  }
};

exports.getConversations = async (req, res) => {
  try {
    const clientScopeQuery = await buildSmsClientScopeQuery(req);
    const messages = await Message.find({
      $and: [
        DIRECT_CUSTOMER_MESSAGE_QUERY,
        clientScopeQuery,
      ],
    }).sort({ createdAt: -1 });
    const conversations = {};

    for (const msg of messages) {
      const phone = getCounterpartPhoneForMessage(msg);
      const key = normalize(msg.conversationId || phone);

        if (!conversations[key]) {
          const contact = await findContactByPhone(key, msg.clientAccountId);

          conversations[key] = {
            _id: contact?._id || null,
            phone: key,
            name: contact
              ? `${contact.firstName} ${contact.lastName}`.trim()
              : key,
            lastMessage: msg.body,
            updatedAt: msg.createdAt,
            unread: 0,
            assignedTo: contact?.assignedTo || null,
            isUnassigned: typeof contact?.isUnassigned === 'boolean'
              ? contact.isUnassigned
              : !contact?.assignedTo,
            assignmentStatus: contact?.assignmentStatus || 'open',
          };
        }

      if (!msg.read && msg.direction === 'inbound') {
        conversations[key].unread += 1;
      }
    }

    res.json(Object.values(conversations));
  } catch (error) {
    console.error('Conversations error:', error);
    res.status(500).json({ error: 'Failed' });
  }
};

exports.getTextingGroups = async (req, res) => {
  try {
    const userId = getSmsUserIdentity(req.user);
    const role = getUserRole(req.user);
    const clientAccountId = await getUserClientAccountId(req);
    const clientScopeQuery = await buildSmsClientScopeQuery(req);

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    const groups = await TextingGroup.find(getTextingGroupAccessQuery(userId, role, clientAccountId))
      .sort({ updatedAt: -1, name: 1 });

    const groupIds = groups.map((group) => group.slug);
    const messages = groupIds.length > 0
      ? await Message.find({
          $and: [
            BASE_CUSTOMER_MESSAGE_QUERY,
            clientScopeQuery,
            { textingGroupId: { $in: groupIds } },
          ],
        }).sort({ createdAt: -1 })
      : [];

    const summaries = groups.map((group) => {
      const relatedMessages = messages.filter((message) => message.textingGroupId === group.slug);
      const latestMessage = relatedMessages[0] || null;
      const unreadCount = relatedMessages.reduce((count, message) => {
        if (message.direction !== 'inbound') return count;
        if ((message.readBy || []).includes(userId)) return count;
        return count + 1;
      }, 0);

      return {
        id: group.slug,
        groupId: group.slug,
        name: group.name,
        assignedNumber: group.assignedNumber || '',
        members: group.members || [],
        memberCount: (group.members || []).length,
        unread: unreadCount,
        lastMessage: latestMessage?.body || '',
        updatedAt: latestMessage?.createdAt || group.updatedAt,
      };
    });

    res.json(summaries);
  } catch (error) {
    console.error('Texting groups error:', error);
    res.status(500).json({ error: 'Failed to load texting groups' });
  }
};

exports.getTextingGroupConversations = async (req, res) => {
  try {
    const userId = getSmsUserIdentity(req.user);
    const role = getUserRole(req.user);
    const clientAccountId = await getUserClientAccountId(req);
    const clientScopeQuery = await buildSmsClientScopeQuery(req);
    const groupId = String(req.params?.groupId || '').trim().toLowerCase();

    if (!userId || !groupId) {
      return res.status(400).json({ error: 'Missing group access data' });
    }

    const group = await TextingGroup.findOne({
      slug: groupId,
      ...getTextingGroupAccessQuery(userId, role, clientAccountId),
    });

    if (!group) {
      return res.status(404).json({ error: 'Texting group not found' });
    }

    const messages = await Message.find({
      $and: [
        BASE_CUSTOMER_MESSAGE_QUERY,
        clientScopeQuery,
        { textingGroupId: group.slug },
      ],
    }).sort({ createdAt: -1 });

    const conversations = {};

    for (const msg of messages) {
      const phone = getCounterpartPhoneForMessage(msg);
      if (!phone) continue;

      if (!conversations[phone]) {
        const contact = await findContactByPhone(phone, msg.clientAccountId);
        const fullName = contact
          ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim()
          : '';

        conversations[phone] = {
          _id: contact?._id || null,
          phone,
          name: fullName || contact?.name || phone,
          dba: contact?.dba || '',
          mid: contact?.mid || '',
          lastMessage: msg.body || '',
          lastMessageSenderName: msg.direction === 'outbound' ? (msg.senderName || '') : '',
          updatedAt: msg.createdAt,
          unread: 0,
          assignedTo: contact?.assignedTo || null,
          isUnassigned: typeof contact?.isUnassigned === 'boolean'
            ? contact.isUnassigned
            : !contact?.assignedTo,
          assignmentStatus: contact?.assignmentStatus || 'open',
          textingGroupId: group.slug,
          textingGroupName: group.name,
          assignedNumber: group.assignedNumber || '',
        };
      }

      if (msg.direction === 'inbound' && !(msg.readBy || []).includes(userId)) {
        conversations[phone].unread += 1;
      }
    }

    res.json(Object.values(conversations));
  } catch (error) {
    console.error('Texting group conversations error:', error);
    res.status(500).json({ error: 'Failed to load texting group conversations' });
  }
};

exports.getTextingGroupMessages = async (req, res) => {
  try {
    const userId = getSmsUserIdentity(req.user);
    const role = getUserRole(req.user);
    const clientAccountId = await getUserClientAccountId(req);
    const clientScopeQuery = await buildSmsClientScopeQuery(req);
    const groupId = String(req.params?.groupId || '').trim().toLowerCase();
    const phone = String(req.params?.phone || '').trim();

    if (!userId || !groupId || !phone) {
      return res.status(400).json({ error: 'Missing texting group thread data' });
    }

    const group = await TextingGroup.findOne({
      slug: groupId,
      ...getTextingGroupAccessQuery(userId, role, clientAccountId),
    });

    if (!group) {
      return res.status(404).json({ error: 'Texting group not found' });
    }

    const messages = await Message.find(
      getTextingGroupThreadQuery(group.slug, phone, clientScopeQuery)
    ).sort({ createdAt: 1 });

    res.json(messages);
  } catch (error) {
    console.error('Texting group messages error:', error);
    res.status(500).json({ error: 'Failed to load texting group messages' });
  }
};

exports.markTextingGroupRead = async (req, res) => {
  try {
    const userId = getSmsUserIdentity(req.user);
    const clientScopeQuery = await buildSmsClientScopeQuery(req);
    const groupId = String(req.params?.groupId || '').trim().toLowerCase();
    const phone = String(req.params?.phone || '').trim();

    if (!userId || !groupId || !phone) {
      return res.status(400).json({ error: 'Missing texting group read data' });
    }

    await Message.updateMany(
      {
        ...getTextingGroupThreadQuery(groupId, phone, clientScopeQuery),
        direction: 'inbound',
        readBy: { $ne: userId },
      },
      {
        $addToSet: { readBy: userId },
      }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Texting group read error:', error);
    res.status(500).json({ error: 'Failed to mark texting group read' });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const normalized = normalize(req.params.phone);
    const clientScopeQuery = await buildSmsClientScopeQuery(req);

    const messages = await Message.find({
      $and: [
        DIRECT_CUSTOMER_MESSAGE_QUERY,
        clientScopeQuery,
        {
          $or: [
            { from: normalized },
            { to: normalized },
            { conversationId: normalized },
          ],
        },
      ],
    }).sort({ createdAt: 1 });

    res.json(messages);
  } catch (error) {
    console.error('Messages error:', error);
    res.status(500).json({ error: 'Failed' });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const normalized = normalize(req.params.phone);
    const clientScopeQuery = await buildSmsClientScopeQuery(req);

    await Message.updateMany(
      {
        $and: [
          DIRECT_CUSTOMER_MESSAGE_QUERY,
          clientScopeQuery,
          {
            from: normalized,
            read: false,
          },
        ],
      },
      { read: true }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Read error:', error);
    res.status(500).json({ error: 'Failed' });
  }
};

exports.clearMessages = async (req, res) => {
  try {
    if (!isPlatformAdmin(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await Message.deleteMany({});
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
};

exports.uploadMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const baseUrl = ensureAbsoluteHttpsUrl(process.env.BASE_URL)
      || `${req.protocol}://${req.get('host')}`;

    const url = `${baseUrl}/uploads/${req.file.filename}`;

    res.json({ url });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
};
