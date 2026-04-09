const Call = require('../models/Call');

// âœ… STATUS PRIORITY (VERY IMPORTANT)
const statusPriority = {
  initiated: 1,
  ringing: 2,
  answered: 3,   // âœ… Twilio uses "answered"
  completed: 4,
};

// âœ… HANDLE CALL STATUS (TWILIO WEBHOOK - FIXED)
const handleCallStatus = (req, res) => {
  console.log('ðŸ”¥ WEBHOOK HIT');

  // âœ… ALWAYS RESPOND IMMEDIATELY
  res.status(200).send('OK');

  try {
    const body =
      Object.keys(req.body || {}).length > 0
        ? req.body
        : req.query;

    const CallSid = body.CallSid;

    if (!CallSid) {
      console.log('âŒ Missing CallSid');
      return;
    }

    const updateData = {
      callSid: CallSid,
      from: body.From,
      to: body.To,
      status: body.CallStatus,
      duration: body.CallDuration || '0',
      direction: body.Direction,
    };

    console.log('ðŸ“¡ Status:', body.CallStatus);

    // âœ… FIRE AND FORGET (NO AWAIT = NO CRASH)
    Call.findOneAndUpdate(
      { callSid: CallSid },
      updateData,
      {
        upsert: true,
        returnDocument: 'after',
      }
    )
      .then(() => {
        console.log('âœ… Updated:', body.CallStatus);
      })
      .catch((err) => {
        console.error('âŒ DB Error:', err);
      });

  } catch (error) {
    console.error('âŒ Fatal Error:', error);
  }
};

// âœ… GET ALL CALL LOGS
const getCalls = async (req, res) => {
  try {
    const calls = await Call.find().sort({ createdAt: -1 });
    res.json(calls);
  } catch (error) {
    console.error('âŒ Fetch error:', error);
    res.status(500).json({ error: error.message });
  }
};

// ðŸ§¹ CLEAR ALL CALL LOGS
const clearCalls = async (req, res) => {
  try {
    await Call.deleteMany({});
    console.log('ðŸ§¹ Cleared all logs');

    res.json({
      success: true,
      message: 'All call logs cleared',
    });
  } catch (error) {
    console.error('âŒ Clear error:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  handleCallStatus,
  getCalls,
  clearCalls,
};
