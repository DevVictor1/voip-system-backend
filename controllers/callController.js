const Call = require('../models/Call');
const Contact = require('../models/Contact');
const User = require('../models/User');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const {
  INTERNAL_AGENTS,
  IVR_DEPARTMENT_ROUTES,
} = require('../config/chatConfig');

const normalizeLang = (lang) => (lang === 'vi' ? 'vi' : 'en');

const SAY_OPTIONS = {
  en: { language: 'en-US' },
  vi: { language: 'vi-VN' }
};

const PROMPTS = {
  en: {
    languageMenu: 'Press 1 for English. Press 2 for Vietnamese.',
    languageRetry: 'Invalid option. Please choose a language again.',
    departmentMenu: 'Press 1 for Technical Support. Press 2 for Customer Service. Press 3 for Sales.',
    departmentRetry: 'Invalid option. Please try again.',
    connecting: 'Connecting you now.',
    noAgents: 'No agents are available at the moment. Please try again later.',
    error: 'An error occurred. Please try again later.'
  },
  vi: {
    languageMenu: 'Nhan 1 cho tieng Anh. Nhan 2 cho tieng Viet.',
    languageRetry: 'Lua chon khong hop le. Vui long chon lai ngon ngu.',
    departmentMenu: 'Nhan 1 cho ho tro ky thuat. Nhan 2 cho cham soc khach hang. Nhan 3 cho bo phan ban hang.',
    departmentRetry: 'Lua chon khong hop le. Vui long thu lai.',
    connecting: 'Vui long doi trong giay lat. Chung toi dang ket noi cho quy khach.',
    noAgents: 'Hien tai khong co dien vien nao san sang. Vui long thu lai sau.',
    error: 'Da xay ra loi. Vui long thu lai sau.'
  }
};

const buildIvrUrl = (step, lang) => `/api/calls/ivr?step=${step}&lang=${normalizeLang(lang)}`;

const isAgentAvailable = (agentId) => {
  return Boolean(
    agentId
    && global.connectedUsers?.[agentId]
    && global.agentStatus?.[agentId] === 'online'
  );
};

const dedupeAgentIds = (agentIds = []) => {
  return [...new Set(agentIds.filter(Boolean))];
};

const resolveEligibleDepartmentUsers = async (department) => {
  if (!department) {
    return [];
  }

  const users = await User.find({
    role: 'agent',
    department,
    isActive: true,
    agentId: { $type: 'string', $ne: '' },
  })
    .select('name agentId department isActive')
    .sort({ name: 1, createdAt: 1 });

  const seenAgentIds = new Set();

  return users.filter((user) => {
    if (!user?.agentId || seenAgentIds.has(user.agentId)) {
      return false;
    }

    seenAgentIds.add(user.agentId);
    return true;
  });
};

const selectQueueTarget = (users = []) => {
  return users.find((user) => isAgentAvailable(user?.agentId)) || null;
};

const resolveLegacyFallbackAgents = (routeConfig) => {
  const fallbackAgents = dedupeAgentIds(routeConfig?.fallbackAgents || []);
  return fallbackAgents.filter((agentId) => INTERNAL_AGENTS[agentId]);
};

const emitIncomingCallPopup = ({ agentId, CallSid, From, To, contact }) => {
  const socketId = global.connectedUsers?.[agentId];

  if (!socketId || !global.io) {
    return;
  }

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
  const currentLang = normalizeLang(req.query.lang);
  const sayOptions = SAY_OPTIONS[currentLang];
  const prompts = PROMPTS[currentLang];

  console.log('IVR STEP:', step, 'LANG:', currentLang, 'INPUT:', digit);

  // ==========================
  // 🌍 STEP 1: LANGUAGE
  // ==========================
  if (step === 'lang') {
    if (digit) {
      if (digit === '1' || digit === '2') {
        const selectedLang = digit === '2' ? 'vi' : 'en';
        twiml.redirect(buildIvrUrl('dept', selectedLang));
        return res.type('text/xml').send(twiml.toString());
      }

      twiml.say(SAY_OPTIONS.en, PROMPTS.en.languageRetry);
    }

    const gather = twiml.gather({
      numDigits: 1,
      action: buildIvrUrl('lang', currentLang),
      method: 'POST',
      timeout: 5 // ✅ FIX
    });

    gather.say(
      sayOptions,
      prompts.languageMenu
    );

    // ✅ fallback if nothing pressed
    twiml.redirect(buildIvrUrl('lang', currentLang));

    return res.type('text/xml').send(twiml.toString());
  }

  // ==========================
  // 🏢 STEP 2: DEPARTMENT
  // ==========================
  if (step === 'dept') {
    if (digit && !['1', '2', '3'].includes(digit)) {
      twiml.say(sayOptions, prompts.departmentRetry);
    }

    const gather = twiml.gather({
      numDigits: 1,
      action: buildIvrUrl('route', currentLang),
      method: 'POST',
      timeout: 5 // ✅ FIX
    });

    gather.say(
      sayOptions,
      prompts.departmentMenu
    );

    // ✅ fallback if nothing pressed
    twiml.redirect(buildIvrUrl('dept', currentLang));

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

    const routeConfig = IVR_DEPARTMENT_ROUTES[digit];

    if (!routeConfig) {
      twiml.say(sayOptions, prompts.departmentRetry);
      twiml.redirect(buildIvrUrl('dept', currentLang));
      return res.type('text/xml').send(twiml.toString());
    }

    const eligibleDepartmentUsers = await resolveEligibleDepartmentUsers(routeConfig.department);
    const availableDepartmentUsers = eligibleDepartmentUsers.filter((user) => isAgentAvailable(user.agentId));
    const queueTarget = selectQueueTarget(eligibleDepartmentUsers);

    console.log(
      '[IVR queue]',
      JSON.stringify({
        digit,
        department: routeConfig.department,
        eligibleUsers: eligibleDepartmentUsers.map((user) => ({
          id: String(user._id),
          name: user.name,
          agentId: user.agentId,
        })),
        availableUsers: availableDepartmentUsers.map((user) => user.agentId),
        selectedTarget: queueTarget?.agentId || null,
      })
    );

    let agentToDial = queueTarget?.agentId || '';
    let fallbackUsed = false;

    if (!agentToDial) {
      const fallbackAgents = resolveLegacyFallbackAgents(routeConfig);
      const availableFallbackAgents = fallbackAgents.filter((agentId) => isAgentAvailable(agentId));
      agentToDial = availableFallbackAgents[0] || '';
      fallbackUsed = Boolean(agentToDial);

      console.log(
        '[IVR queue fallback]',
        JSON.stringify({
          digit,
          department: routeConfig.department,
          fallbackAgents,
          availableFallbackAgents,
          selectedTarget: agentToDial || null,
        })
      );
    }

    // ==========================
    // ❗ FALLBACK (NO AGENTS)
    // ==========================
    if (!agentToDial) {
      twiml.say(sayOptions, prompts.noAgents);
      return res.type('text/xml').send(twiml.toString());
    }

    // ==========================
    // 🔔 POPUP TO AGENTS
    // ==========================
    emitIncomingCallPopup({
      agentId: agentToDial,
      CallSid,
      From,
      To,
      contact,
    });

    console.log(
      '[IVR queue connect]',
      JSON.stringify({
        digit,
        department: routeConfig.department,
        selectedTarget: agentToDial,
        fallbackUsed,
      })
    );

    twiml.say(sayOptions, prompts.connecting);

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
  twiml.say(SAY_OPTIONS.en, PROMPTS.en.departmentRetry);
  twiml.redirect(buildIvrUrl('lang', 'en'));
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
      action: buildIvrUrl('lang', 'en'),
      method: 'POST',
      timeout: 5
    });

    gather.say(
      SAY_OPTIONS.en,
      PROMPTS.en.languageMenu
    );

    twiml.redirect('/api/calls/incoming-call');

    res.type('text/xml');
    res.send(twiml.toString());

  } catch (err) {
    console.error('Incoming call error:', err);

    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Say language="en-US">${PROMPTS.en.error}</Say></Response>`);
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
