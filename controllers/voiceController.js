const AccessToken = require('twilio').jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const normalizeEnvValue = (value) => String(value || '').trim();

const describeSid = (value) => {
  const normalized = normalizeEnvValue(value);
  return {
    prefix: normalized.slice(0, 2) || 'missing',
    length: normalized.length,
  };
};

const decodeJwtPart = (token, index) => {
  try {
    const part = String(token || '').split('.')[index];
    if (!part) return null;

    const padded = part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=');
    const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch (error) {
    return { decodeError: error.message };
  }
};

const logVoiceTokenDiagnostic = ({ token, identity, env }) => {
  const header = decodeJwtPart(token, 0);
  const payload = decodeJwtPart(token, 1);
  const voiceGrant = payload?.grants?.voice || {};
  const redactedPayload = payload
    ? {
        iss: describeSid(payload.iss),
        sub: describeSid(payload.sub),
        exp: payload.exp,
        jti: typeof payload.jti === 'string' ? `${payload.jti.slice(0, 8)}...` : payload.jti,
        grants: {
          identity: payload.grants?.identity,
          voice: {
            incoming: voiceGrant.incoming,
            outgoing: {
              application_sid: describeSid(voiceGrant.outgoing?.application_sid),
            },
          },
        },
        identity,
      }
    : null;

  console.log('Twilio Voice token diagnostic:', {
    env: {
      accountSid: describeSid(env.accountSid),
      apiKey: describeSid(env.apiKey),
      apiSecret: { length: normalizeEnvValue(env.apiSecret).length },
      twimlAppSid: describeSid(env.twimlAppSid),
    },
    token: {
      header,
      payload: redactedPayload,
    },
  });
};

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
    logVoiceTokenDiagnostic({ token: jwt, identity, env });

    res.json({
      token: jwt,
    });
  } catch (err) {
    console.error('Token error:', err);
    res.status(500).json({ error: 'Failed to generate token' });
  }
};
