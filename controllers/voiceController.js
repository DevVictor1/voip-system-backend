const AccessToken = require('twilio').jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const normalizeEnvValue = (value) => String(value || '').trim();

exports.generateToken = (req, res) => {
  try {
    const identity = req.query.userId || 'web_user';
    const env = {
      accountSid: normalizeEnvValue(process.env.TWILIO_ACCOUNT_SID),
      apiKey: normalizeEnvValue(process.env.TWILIO_API_KEY),
      apiSecret: normalizeEnvValue(process.env.TWILIO_API_SECRET),
      twimlAppSid: normalizeEnvValue(process.env.TWILIO_TWIML_APP_SID),
    };

    const token = new AccessToken(
      env.accountSid,
      env.apiKey,
      env.apiSecret,
      { identity }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: env.twimlAppSid,
      incomingAllow: true,
    });

    token.addGrant(voiceGrant);

    const jwt = token.toJwt();

    res.json({
      token: jwt,
    });
  } catch (err) {
    console.error('Token error:', err);
    res.status(500).json({ error: 'Failed to generate token' });
  }
};
