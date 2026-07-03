const https = require('https');

const TWILIO_PORTING_HOST = 'numbers.twilio.com';
const TWILIO_PORTABILITY_PATH_PREFIX = '/v1/Porting/Portability/PhoneNumber/';
const TWILIO_PORTIN_PATH = '/v1/Porting/PortIn';

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

const classifyTwilioError = (statusCode, payload = {}, resourceName = 'Twilio Porting API') => {
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
      message: twilioMessage || `Twilio account does not have access to the ${resourceName}.`,
      twilioCode,
      twilioMessage,
      httpStatus: statusCode,
    };
  }

  if (statusCode >= 500) {
    return {
      status: 'twilio_unavailable',
      message: twilioMessage || `${resourceName} is temporarily unavailable.`,
      twilioCode,
      twilioMessage,
      httpStatus: statusCode,
    };
  }

  return {
    status: 'twilio_error',
    message: twilioMessage || `${resourceName} returned an unexpected response.`,
    twilioCode,
    twilioMessage,
    httpStatus: statusCode,
  };
};

const parseTwilioJson = (body) => {
  try {
    return body ? JSON.parse(body) : {};
  } catch (error) {
    return { message: 'Twilio returned a non-JSON response' };
  }
};

const requestJson = ({
  path,
  apiKey,
  apiSecret,
  method = 'GET',
  body = null,
  resourceName = 'Twilio Porting API',
  resolveHttpErrors = false,
}) => new Promise((resolve, reject) => {
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const requestBody = body ? JSON.stringify(body) : null;
  const request = https.request(
    {
      hostname: TWILIO_PORTING_HOST,
      method,
      path,
      timeout: 15000,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        ...(requestBody ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        } : {}),
      },
    },
    (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        const payload = parseTwilioJson(body);

        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ statusCode: response.statusCode, payload });
          return;
        }

        if (resolveHttpErrors) {
          resolve({ statusCode: response.statusCode, payload });
          return;
        }

        const classified = classifyTwilioError(response.statusCode, payload, resourceName);
        const error = new Error(classified.message);
        error.details = classified;
        reject(error);
      });
    }
  );

  request.on('timeout', () => {
    request.destroy(new Error('Twilio Portability API request timed out'));
  });
  request.on('error', reject);
  if (requestBody) {
    request.write(requestBody);
  }
  request.end();
});

const formatDateOnly = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
};

const removeEmptyFields = (value) => {
  if (Array.isArray(value)) {
    return value
      .map(removeEmptyFields)
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((cleaned, [key, item]) => {
      const nextValue = removeEmptyFields(item);
      if (nextValue !== undefined) {
        cleaned[key] = nextValue;
      }
      return cleaned;
    }, {});
  }

  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  return value;
};

const getUtilityBillDocumentSids = (request) => (
  Array.isArray(request?.documents)
    ? request.documents
      .filter((document) => document?.documentType === 'bill' && normalizeTwilioText(document?.twilioDocumentSid))
      .map((document) => normalizeTwilioText(document.twilioDocumentSid))
    : []
);

const buildTwilioPortInPayload = (request, accountSid) => {
  const serviceAddress = request?.serviceAddress || {};
  const authorizedSigner = request?.authorizedSigner || {};
  const payload = {
    account_sid: accountSid,
    notification_emails: Array.isArray(request?.notificationEmails) ? request.notificationEmails : [],
    losing_carrier_information: {
      customer_type: normalizeTwilioText(request?.customerType),
      customer_name: normalizeTwilioText(request?.customerName),
      account_number: normalizeTwilioText(request?.accountNumber),
      account_telephone_number: normalizeTwilioText(request?.billingTelephoneNumber),
      authorized_representative: normalizeTwilioText(authorizedSigner.name),
      authorized_representative_email: normalizeTwilioText(authorizedSigner.email),
      address: {
        street: normalizeTwilioText(serviceAddress.street),
        street_2: normalizeTwilioText(serviceAddress.street2),
        city: normalizeTwilioText(serviceAddress.city),
        state: normalizeTwilioText(serviceAddress.state),
        zip: normalizeTwilioText(serviceAddress.postalCode),
        country: normalizeTwilioText(serviceAddress.country) || 'US',
      },
    },
    phone_numbers: (Array.isArray(request?.phoneNumbers) ? request.phoneNumbers : [])
      .filter((item) => normalizeTwilioText(item?.phoneNumber))
      .map((item) => ({
        phone_number: normalizeTwilioText(item.phoneNumber),
        pin: normalizeTwilioText(item.pinOrPasscode || request?.pinOrPasscode),
      })),
    documents: getUtilityBillDocumentSids(request),
  };

  const targetPortInDate = formatDateOnly(request?.desiredPortDate);
  if (targetPortInDate) {
    payload.target_port_in_date = targetPortInDate;
  }

  if (normalizeTwilioText(request?.targetPortInTimeRangeStart)) {
    payload.target_port_in_time_range_start = normalizeTwilioText(request.targetPortInTimeRangeStart);
  }

  if (normalizeTwilioText(request?.targetPortInTimeRangeEnd)) {
    payload.target_port_in_time_range_end = normalizeTwilioText(request.targetPortInTimeRangeEnd);
  }

  return removeEmptyFields(payload);
};

const normalizePortInSubmissionPayload = (payload = {}, statusCode = 200) => ({
  accountSid: normalizeTwilioText(payload.account_sid || payload.accountSid),
  targetPortInDate: normalizeTwilioText(payload.target_port_in_date || payload.targetPortInDate),
  targetPortInTimeRangeStart: normalizeTwilioText(payload.target_port_in_time_range_start || payload.targetPortInTimeRangeStart),
  targetPortInTimeRangeEnd: normalizeTwilioText(payload.target_port_in_time_range_end || payload.targetPortInTimeRangeEnd),
  portInRequestSid: normalizeTwilioText(payload.port_in_request_sid || payload.portInRequestSid),
  portInRequestStatus: normalizeTwilioText(payload.port_in_request_status || payload.portInRequestStatus),
  supportTicketId: normalizeTwilioText(payload.support_ticket_id || payload.supportTicketId),
  signatureRequestUrl: normalizeTwilioText(payload.signature_request_url || payload.signatureRequestUrl),
  phoneNumbers: Array.isArray(payload.phone_numbers || payload.phoneNumbers)
    ? (payload.phone_numbers || payload.phoneNumbers).map((item) => ({
      phoneNumber: normalizeTwilioText(item.phone_number || item.phoneNumber),
      portable: typeof item.portable === 'boolean' ? item.portable : null,
      portInPhoneNumberSid: normalizeTwilioText(item.port_in_phone_number_sid || item.portInPhoneNumberSid),
      portInPhoneNumberStatus: normalizeTwilioText(item.port_in_phone_number_status || item.portInPhoneNumberStatus),
      notPortabilityReason: normalizeTwilioText(item.not_portability_reason || item.notPortabilityReason),
      notPortabilityReasonCode: normalizeTwilioText(item.not_portability_reason_code || item.notPortabilityReasonCode),
      rejectionReason: normalizeTwilioText(item.rejection_reason || item.rejectionReason),
      rejectionReasonCode: normalizeTwilioText(item.rejection_reason_code || item.rejectionReasonCode),
    }))
    : [],
  documents: Array.isArray(payload.documents) ? payload.documents.map(normalizeTwilioText).filter(Boolean) : [],
  twilioHttpStatus: statusCode,
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
  const { statusCode, payload } = await requestJson({
    path,
    apiKey,
    apiSecret,
    resourceName: 'Twilio Portability API',
    resolveHttpErrors: true,
  });

  if (statusCode >= 200 && statusCode < 300) {
    return normalizePortabilityPayload(normalizedPhoneNumber, payload, statusCode);
  }

  if (statusCode === 400) {
    return normalizePortabilityPayload(normalizedPhoneNumber, payload, statusCode);
  }

  const classified = classifyTwilioError(statusCode, payload, 'Twilio Portability API');
  const error = new Error(classified.message);
  error.details = classified;
  throw error;
};

const submitPortInRequest = async (request) => {
  const { accountSid, apiKey, apiSecret } = getTwilioPortingCredentials();
  const body = buildTwilioPortInPayload(request, accountSid);
  const { statusCode, payload } = await requestJson({
    path: TWILIO_PORTIN_PATH,
    apiKey,
    apiSecret,
    method: 'POST',
    body,
    resourceName: 'Twilio PortIn API',
  });

  const result = normalizePortInSubmissionPayload(payload, statusCode);
  if (!result.portInRequestSid) {
    const error = new Error('Twilio did not return a PortIn Request SID');
    error.details = {
      status: 'twilio_error',
      message: 'Twilio did not return a PortIn Request SID',
      twilioCode: normalizeTwilioText(payload?.code),
      twilioMessage: normalizeTwilioText(payload?.message),
      httpStatus: statusCode,
    };
    throw error;
  }

  return {
    result,
    submittedPayload: body,
  };
};

module.exports = {
  buildTwilioPortInPayload,
  checkPhoneNumberPortability,
  submitPortInRequest,
};
