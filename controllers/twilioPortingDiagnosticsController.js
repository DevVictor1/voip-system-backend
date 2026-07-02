const https = require('https');

const PORTING_LIST_PATH = '/v1/Porting/PortIn/PortInRequests?Size=1';

const buildDiagnosticResult = ({ status, payload, reachedTwilio }) => {
  const twilioCode = payload?.code || payload?.error_code || null;
  const twilioMessage = payload?.message || payload?.error || '';

  if (status >= 200 && status < 300) {
    return {
      status: 'accessible',
      portingApiAccessible: true,
      accountHasPortingApiAccess: true,
      message: 'Twilio Porting API is accessible for this account.',
      reachedTwilio,
      httpStatus: status,
      twilioCode,
      twilioMessage,
    };
  }

  if (status === 401 || twilioCode === 20003) {
    return {
      status: 'authentication_failure',
      portingApiAccessible: false,
      accountHasPortingApiAccess: false,
      message: 'Twilio authentication failed. Check TWILIO_ACCOUNT_SID, TWILIO_API_KEY, and TWILIO_API_SECRET.',
      reachedTwilio,
      httpStatus: status,
      twilioCode,
      twilioMessage,
    };
  }

  if (status === 403 || twilioCode === 20403) {
    return {
      status: 'permission_denied',
      portingApiAccessible: false,
      accountHasPortingApiAccess: false,
      message: 'Twilio responded, but this account does not appear to have Porting API permission.',
      reachedTwilio,
      httpStatus: status,
      twilioCode,
      twilioMessage,
    };
  }

  if (status >= 500) {
    return {
      status: 'api_unavailable',
      portingApiAccessible: false,
      accountHasPortingApiAccess: null,
      message: 'Twilio Porting API returned a server error. Try again later before changing integration logic.',
      reachedTwilio,
      httpStatus: status,
      twilioCode,
      twilioMessage,
    };
  }

  return {
    status: 'unexpected_response',
    portingApiAccessible: false,
    accountHasPortingApiAccess: null,
    message: 'Twilio returned an unexpected response from the read-only Porting API diagnostic request.',
    reachedTwilio,
    httpStatus: status,
    twilioCode,
    twilioMessage,
  };
};

const requestTwilioPortingList = ({ accountSid, apiKey, apiSecret }) => new Promise((resolve, reject) => {
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const request = https.request(
    {
      hostname: 'numbers.twilio.com',
      method: 'GET',
      path: PORTING_LIST_PATH,
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
        let payload = null;
        try {
          payload = body ? JSON.parse(body) : null;
        } catch (error) {
          payload = { message: 'Twilio returned a non-JSON response' };
        }

        resolve({
          accountSid,
          status: response.statusCode,
          payload,
        });
      });
    }
  );

  request.on('timeout', () => {
    request.destroy(new Error('Twilio Porting API diagnostic request timed out'));
  });
  request.on('error', reject);
  request.end();
});

exports.testTwilioPortingConnectivity = async (req, res) => {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const apiKey = String(process.env.TWILIO_API_KEY || '').trim();
  const apiSecret = String(process.env.TWILIO_API_SECRET || '').trim();

  if (!accountSid || !apiKey || !apiSecret) {
    return res.status(500).json({
      status: 'configuration_error',
      portingApiAccessible: false,
      accountHasPortingApiAccess: null,
      reachedTwilio: false,
      httpStatus: null,
      message: 'Missing Twilio configuration. Required variables: TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET.',
      createdOrModifiedTwilioData: false,
      request: {
        method: 'GET',
        host: 'numbers.twilio.com',
        path: PORTING_LIST_PATH,
        readOnly: true,
      },
    });
  }

  try {
    const result = await requestTwilioPortingList({ accountSid, apiKey, apiSecret });
    const diagnostic = buildDiagnosticResult({
      status: result.status,
      payload: result.payload,
      reachedTwilio: true,
    });

    console.info('Twilio Porting API diagnostic completed', {
      status: diagnostic.status,
      httpStatus: diagnostic.httpStatus,
      twilioCode: diagnostic.twilioCode,
      accountSidSuffix: accountSid.slice(-6),
      actorId: req.user?._id ? String(req.user._id) : null,
    });

    return res.status(diagnostic.httpStatus && diagnostic.httpStatus >= 500 ? 502 : 200).json({
      ...diagnostic,
      createdOrModifiedTwilioData: false,
      request: {
        method: 'GET',
        host: 'numbers.twilio.com',
        path: PORTING_LIST_PATH,
        readOnly: true,
      },
    });
  } catch (error) {
    console.warn('Twilio Porting API diagnostic network/configuration error', {
      message: error.message,
      accountSidSuffix: accountSid.slice(-6),
      actorId: req.user?._id ? String(req.user._id) : null,
    });

    return res.status(502).json({
      status: 'network_or_configuration_error',
      portingApiAccessible: false,
      accountHasPortingApiAccess: null,
      reachedTwilio: false,
      httpStatus: null,
      twilioCode: null,
      twilioMessage: error.message,
      message: 'Could not reach Twilio Porting API with the configured credentials.',
      createdOrModifiedTwilioData: false,
      request: {
        method: 'GET',
        host: 'numbers.twilio.com',
        path: PORTING_LIST_PATH,
        readOnly: true,
      },
    });
  }
};
