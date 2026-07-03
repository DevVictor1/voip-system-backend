const {
  getRawBody,
  verifyTwilioWebhookSignature,
} = require('../services/twilioWebhookVerificationService');
const { syncPortingWebhookPayload } = require('../services/portingWebhookSyncService');

const parseJsonBody = (req) => {
  if (req.body && !Buffer.isBuffer(req.body) && typeof req.body === 'object') return req.body;
  const rawBody = getRawBody(req);
  if (!rawBody) return {};
  return JSON.parse(rawBody);
};

exports.receiveTwilioPortInWebhook = async (req, res) => {
  const verification = verifyTwilioWebhookSignature(req);
  if (!verification.valid) {
    console.warn('Twilio PortIn webhook rejected:', {
      reason: verification.reason,
      path: req.originalUrl,
    });
    return res.status(verification.statusCode).json({ error: verification.reason });
  }

  let payload;
  try {
    payload = parseJsonBody(req);
  } catch (error) {
    console.warn('Twilio PortIn webhook invalid JSON:', {
      message: error.message,
      path: req.originalUrl,
    });
    return res.status(400).json({ error: 'Invalid webhook JSON body' });
  }

  try {
    const result = await syncPortingWebhookPayload(payload);
    if (result.outcome === 'unknown_request' || result.outcome === 'duplicate' || result.outcome === 'ignored') {
      console.warn('Twilio PortIn webhook accepted without mutation:', {
        outcome: result.outcome,
        reason: result.reason,
        portInRequestSid: result.portInRequestSid,
        portingRequestId: result.portingRequestId,
      });
    }

    return res.status(200).json({
      received: true,
      outcome: result.outcome,
      activatedNumbers: false,
    });
  } catch (error) {
    console.error('Twilio PortIn webhook sync error:', {
      message: error.message,
      path: req.originalUrl,
    });
    return res.status(500).json({ error: 'Failed to process Twilio PortIn webhook' });
  }
};
