const client = require('../config/twilio');
const Call = require('../models/Call');
const Contact = require('../models/Contact');

// ADD THIS AT THE TOP (if not already)
const normalizePhone = (phone) => {
  if (!phone) return '';
  return phone.toString().replace(/\D/g, '');
};

// 🔥 NEW: GET CALLS BY NUMBER
exports.getCallsByNumber = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);

    const calls = await Call.find({
      $or: [
        { from: { $regex: phone.slice(-10) } },
        { to: { $regex: phone.slice(-10) } }
      ]
    }).sort({ createdAt: 1 });

    res.json(calls);
  } catch (err) {
    console.error('❌ Fetch calls by number error:', err);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
};

// 📞 MAKE CALL
// 🚫 DISABLED (NOW USING BROWSER CALLING)
exports.makeCall = async (req, res) => {
  return res.json({
    message: 'Use browser softphone instead'
  });
};

// 📞 OUTBOUND TWIML
exports.handleOutboundCall = async (req, res) => {
  try {
    const { To } = req.body;

    console.log('📞 OUTBOUND TWIML TO:', To);

    res.set('Content-Type', 'text/xml');

    res.send(`
<Response>
  <Dial
    callerId="${process.env.TWILIO_PHONE_NUMBER}"
    record="record-from-answer"
    recordingStatusCallback="${process.env.BASE_URL}/api/calls/recording-status"
    recordingStatusCallbackMethod="POST"

    statusCallback="${process.env.BASE_URL}/api/calls/call-status"
    statusCallbackEvent="initiated ringing answered completed"
    statusCallbackMethod="POST"
  >
    <Number>${To}</Number>
  </Dial>
</Response>
`);
  } catch (err) {
    console.error('❌ Outbound TwiML error:', err);
    res.sendStatus(500);
  }
};

// 📊 STATUS UPDATE
exports.handleCallStatus = async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;

    console.log('📊 STATUS:', CallSid, CallStatus);

    const updated = await Call.findOneAndUpdate(
  { callSid: CallSid },
  {
    callSid: CallSid,
    from: req.body.From,
    to: req.body.To,
    status: CallStatus,
    duration: CallDuration || null,
    direction: req.body.Direction || 'outbound'
  },
  { upsert: true, returnDocument: 'after' }
);

    if (global.io && updated) {
      global.io.emit('callStatus', {
        callSid: CallSid,
        status: CallStatus,
      });

      // 🔥 VERY IMPORTANT: CLOSE POPUP WHEN CALL ENDS
      if (
        CallStatus === 'completed' ||
        CallStatus === 'canceled' ||
        CallStatus === 'failed' ||
        CallStatus === 'busy' ||
        CallStatus === 'no-answer'
      ) {
        console.log('🔴 CALL ENDED EVENT');

        global.io.emit('callEnded', {
          callSid: CallSid,
        });
      }
    }

    res.sendStatus(200);

  } catch (error) {
    console.error('❌ Status error:', error);
    res.sendStatus(500);
  }
};

// 🎧 RECORDING CALLBACK
exports.handleRecordingStatus = async (req, res) => {
  try {
    console.log('🎧 RECORDING CALLBACK HIT');
    console.log('📦 BODY:', req.body);

    const {
      CallSid,
      RecordingUrl,
      RecordingSid,
      RecordingStatus,
      RecordingDuration
    } = req.body;

    if (RecordingStatus !== 'completed') {
      return res.sendStatus(200);
    }

    const duration = RecordingDuration ? Number(RecordingDuration) : 0;

    const finalUrl = RecordingUrl
      ? `${RecordingUrl}.mp3`
      : null;

    const updated = await Call.findOneAndUpdate(
      { callSid: CallSid },
      {
        recordingUrl: finalUrl,
        recordingSid: RecordingSid,
        duration: duration,
        status: 'completed', // 🔥 force complete
      },
      { returnDocument: 'after' }
    );

    if (global.io) {
      console.log('📡 EMITTING COMPLETED');

      global.io.emit('callStatus', {
        callSid: CallSid,
        status: 'completed',
      });
    }

    console.log('✅ Recording saved:', finalUrl);
    console.log('⏱ Duration saved from recording:', duration);

    res.sendStatus(200);

  } catch (error) {
    console.error('❌ Recording error:', error);
    res.sendStatus(500);
  }
};

// 📊 GET CALL LOGS
exports.getCalls = async (req, res) => {
  try {
    const calls = await Call.find().sort({ createdAt: -1 });
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
};

// 📞 INCOMING CALL (🔥 WITH CALLER IDENTIFICATION)
exports.handleIncomingCall = async (req, res) => {
  try {
    const CallSid = req.body?.CallSid;
    const From = req.body?.From;
    const To = req.body?.To;

    console.log('📞 INBOUND CALL:', From, '→', To);

    // 🔥 FIND CONTACT
    const normalizedFrom = normalizePhone(From);

    const contact = await Contact.findOne({
      'phones.number': { $regex: normalizedFrom.slice(-10) }
    });

    // ✅ SAVE CALL
    await Call.findOneAndUpdate(
      { callSid: CallSid },
      {
        callSid: CallSid,
        from: From,
        to: To,
        direction: 'inbound',
        status: 'ringing',
      },
      { upsert: true, returnDocument: 'after' }
    );

    // 🔥 SOCKET EVENTS WITH CONTACT
    if (global.io) {
      global.io.emit('incomingCall', {
        callSid: CallSid,
        from: From,
        to: To,
        contact: contact
          ? {
              firstName: contact.firstName,
              lastName: contact.lastName,
              dba: contact.dba,
              mid: contact.mid || ''
            }
          : null
      });

      global.io.emit('callStatus', {
        callSid: CallSid,
        status: 'ringing',
      });
    }

    res.set('Content-Type', 'text/xml');

    res.send(`
<Response>
  <Dial
    callerId="${process.env.TWILIO_PHONE_NUMBER}"
    timeout="20"
    record="record-from-answer"
    recordingStatusCallback="${process.env.BASE_URL}/api/calls/recording-status"
    recordingStatusCallbackMethod="POST"
  >
    <Client>web_user</Client>
  </Dial>
</Response>
`);

  } catch (err) {
    console.error('❌ Incoming call error:', err);

    // 🔥 NEVER FAIL TWILIO
    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Say>Error</Say></Response>`);
  }
};

// 🧹 CLEAR CALLS
exports.clearCalls = async (req, res) => {
  try {
    await Call.deleteMany({});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear calls' });
  }
};