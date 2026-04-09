const twilio = require('twilio');

exports.getToken = (req, res) => {
  try {
    const identity = 'user_' + Date.now();

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { identity }
    );

    token.addGrant(
      new VoiceGrant({
        outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
        incomingAllow: true,
      })
    );

    res.json({
      token: token.toJwt(),
      identity,
    });

  } catch (err) {
    console.error('âŒ Token error:', err);
    res.status(500).json({ error: 'Failed to generate token' });
  }
};
