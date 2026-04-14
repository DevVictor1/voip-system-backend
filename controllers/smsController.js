const Message = require('../models/Message');
const Contact = require('../models/Contact');
const twilio = require('twilio');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

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

// 🔥 NORMALIZE (SAFE)
const normalize = (num) => {
  if (!num) return '';
  return num.replace(/\D/g, '').slice(-10);
};

// 🔍 FIND CONTACT
const findContactByPhone = async (phone) => {
  const normalized = normalize(phone);

  return await Contact.findOne({
    'phones.number': normalized,
  });
};

// 📩 RECEIVE SMS
exports.receiveSMS = async (req, res) => {
  try {
    const { From, To, Body } = req.body;
    const numMedia = parseInt(req.body.NumMedia || '0');
    const media = [];

    if (numMedia > 0) {
      for (let i = 0; i < numMedia; i += 1) {
        media.push(req.body[`MediaUrl${i}`]);
      }
    }

    console.log('📩 INCOMING SMS:', From, Body);

    const message = await Message.create({
      from: normalize(From),
      to: normalize(To),
      fromFull: From,     // 🔥 KEEP ORIGINAL
      toFull: To,         // 🔥 KEEP ORIGINAL
      body: Body,
      media,
      direction: 'inbound',
      read: false,
      status: 'received',
    });

    if (global.io) {
      global.io.emit('newMessage', message);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ RECEIVE ERROR:', error);
    res.sendStatus(500);
  }
};

// 📤 SEND SMS
exports.sendSMS = async (req, res) => {
  try {
    const { to, body, message, mediaUrl } = req.body;
    const text = body || message;

    if (!to || (!text && !mediaUrl)) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const normalizedTo = normalize(to);
    const formattedTo = formatToE164(to);

    if (!formattedTo) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    console.log('Sending SMS to:', formattedTo);

    const mediaList = mediaUrl
      ? (Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl])
      : undefined;

    const payload = {
      body: text,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: formattedTo,
      mediaUrl: mediaList,
    };

    const baseUrl = process.env.BASE_URL?.trim();
    if (baseUrl) {
      payload.statusCallback = baseUrl + '/api/sms/status';
    }

    const twilioRes = await client.messages.create(payload);

    const saved = await Message.create({
      sid: twilioRes.sid,
      from: normalize(process.env.TWILIO_PHONE_NUMBER),
      to: normalizedTo,
      fromFull: process.env.TWILIO_PHONE_NUMBER,
      toFull: to,
      body: text,
      media: mediaList || [],
      direction: 'outbound',
      status: twilioRes.status || 'queued',
      read: true,
    });

    if (global.io) {
      global.io.emit('newMessage', saved);
    }

    res.json(saved);

  } catch (error) {
    console.error(error);
    console.error('SEND ERROR:', error);
    res.status(500).json({ error: 'Send failed' });
  }
};

// 📊 STATUS CALLBACK
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
        status: MessageStatus
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ STATUS ERROR:', err);
    res.sendStatus(500);
  }
};

// 📚 GET CONVERSATIONS
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
    console.error('❌ Conversations error:', error);
    res.status(500).json({ error: 'Failed' });
  }
};

// 💬 GET MESSAGES
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
    console.error('❌ Messages error:', error);
    res.status(500).json({ error: 'Failed' });
  }
};

// ✅ MARK AS READ
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
    console.error('❌ Read error:', error);
    res.status(500).json({ error: 'Failed' });
  }
};

// 🧹 CLEAR
exports.clearMessages = async (req, res) => {
  try {
    await Message.deleteMany({});
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
};

// 📎 UPLOAD MEDIA
exports.uploadMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const baseUrl = process.env.BASE_URL?.trim()
      || `${req.protocol}://${req.get('host')}`;

    const url = `${baseUrl}/uploads/${req.file.filename}`;

    res.json({ url });
  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
};










