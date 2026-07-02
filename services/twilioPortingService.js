const https = require('https');

const TWILIO_PORTABILITY_HOST = 'numbers.twilio.com';
const TWILIO_PORTABILITY_PATH_PREFIX = '/v1/Porting/Portability/PhoneNumber/';

const normalizeTwilioText = (value) => String(value || '').trim();

const getTwilioPortingCredentials = () => {
  const accountSid = normalizeTwilioText(process.env.TWILIO_ACCOUNT_SID);
  const apiKey = normalizeTwilioText(process.env.TWILIO_API_KEY);
  const apiSecret = normalizeTwilioText(process.env.TWILIO_API_SECRET);

  if (!accountSid || !apiKey || !apiSecret) {
    const error = new Error('Missing Twilio porting credentials');
    error.code = 'TWILIO_PORTING_CONFIG_MISSING';
    throw error;
  }

  return { accountSid, apiKey, apiSecret };
};

const normalizePortabilityPayload = (phoneNumber, payload = {}, statusCode = 200) => {
  const portable = typeof payload.portable === 'boolean' ? payload.portable : false;
  const notPortableReason = normalizeTwilioText(payload.not_portable_reason || payload.notPortableReason || payload.message);
  const notPortableReasonCode = normalizeTwilioText(payload.not_portable_reason_code || payload.notPortableReasonCode || payload.code);
  const numberType = normalizeTwilioText(payload.number_type || payload.numberType);

  return {
    phoneNumber: normalizeTwilioText(payload.phone_number || payload.phoneNumber || phoneNumber),
    portable,
    portabilityStatus: portable ? 'portable' : 'not_portable',
    portabilityCheckedAt: new Date(),
    notPortableReason,
    notPortableReasonCode,
    numberType,
    country: normalizeTwilioText(payload.country),
    pinAndAccountNumberRequired: typeof payload.pin_and_account_number_required === 'boolean'
      ? payload.pin_and_account_number_required
      : null,
    accountSid: normalizeTwilioText(payload.account_sid || payload.accountSid),
    twilioHttpStatus: statusCode,
    twilioCode: normalizeTwilioText(payload.code),
    twilioMessage: normalizeTwilioText(payload.message),
  };
};

const classifyTwilioError = (statusCode, payload = {}) => {
  const twilioCode = normalizeTwilioText(payload.code);
  const twilioMessage = normalizeTwilioText(payload.message || payload.error);

  if (statusCode === 401 || twilioCode === '20003') {
    return {
      status: 'authentication_error',
      message: twilioMessage || 'Twilio authentication failed. Check TWILIO_ACCOUNT_SID, TWILIO_API_KEY, and TWILIO_API_SECRET.',
      twilioCode,
      twilioMessage,
      httpStatus: statusCode,
    };
  }

  if (statusCode === 403 || twilioCode === '20403') {
    return {
      status: 'permission_error',
      message: twilioMessage || 'Twilio account does not have access to the Portability API.',
      twilioCode,
      twilioMessage,
      httpStatus: statusCode,
    };
  }

  if (statusCode >= 500) {
    return {
      status: 'twilio_unavailable',
      message: twilioMessage || 'Twilio Portability API is temporarily unavailable.',
      twilioCode,
      twilioMessage,
      httpStatus: statusCode,
    };
  }

  return {
    status: 'twilio_error',
    message: twilioMessage || 'Twilio Portability API returned an unexpected response.',
    twilioCode,
    twilioMessage,
    httpStatus: statusCode,
  };
};

const requestJson = ({ path, apiKey, apiSecret }) => new Promise((resolve, reject) => {
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const request = https.request(
    {
      hostname: TWILIO_PORTABILITY_HOST,
      method: 'GET',
      path,
      timeout: 15000,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    },
    (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch (error) {
          payload = { message: 'Twilio returned a non-JSON response' };
        }

        resolve({ statusCode: response.statusCode, payload });
      });
    }
  );

  request.on('timeout', () => {
    request.destroy(new Error('Twilio Portability API request timed out'));
  });
  request.on('error', reject);
  request.end();
});

const checkPhoneNumberPortability = async (phoneNumber) => {
  const normalizedPhoneNumber = normalizeTwilioText(phoneNumber);
  if (!normalizedPhoneNumber) {
    const error = new Error('Phone number is required');
    error.code = 'PHONE_NUMBER_REQUIRED';
    throw error;
  }

  const { accountSid, apiKey, apiSecret } = getTwilioPortingCredentials();
  const query = `?TargetAccountSid=${encodeURIComponent(accountSid)}`;
  const path = `${TWILIO_PORTABILITY_PATH_PREFIX}${encodeURIComponent(normalizedPhoneNumber)}${query}`;
  const { statusCode, payload } = await requestJson({ path, apiKey, apiSecret });

  if (statusCode >= 200 && statusCode < 300) {
    return normalizePortabilityPayload(normalizedPhoneNumber, payload, statusCode);
  }

  if (statusCode === 400) {
    return normalizePortabilityPayload(normalizedPhoneNumber, payload, statusCode);
  }

  const classified = classifyTwilioError(statusCode, payload);
  const error = new Error(classified.message);
  error.details = classified;
  throw error;
};

module.exports = {
  checkPhoneNumberPortability,
};
