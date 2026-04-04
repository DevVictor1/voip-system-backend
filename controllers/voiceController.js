const AccessToken = require('twilio').jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

exports.generateToken = (req, res) => {
  try {
    const identity = 'web_user'; // 🔥 must match <client>web_user</client>

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { identity }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      incomingAllow: true,
    });

    token.addGrant(voiceGrant);

    res.json({
      token: token.toJwt(),
    });

  } catch (err) {
    console.error('❌ Token error:', err);
    res.status(500).json({ error: 'Failed to generate token' });
  }
};