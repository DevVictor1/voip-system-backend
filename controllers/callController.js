const Call = require('../models/Call');
const Contact = require('../models/Contact');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const lastAgentIndexByTeam = {};

const pickNextAgent = (teamKey, agents) => {
  if (!agents.length) return null;
  const lastIndex = lastAgentIndexByTeam[teamKey] ?? -1;
  const nextIndex = (lastIndex + 1) % agents.length;
  lastAgentIndexByTeam[teamKey] = nextIndex;
  return agents[nextIndex];
};

// NORMALIZE
const normalizePhone = (phone) => {
  if (!phone) return '';
  return phone.toString().replace(/\D/g, '');
};

// ==========================
// 🔥 IVR HANDLER (FIXED)
// ==========================
exports.handleIVR = async (req, res) => {
  const twiml = new VoiceResponse();

  const digit = req.body.Digits;
  const step = req.query.step || 'lang';

  console.log('IVR STEP:', step, 'INPUT:', digit);

  // ==========================
  // 🌍 STEP 1: LANGUAGE
  // ==========================
  if (step === 'lang') {
    const gather = twiml.gather({
      numDigits: 1,
      action: '/api/calls/ivr?step=dept',
      method: 'POST',
      timeout: 5 // ✅ FIX
    });

    gather.say(
      { voice: 'alice' },
      'Press 1 for English. Press 2 for Vietnamese.'
    );

    // ✅ fallback if nothing pressed
    twiml.redirect('/api/calls/ivr?step=lang');

    return res.type('text/xml').send(twiml.toString());
  }

  // ==========================
  // 🏢 STEP 2: DEPARTMENT
  // ==========================
  if (step === 'dept') {
    const gather = twiml.gather({
      numDigits: 1,
      action: '/api/calls/ivr?step=route',
      method: 'POST',
      timeout: 5 // ✅ FIX
    });

    gather.say(
      { voice: 'alice' },
      'Press 1 for Technical Support. Press 2 for Customer Service. Press 3 for Sales.'
    );

    // ✅ fallback if nothing pressed
    twiml.redirect('/api/calls/ivr?step=dept');

    return res.type('text/xml').send(twiml.toString());
  }

  // ==========================
  // 📞 STEP 3: ROUTING (QUEUE)
  // ==========================
  if (step === 'route') {
    const CallSid = req.body.CallSid;
    const From = req.body.From;
    const To = req.body.To;

    const contact = await Contact.findOne({
      'phones.number': { $regex: From.slice(-10) }
    });

    const teams = {
      '1': ['agent_1', 'agent_2'], // Tech
      '2': ['agent_3'],           // Support
      '3': ['agent_4', 'agent_5'] // Sales
    };

    const selectedTeam = teams[digit] || [];

    // ✅ FILTER ONLY ONLINE AGENTS
    const availableAgents = selectedTeam.filter(
      (agent) => global.connectedUsers?.[agent]
    );
    const agentToDial = pickNextAgent(digit, availableAgents);

    // ==========================
    // ❗ FALLBACK (NO AGENTS)
    // ==========================
    if (!agentToDial) {
      twiml.say('No agents are available at the moment. Please try again later.');
      return res.type('text/xml').send(twiml.toString());
    }

    // ==========================
    // 🔔 POPUP TO AGENTS
    // ==========================
    availableAgents.forEach((agent) => {
      const socketId = global.connectedUsers?.[agent];

      if (socketId) {
        global.io.to(socketId).emit('incomingCall', {
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
      }
    });

    twiml.say('Connecting you now');

    const dial = twiml.dial({
      callerId: process.env.TWILIO_PHONE_NUMBER,
      record: 'record-from-answer-dual',
      recordingStatusCallback: 'https://voip-system-backend.onrender.com/api/calls/recording-status',
      recordingStatusCallbackMethod: 'POST',
      recordingStatusCallbackEvent: 'completed',
    });

    // 🔥 RING ONLY AVAILABLE AGENTS
    dial.client(agentToDial);

    return res.type('text/xml').send(twiml.toString());
  }

  // fallback safety
  twiml.say('Invalid option');
  return res.type('text/xml').send(twiml.toString());
};

// ==========================
// 🔥 GET CALLS BY NUMBER
// ==========================
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
    console.error('Fetch calls by number error:', err);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
};

// ==========================
// 📞 MAKE CALL
// ==========================
exports.makeCall = async (req, res) => {
  return res.json({
    message: 'Use browser softphone instead'
  });
};

// ==========================
// 📞 OUTBOUND TWIML
// ==========================
exports.handleOutboundCall = async (req, res) => {
  try {
    const { To } = req.body;

    console.log('OUTBOUND TWIML TO:', To);

    res.set('Content-Type', 'text/xml');

    res.send(`
<Response>
  <Dial
    callerId="${process.env.TWILIO_PHONE_NUMBER}"
    record="record-from-answer"
    recordingStatusCallback="${process.env.BASE_URL?.trim()}/api/calls/recording-status"
    recordingStatusCallbackMethod="POST"
  >
    <Number
      statusCallback="${process.env.BASE_URL?.trim()}/api/calls/call-status"
      statusCallbackEvent="initiated ringing answered completed"
      statusCallbackMethod="POST"
    >
      ${To}
    </Number>
  </Dial>
</Response>
`);
  } catch (err) {
    console.error('Outbound TwiML error:', err);
    res.sendStatus(500);
  }
};

// ==========================
// 📊 STATUS UPDATE
// ==========================
exports.handleCallStatus = async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration, ParentCallSid } = req.body;

    console.log('CALL STATUS:', CallSid, CallStatus);

    const updated = await Call.findOneAndUpdate(
      { callSid: CallSid },
      {
        callSid: CallSid,
        parentCallSid: ParentCallSid || null,
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

      if (
        ['completed', 'canceled', 'failed', 'busy', 'no-answer'].includes(CallStatus)
      ) {
        global.io.emit('callEnded', { callSid: CallSid });
      }
    }

    res.sendStatus(200);

  } catch (error) {
    console.error('Status error:', error);
    res.sendStatus(500);
  }
};

// ==========================
// 🎧 RECORDING CALLBACK
// ==========================
exports.handleRecordingStatus = async (req, res) => {
  try {
    console.log('🎧 RECORDING CALLBACK HIT');
    console.log('📦 BODY:', req.body);

    const {
      CallSid,
      RecordingUrl,
      RecordingSid,
      RecordingStatus,
      RecordingDuration,
      ParentCallSid
    } = req.body;

    if (RecordingStatus !== 'completed') {
      return res.sendStatus(200);
    }

    const duration = RecordingDuration ? Number(RecordingDuration) : 0;

    const finalUrl = RecordingUrl
      ? `${RecordingUrl}.mp3`
      : null;

    // ✅ TRY 1: DIRECT MATCH (OUTBOUND + SIMPLE CALLS)
    let updated = await Call.findOneAndUpdate(
      { callSid: CallSid },
      {
        recordingSid: RecordingSid,
        recordingUrl: finalUrl,
        duration: duration,
        status: 'completed',
      },
      { returnDocument: 'after' }
    );

    // 🔥 TRY 2: IVR FIX (MATCH PARENT CALL)
    if (!updated && ParentCallSid) {
      console.log('🔁 Trying ParentCallSid match');

      updated = await Call.findOneAndUpdate(
        { callSid: ParentCallSid },
        {
          recordingSid: RecordingSid,
          recordingUrl: finalUrl,
          duration: duration,
          status: 'completed',
        },
        { returnDocument: 'after' }
      );
    }

    // 🔥 TRY 3: FALLBACK (LAST OUTBOUND — KEEP YOUR ORIGINAL LOGIC)
    if (!updated) {
      console.log('⚠️ Fallback to last outbound');

      updated = await Call.findOneAndUpdate(
        { direction: { $regex: 'outbound' } },
        {
          recordingSid: RecordingSid,
          recordingUrl: finalUrl,
          duration: duration,
          status: 'completed',
        },
        {
          sort: { createdAt: -1 },
          returnDocument: 'after'
        }
      );
    }

    if (global.io && updated) {
      console.log('📡 EMITTING COMPLETED');

      global.io.emit('callStatus', {
        callSid: updated.callSid,
        status: 'completed',
      });
    }

    console.log('✅ Recording saved:', RecordingSid);

    res.sendStatus(200);

  } catch (error) {
    console.error('❌ Recording error:', error);
    res.sendStatus(500);
  }
};

// ==========================
// 📞 INCOMING CALL (FINAL FIX)
// ==========================
exports.handleIncomingCall = async (req, res) => {
  try {
    const CallSid = req.body?.CallSid;
    const From = req.body?.From;
    const To = req.body?.To;

    console.log('INBOUND CALL:', From, '→', To);

    const normalizedFrom = normalizePhone(From);

    const contact = await Contact.findOne({
      'phones.number': { $regex: normalizedFrom.slice(-10) }
    });

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


    const twiml = new VoiceResponse();

    const gather = twiml.gather({
      numDigits: 1,
      action: '/api/calls/ivr?step=dept', // ✅ FIXED
      method: 'POST',
      timeout: 5
    });

    gather.say(
      { voice: 'alice' },
      'Welcome. Press 1 for English. Press 2 for Vietnamese.'
    );

    twiml.redirect('/api/calls/incoming-call'); // ✅ FIXED

    res.type('text/xml');
    res.send(twiml.toString());

  } catch (err) {
    console.error('Incoming call error:', err);

    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Say>Error</Say></Response>`);
  }
};

// ==========================
// 🧹 CLEAR CALLS
// ==========================
exports.clearCalls = async (req, res) => {
  try {
    await Call.deleteMany({});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear calls' });
  }
};

// ==========================
// 📊 GET CALL LOGS
// ==========================
exports.getCalls = async (req, res) => {
  try {
    const calls = await Call.find().sort({ createdAt: -1 });
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
};
