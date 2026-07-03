const twilio = require('twilio');

const normalizeText = (value) => String(value || '').trim();

const getRequestUrl = (req) => {
  const configuredBaseUrl = normalizeText(process.env.PUBLIC_WEBHOOK_BASE_URL || process.env.PUBLIC_BASE_URL);
  if (configuredBaseUrl) {
    return `${configuredBaseUrl.replace(/\/$/, '')}${req.originalUrl}`;
  }

  const forwardedProto = normalizeText(req.headers['x-forwarded-proto']).split(',')[0];
  const forwardedHost = normalizeText(req.headers['x-forwarded-host']).split(',')[0];
  const protocol = forwardedProto || req.protocol || 'https';
  const host = forwardedHost || req.get('host');
  return `${protocol}://${host}${req.originalUrl}`;
};

const getRawBody = (req) => {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (req.rawBody) return Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody);
  return JSON.stringify(req.body || {});
};

const verifyTwilioWebhookSignature = (req) => {
  const authToken = normalizeText(process.env.TWILIO_AUTH_TOKEN);
  if (!authToken) {
    return {
      valid: false,
      reason: 'TWILIO_AUTH_TOKEN is not configured',
      statusCode: 500,
    };
  }

  const signature = normalizeText(req.headers['x-twilio-signature']);
  if (!signature) {
    return {
      valid: false,
      reason: 'Missing X-Twilio-Signature header',
      statusCode: 403,
    };
  }

  const url = getRequestUrl(req);
  const rawBody = getRawBody(req);
  const valid = twilio.validateRequestWithBody(authToken, signature, url, rawBody);

  return {
    valid,
    reason: valid ? '' : 'Invalid Twilio signature',
    statusCode: valid ? 200 : 403,
    url,
  };
};

module.exports = {
  getRawBody,
  verifyTwilioWebhookSignature,
};
