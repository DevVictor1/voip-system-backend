const Message = require('../models/Message');
const Contact = require('../models/Contact');
const User = require('../models/User');
const TextingGroup = require('../models/TextingGroup');
const twilio = require('twilio');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const {
  incrementAgentWorkload,
  normalizeAgentId,
  syncLifecycleWorkload,
} = require('../utils/agentWorkload');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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

const findContactByPhone = async (phone) => {
  const normalized = normalize(phone);

  return Contact.findOne({
    'phones.number': normalized,
  });
};

const normalizeAssignedNumber = (value) => normalize(value || '');

const findTextingGroupBySlug = async (groupId) => {
  if (!groupId) return null;

  return TextingGroup.findOne({
    slug: String(groupId).trim().toLowerCase(),
    isActive: true,
  });
};

const findTextingGroupByAssignedNumber = async (phoneNumber) => {
  const normalized = normalizeAssignedNumber(phoneNumber);
  if (!normalized) return null;

  return TextingGroup.findOne({
    assignedNumber: normalized,
    isActive: true,
  });
};

const getTextingGroupAccessQuery = (userId, role) => {
  if (role === 'admin') {
    return { isActive: true };
  }

  return {
    isActive: true,
    members: userId,
  };
};

const resolveTextingGroup = async ({ contact, assignedNumber }) => {
  const contactGroupId = String(contact?.textingGroupId || '').trim().toLowerCase();

  if (contactGroupId) {
    const matchedGroup = await findTextingGroupBySlug(contactGroupId);
    if (matchedGroup) {
      return matchedGroup;
    }
  }

  return findTextingGroupByAssignedNumber(assignedNumber);
};

const getCounterpartPhoneForMessage = (message) => {
  if (!message) return '';
  const isOutgoing = message.direction === 'outbound';
  return normalize(isOutgoing ? message.to : message.from);
};

const getTextingGroupThreadQuery = (groupId, phone) => {
  const normalizedPhone = normalize(phone);

  return {
    $and: [
      BASE_CUSTOMER_MESSAGE_QUERY,
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

const findOrCreateContactByPhone = async (phone) => {
  const normalized = normalize(phone);

  if (!normalized) {
    return null;
  }

  const existingContact = await findContactByPhone(normalized);
  if (existingContact) {
    return existingContact;
  }

  const createdContact = await Contact.create({
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

    let contact = await findOrCreateContactByPhone(From);
    const textingGroup = await resolveTextingGroup({
      contact,
      assignedNumber: To,
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
    const { to, body, message, mediaUrl, textingGroupId, userId, senderName } = req.body;
    const text = body || message;

    if (!to || (!text && !mediaUrl)) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const normalizedTo = normalize(to);
    const formattedTo = formatToE164(to);

    if (!formattedTo) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    const textingGroup = textingGroupId
      ? await findTextingGroupBySlug(textingGroupId)
      : null;

    if (textingGroupId && !textingGroup) {
      return res.status(404).json({ error: 'Texting group not found' });
    }

    if (textingGroup && userId) {
      const canUseGroup = textingGroup.members.includes(String(userId)) || req.body?.role === 'admin';
      if (!canUseGroup) {
        return res.status(403).json({ error: 'You are not a member of this texting group' });
      }
    }

    console.log('Sending SMS to:', formattedTo);

    const mediaList = mediaUrl
      ? (Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl])
      : undefined;

    const payload = {
      body: text,
      from: textingGroup?.assignedNumber || process.env.TWILIO_PHONE_NUMBER,
      to: formattedTo,
      mediaUrl: mediaList,
    };

    const baseUrl = ensureAbsoluteHttpsUrl(process.env.BASE_URL);
    if (baseUrl) {
      payload.statusCallback = `${baseUrl}/api/sms/status`;
    }

    const twilioRes = await client.messages.create(payload);

    const contact = await findOrCreateContactByPhone(normalizedTo);
    if (contact && textingGroup) {
      await getTextingGroupContactPayload(contact, textingGroup);
    }

    const saved = await Message.create({
      sid: twilioRes.sid,
      from: normalize(textingGroup?.assignedNumber || process.env.TWILIO_PHONE_NUMBER),
      to: normalizedTo,
      fromFull: textingGroup?.assignedNumber || process.env.TWILIO_PHONE_NUMBER,
      toFull: to,
      body: text,
      media: mediaList || [],
      direction: 'outbound',
      conversationType: 'customer',
      conversationId: normalizedTo,
      textingGroupId: textingGroup?.slug || null,
      textingGroupName: textingGroup?.name || null,
      senderId: userId || null,
      senderName: senderName || null,
      source: 'sms',
      status: twilioRes.status || 'queued',
      read: true,
      readBy: userId ? [String(userId)] : [],
    });

    if (global.io) {
      global.io.emit('newMessage', saved);
    }

    res.json(saved);
  } catch (error) {
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
    const messages = await Message.find(DIRECT_CUSTOMER_MESSAGE_QUERY).sort({ createdAt: -1 });
    const conversations = {};

    for (const msg of messages) {
      const isOutgoing = msg.from === normalize(process.env.TWILIO_PHONE_NUMBER);
      const phone = isOutgoing ? msg.to : msg.from;
      const key = normalize(msg.conversationId || phone);

        if (!conversations[key]) {
          const contact = await findContactByPhone(key);

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
    const userId = String(req.query?.userId || '').trim();
    const role = String(req.query?.role || '').trim().toLowerCase();

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    const groups = await TextingGroup.find(getTextingGroupAccessQuery(userId, role))
      .sort({ updatedAt: -1, name: 1 });

    const groupIds = groups.map((group) => group.slug);
    const messages = groupIds.length > 0
      ? await Message.find({
          ...BASE_CUSTOMER_MESSAGE_QUERY,
          textingGroupId: { $in: groupIds },
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
    const userId = String(req.query?.userId || '').trim();
    const role = String(req.query?.role || '').trim().toLowerCase();
    const groupId = String(req.params?.groupId || '').trim().toLowerCase();

    if (!userId || !groupId) {
      return res.status(400).json({ error: 'Missing group access data' });
    }

    const group = await TextingGroup.findOne({
      slug: groupId,
      ...getTextingGroupAccessQuery(userId, role),
    });

    if (!group) {
      return res.status(404).json({ error: 'Texting group not found' });
    }

    const messages = await Message.find({
      ...BASE_CUSTOMER_MESSAGE_QUERY,
      textingGroupId: group.slug,
    }).sort({ createdAt: -1 });

    const conversations = {};

    for (const msg of messages) {
      const phone = getCounterpartPhoneForMessage(msg);
      if (!phone) continue;

      if (!conversations[phone]) {
        const contact = await findContactByPhone(phone);
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
    const userId = String(req.query?.userId || '').trim();
    const role = String(req.query?.role || '').trim().toLowerCase();
    const groupId = String(req.params?.groupId || '').trim().toLowerCase();
    const phone = String(req.params?.phone || '').trim();

    if (!userId || !groupId || !phone) {
      return res.status(400).json({ error: 'Missing texting group thread data' });
    }

    const group = await TextingGroup.findOne({
      slug: groupId,
      ...getTextingGroupAccessQuery(userId, role),
    });

    if (!group) {
      return res.status(404).json({ error: 'Texting group not found' });
    }

    const messages = await Message.find(
      getTextingGroupThreadQuery(group.slug, phone)
    ).sort({ createdAt: 1 });

    res.json(messages);
  } catch (error) {
    console.error('Texting group messages error:', error);
    res.status(500).json({ error: 'Failed to load texting group messages' });
  }
};

exports.markTextingGroupRead = async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.query?.userId || '').trim();
    const groupId = String(req.params?.groupId || '').trim().toLowerCase();
    const phone = String(req.params?.phone || '').trim();

    if (!userId || !groupId || !phone) {
      return res.status(400).json({ error: 'Missing texting group read data' });
    }

    await Message.updateMany(
      {
        ...getTextingGroupThreadQuery(groupId, phone),
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

    const messages = await Message.find({
      ...DIRECT_CUSTOMER_MESSAGE_QUERY,
      $or: [
        { from: normalized },
        { to: normalized },
        { conversationId: normalized },
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

    await Message.updateMany(
      {
        ...DIRECT_CUSTOMER_MESSAGE_QUERY,
        from: normalized,
        read: false,
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
