const Message = require('../models/Message');
const Contact = require('../models/Contact');
const client = require('../config/twilio');

// ðŸ”¥ NORMALIZE (SAFE)
const normalize = (num) => {
  if (!num) return '';
  return num.replace(/\D/g, '').slice(-10);
};

// ðŸ” FIND CONTACT
const findContactByPhone = async (phone) => {
  const normalized = normalize(phone);

  return await Contact.findOne({
    'phones.number': normalized,
  });
};

// ðŸ“© RECEIVE SMS
exports.receiveSMS = async (req, res) => {
  try {
    const { From, To, Body } = req.body;

    console.log('ðŸ“© INCOMING SMS:', From, Body);

    const message = await Message.create({
      from: normalize(From),
      to: normalize(To),
      fromFull: From,     // ðŸ”¥ KEEP ORIGINAL
      toFull: To,         // ðŸ”¥ KEEP ORIGINAL
      body: Body,
      direction: 'inbound',
      read: false,
      status: 'received',
    });

    if (global.io) {
      global.io.emit('newMessage', message);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('âŒ RECEIVE ERROR:', error);
    res.sendStatus(500);
  }
};

// ðŸ“¤ SEND SMS
exports.sendSMS = async (req, res) => {
  try {
    const { to, body, message } = req.body;
    const text = body || message;

    if (!to || !text) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const normalizedTo = normalize(to);

    const twilioRes = await client.messages.create({
      body: text,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      statusCallback: `${process.env.BASE_URL?.trim()}/api/sms/status`,
    });

    const saved = await Message.create({
      sid: twilioRes.sid,
      from: normalize(process.env.TWILIO_PHONE_NUMBER),
      to: normalizedTo,
      fromFull: process.env.TWILIO_PHONE_NUMBER,
      toFull: to,
      body: text,
      direction: 'outbound',
      status: twilioRes.status || 'queued',
      read: true,
    });

    if (global.io) {
      global.io.emit('newMessage', saved);
    }

    res.json(saved);

  } catch (error) {
    console.error('âŒ SEND ERROR:', error);
    res.status(500).json({ error: 'Send failed' });
  }
};

// ðŸ“Š STATUS CALLBACK
exports.smsStatusCallback = async (req, res) => {
  try {
    const { MessageSid, MessageStatus } = req.body;

    await Message.findOneAndUpdate(
      { sid: MessageSid },
      { status: MessageStatus }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error('âŒ STATUS ERROR:', err);
    res.sendStatus(500);
  }
};

// ðŸ“š GET CONVERSATIONS
exports.getConversations = async (req, res) => {
  try {
    const messages = await Message.find().sort({ createdAt: -1 });

    const conversations = {};

    for (const msg of messages) {
      const isOutgoing =
        msg.from === normalize(process.env.TWILIO_PHONE_NUMBER);

      const phone = isOutgoing ? msg.to : msg.from;
      const key = normalize(phone);

      if (!conversations[key]) {
        const contact = await findContactByPhone(key);

        conversations[key] = {
          phone: key,
          name: contact
            ? `${contact.firstName} ${contact.lastName}`
            : key,
          lastMessage: msg.body,
          updatedAt: msg.createdAt,
          unread: 0,
        };
      }

      if (!msg.read && msg.direction === 'inbound') {
        conversations[key].unread += 1;
      }
    }

    res.json(Object.values(conversations));

  } catch (error) {
    console.error('âŒ Conversations error:', error);
    res.status(500).json({ error: 'Failed' });
  }
};

// ðŸ’¬ GET MESSAGES
exports.getMessages = async (req, res) => {
  try {
    const normalized = normalize(req.params.phone);

    const messages = await Message.find({
      $or: [
        { from: normalized },
        { to: normalized },
      ],
    }).sort({ createdAt: 1 });

    res.json(messages);

  } catch (error) {
    console.error('âŒ Messages error:', error);
    res.status(500).json({ error: 'Failed' });
  }
};

// âœ… MARK AS READ
exports.markAsRead = async (req, res) => {
  try {
    const normalized = normalize(req.params.phone);

    await Message.updateMany(
      {
        from: normalized,
        read: false,
      },
      { read: true }
    );

    res.json({ success: true });

  } catch (error) {
    console.error('âŒ Read error:', error);
    res.status(500).json({ error: 'Failed' });
  }
};

// ðŸ§¹ CLEAR
exports.clearMessages = async (req, res) => {
  try {
    await Message.deleteMany({});
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
};
