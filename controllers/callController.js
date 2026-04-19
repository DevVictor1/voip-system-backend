const Call = require('../models/Call');
const Contact = require('../models/Contact');
const User = require('../models/User');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const {
  IVR_DEPARTMENT_ROUTES,
} = require('../config/chatConfig');

const FINAL_CALL_STATUSES = ['completed', 'canceled', 'failed', 'busy', 'no-answer'];
const RETRYABLE_DIAL_STATUSES = ['busy', 'failed', 'no-answer', 'canceled'];
const DEFAULT_DIAL_TIMEOUT_SECONDS = 20;

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
const buildRetryIvrUrl = ({ lang, digit, callSid }) => {
  const params = new URLSearchParams({
    step: 'retry',
    lang: normalizeLang(lang),
    digit: String(digit || ''),
    callSid: String(callSid || ''),
  });

  return `/api/calls/ivr?${params.toString()}`;
};

const isAgentAvailable = (agentId) => {
  if (!agentId) {
    return false;
  }

  const socketId = global.connectedUsers?.[agentId] || '';
  const status = global.agentStatus?.[agentId] || 'offline';
  const voiceReady = Boolean(global.agentVoiceReady?.[agentId]);

  return Boolean(socketId && status === 'online' && voiceReady);
};

const getAgentAvailabilityReason = (agentId) => {
  if (!agentId) {
    return 'missing-agent-id';
  }

  if (!global.connectedUsers?.[agentId]) {
    return 'no-socket-registration';
  }

  if (global.agentStatus?.[agentId] !== 'online') {
    return `status-${global.agentStatus?.[agentId] || 'offline'}`;
  }

  if (!global.agentVoiceReady?.[agentId]) {
    return 'voice-not-ready';
  }

  return 'available';
};

const dedupeAgentIds = (agentIds = []) => {
  return [...new Set(agentIds.filter(Boolean))];
};

const resolveEligibleDepartmentUsers = async (department) => {
  if (!department) {
    return [];
  }

  const users = await User.find({
    role: { $in: ['agent', 'admin'] },
    department,
    isActive: true,
    agentId: { $type: 'string', $ne: '' },
  })
    .select('name role agentId department isActive maxConcurrentCalls')
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

const resolveActiveCallCounts = async (agentIds = []) => {
  const uniqueAgentIds = dedupeAgentIds(agentIds);

  if (uniqueAgentIds.length === 0) {
    return {};
  }

  const counts = await Call.aggregate([
    {
      $match: {
        assignedAgentId: { $in: uniqueAgentIds },
        status: { $nin: FINAL_CALL_STATUSES },
      },
    },
    {
      $group: {
        _id: '$assignedAgentId',
        count: { $sum: 1 },
      },
    },
  ]);

  return counts.reduce((acc, item) => {
    if (item?._id) {
      acc[item._id] = item.count || 0;
    }
    return acc;
  }, {});
};

const selectQueueTarget = async (users = []) => {
  const availableUsers = users
    .filter((user) => isAgentAvailable(user?.agentId))
    .filter((user) => {
      const maxConcurrentCalls = Number.isFinite(user?.maxConcurrentCalls)
        ? user.maxConcurrentCalls
        : 1;
      return maxConcurrentCalls > 0;
    });

  if (availableUsers.length === 0) {
    return {
      target: null,
      availableUsers: [],
      activeCallCounts: {},
    };
  }

  const activeCallCounts = await resolveActiveCallCounts(
    availableUsers.map((user) => user.agentId)
  );

  const rankedUsers = availableUsers
    .map((user) => {
      const activeCallCount = activeCallCounts[user.agentId] || 0;
      const maxConcurrentCalls = Number.isFinite(user?.maxConcurrentCalls)
        ? user.maxConcurrentCalls
        : 1;

      return {
        ...user.toObject(),
        activeCallCount,
        maxConcurrentCalls,
      };
    })
    .filter((user) => user.activeCallCount < user.maxConcurrentCalls)
    .sort((left, right) => {
      if (left.activeCallCount !== right.activeCallCount) {
        return left.activeCallCount - right.activeCallCount;
      }

      const leftName = String(left.name || '');
      const rightName = String(right.name || '');
      return leftName.localeCompare(rightName);
    });

  return {
    target: rankedUsers[0] || null,
    availableUsers: rankedUsers,
    activeCallCounts,
  };
};

const resolveLegacyFallbackAgents = (routeConfig) => {
  return dedupeAgentIds(routeConfig?.fallbackAgents || []);
};

const buildDialTimeoutSeconds = () => {
  const parsed = Number(process.env.TWILIO_AGENT_DIAL_TIMEOUT || DEFAULT_DIAL_TIMEOUT_SECONDS);
  if (!Number.isFinite(parsed) || parsed < 5) {
    return DEFAULT_DIAL_TIMEOUT_SECONDS;
  }

  return Math.floor(parsed);
};

const buildCandidatePlan = async (routeConfig) => {
  const eligibleDepartmentUsers = await resolveEligibleDepartmentUsers(routeConfig?.department);
  const {
    target: queueTarget,
    availableUsers: availableDepartmentUsers,
    activeCallCounts,
  } = await selectQueueTarget(eligibleDepartmentUsers);
  const queueCandidates = dedupeAgentIds(
    availableDepartmentUsers.map((user) => user.agentId)
  );
  const fallbackCandidates = resolveLegacyFallbackAgents(routeConfig);

  return {
    eligibleDepartmentUsers,
    queueTarget,
    availableDepartmentUsers,
    activeCallCounts,
    queueCandidates,
    fallbackCandidates,
  };
};

const findNextAvailableAgentId = (candidateIds = [], attemptedAgentIds = []) => {
  const attempted = new Set(dedupeAgentIds(attemptedAgentIds));
  return dedupeAgentIds(candidateIds).find((agentId) => (
    !attempted.has(agentId) && isAgentAvailable(agentId)
  )) || '';
};

const persistRoutingAttempt = async ({
  callSid,
  agentId,
  department,
  fallbackUsed,
  queueCandidates,
  fallbackCandidates,
  attemptedAgentIds,
}) => {
  const nextAttemptedAgentIds = dedupeAgentIds([...(attemptedAgentIds || []), agentId]);

  return Call.findOneAndUpdate(
    { callSid },
    {
      assignedAgentId: agentId,
      assignedDepartment: department || null,
      fallbackUsed: Boolean(fallbackUsed),
      queueCandidates: dedupeAgentIds(queueCandidates || []),
      fallbackCandidates: dedupeAgentIds(fallbackCandidates || []),
      attemptedAgentIds: nextAttemptedAgentIds,
      retryCount: Math.max(0, nextAttemptedAgentIds.length - 1),
      lastAttemptedAgentId: agentId || null,
      status: 'ringing',
    },
    { returnDocument: 'after' }
  );
};

const dialAgentClient = ({
  twiml,
  agentId,
  currentLang,
  digit,
  callSid,
}) => {
  const dial = twiml.dial({
    callerId: process.env.TWILIO_PHONE_NUMBER,
    record: 'record-from-answer-dual',
    timeout: buildDialTimeoutSeconds(),
    action: buildRetryIvrUrl({ lang: currentLang, digit, callSid }),
    method: 'POST',
    recordingStatusCallback: 'https://voip-system-backend.onrender.com/api/calls/recording-status',
    recordingStatusCallbackMethod: 'POST',
    recordingStatusCallbackEvent: 'completed',
  });

  dial.client(agentId);
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

  const digit = String(req.body.Digits || req.query.digit || '');
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

    const {
      eligibleDepartmentUsers,
      queueTarget,
      availableDepartmentUsers,
      activeCallCounts,
      queueCandidates,
      fallbackCandidates,
    } = await buildCandidatePlan(routeConfig);

    console.log(
      '[IVR queue]',
      JSON.stringify({
        digit,
        department: routeConfig.department,
        eligibleUsers: eligibleDepartmentUsers.map((user) => ({
          id: String(user._id),
          name: user.name,
          role: user.role,
          agentId: user.agentId,
          maxConcurrentCalls: Number.isFinite(user.maxConcurrentCalls) ? user.maxConcurrentCalls : 1,
          routingReason: getAgentAvailabilityReason(user.agentId),
          activeCallCount: activeCallCounts[user.agentId] || 0,
        })),
        availableUsers: availableDepartmentUsers.map((user) => ({
          agentId: user.agentId,
          activeCallCount: user.activeCallCount,
          maxConcurrentCalls: user.maxConcurrentCalls,
        })),
        selectedTarget: queueTarget?.agentId || null,
        queueCandidates,
        fallbackCandidates,
      })
    );

    let agentToDial = queueTarget?.agentId || '';
    let fallbackUsed = false;

    if (!agentToDial) {
      const availableFallbackAgents = fallbackCandidates.filter((agentId) => isAgentAvailable(agentId));
      agentToDial = availableFallbackAgents[0] || '';
      fallbackUsed = Boolean(agentToDial);

      console.log(
        '[IVR queue fallback]',
        JSON.stringify({
          digit,
          department: routeConfig.department,
          fallbackAgents: fallbackCandidates,
          availableFallbackAgents,
          fallbackReasons: fallbackCandidates.map((agentId) => ({
            agentId,
            reason: getAgentAvailabilityReason(agentId),
          })),
          selectedTarget: agentToDial || null,
        })
      );
    }

    // ==========================
    // ❗ FALLBACK (NO AGENTS)
    // ==========================
    if (!agentToDial) {
      console.log(
        '[IVR queue no agent available]',
        JSON.stringify({
          digit,
          department: routeConfig.department,
          departmentReasons: eligibleDepartmentUsers.map((user) => ({
            agentId: user.agentId,
            reason: getAgentAvailabilityReason(user.agentId),
          })),
        })
      );
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

    await persistRoutingAttempt({
      callSid: CallSid,
      agentId: agentToDial,
      department: routeConfig.department,
      fallbackUsed,
      queueCandidates,
      fallbackCandidates,
      attemptedAgentIds: [],
    });

    console.log(
      '[IVR queue connect]',
      JSON.stringify({
        digit,
        department: routeConfig.department,
        attemptNumber: 1,
        selectedTarget: agentToDial,
        fallbackUsed,
        activeCallCount: activeCallCounts[agentToDial] || 0,
        routingReason: getAgentAvailabilityReason(agentToDial),
      })
    );

    twiml.say(sayOptions, prompts.connecting);
    dialAgentClient({
      twiml,
      agentId: agentToDial,
      currentLang,
      digit,
      callSid: CallSid,
    });

    return res.type('text/xml').send(twiml.toString());
  }

  if (step === 'retry') {
    const CallSid = String(req.query.callSid || req.body.CallSid || '');
    const dialStatus = String(req.body.DialCallStatus || '').trim().toLowerCase();
    const dialCallSid = String(req.body.DialCallSid || '');
    const routeConfig = IVR_DEPARTMENT_ROUTES[digit];

    if (!CallSid || !routeConfig) {
      twiml.say(sayOptions, prompts.noAgents);
      return res.type('text/xml').send(twiml.toString());
    }

    const parentCall = await Call.findOne({ callSid: CallSid });

    if (!parentCall) {
      twiml.say(sayOptions, prompts.noAgents);
      return res.type('text/xml').send(twiml.toString());
    }

    console.log(
      '[IVR retry status]',
      JSON.stringify({
        callSid: CallSid,
        department: routeConfig.department,
        dialStatus,
        dialCallSid: dialCallSid || null,
        lastAttemptedAgentId: parentCall.lastAttemptedAgentId || null,
        attemptedAgentIds: parentCall.attemptedAgentIds || [],
      })
    );

    if (!RETRYABLE_DIAL_STATUSES.includes(dialStatus)) {
      if (dialStatus) {
        await Call.findOneAndUpdate(
          { callSid: CallSid },
          { status: dialStatus },
          { returnDocument: 'after' }
        );
      }

      return res.type('text/xml').send(twiml.toString());
    }

    const attemptedAgentIds = dedupeAgentIds(parentCall.attemptedAgentIds || []);
    const queueCandidates = dedupeAgentIds(parentCall.queueCandidates || []);
    const fallbackCandidates = dedupeAgentIds(parentCall.fallbackCandidates || []);

    const nextQueueAgentId = findNextAvailableAgentId(queueCandidates, attemptedAgentIds);
    const nextFallbackAgentId = nextQueueAgentId
      ? ''
      : findNextAvailableAgentId(fallbackCandidates, attemptedAgentIds);
    const nextAgentId = nextQueueAgentId || nextFallbackAgentId;
    const fallbackUsed = Boolean(!nextQueueAgentId && nextFallbackAgentId);

    console.log(
      '[IVR retry decision]',
      JSON.stringify({
        callSid: CallSid,
        department: routeConfig.department,
        attemptNumber: attemptedAgentIds.length + 1,
        dialStatus,
        nextQueueAgentId: nextQueueAgentId || null,
        nextFallbackAgentId: nextFallbackAgentId || null,
        nextAgentId: nextAgentId || null,
      })
    );

    if (!nextAgentId) {
      await Call.findOneAndUpdate(
        { callSid: CallSid },
        { status: dialStatus || 'no-answer' },
        { returnDocument: 'after' }
      );

      console.log(
        '[IVR retry exhausted]',
        JSON.stringify({
          callSid: CallSid,
          department: routeConfig.department,
          attemptedAgentIds,
          dialStatus,
        })
      );

      twiml.say(sayOptions, prompts.noAgents);
      return res.type('text/xml').send(twiml.toString());
    }

    emitIncomingCallPopup({
      agentId: nextAgentId,
      CallSid,
      From: parentCall.from,
      To: parentCall.to,
      contact: null,
    });

    await persistRoutingAttempt({
      callSid: CallSid,
      agentId: nextAgentId,
      department: routeConfig.department,
      fallbackUsed,
      queueCandidates,
      fallbackCandidates,
      attemptedAgentIds,
    });

    console.log(
      '[IVR retry connect]',
      JSON.stringify({
        callSid: CallSid,
        department: routeConfig.department,
        attemptNumber: attemptedAgentIds.length + 1,
        agentId: nextAgentId,
        fallbackUsed,
        retryReason: dialStatus,
      })
    );

    twiml.say(sayOptions, prompts.connecting);
    dialAgentClient({
      twiml,
      agentId: nextAgentId,
      currentLang,
      digit,
      callSid: CallSid,
    });

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

    if (ParentCallSid && FINAL_CALL_STATUSES.includes(CallStatus)) {
      await Call.findOneAndUpdate(
        { callSid: ParentCallSid },
        {
          status: CallStatus,
        },
        { returnDocument: 'after' }
      );
    }

    if (global.io && updated) {
      global.io.emit('callStatus', {
        callSid: CallSid,
        status: CallStatus,
      });

      if (FINAL_CALL_STATUSES.includes(CallStatus)) {
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
