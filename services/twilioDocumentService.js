const fs = require('fs/promises');
const https = require('https');
const path = require('path');

const TWILIO_DOCUMENT_HOST = 'numbers-upload.twilio.com';
const TWILIO_DOCUMENT_PATH = '/v1/Documents';
const MAX_TWILIO_DOCUMENT_SIZE = 10 * 1024 * 1024;
const TWILIO_PORTING_DOCUMENT_TYPE = 'utility_bill';
const TWILIO_SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

const normalizeText = (value) => String(value || '').trim();

const getTwilioCredentials = () => {
  const accountSid = normalizeText(process.env.TWILIO_ACCOUNT_SID);
  const apiKey = normalizeText(process.env.TWILIO_API_KEY);
  const apiSecret = normalizeText(process.env.TWILIO_API_SECRET);

  if (!accountSid || !apiKey || !apiSecret) {
    const error = new Error('Missing Twilio document upload credentials');
    error.code = 'TWILIO_DOCUMENT_CONFIG_MISSING';
    throw error;
  }

  return { accountSid, apiKey, apiSecret };
};

const escapeMultipartValue = (value) => normalizeText(value).replace(/"/g, '\\"');

const buildMultipartBody = ({ fileBuffer, fileName, mimeType, friendlyName }) => {
  const boundary = `----KayladTwilioDocument${Date.now()}${Math.random().toString(16).slice(2)}`;
  const chunks = [];

  const appendField = (name, value) => {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${name}"\r\n\r\n`
      + `${value}\r\n`
    ));
  };

  appendField('document_type', TWILIO_PORTING_DOCUMENT_TYPE);
  if (friendlyName) {
    appendField('friendly_name', friendlyName);
  }

  chunks.push(Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="File"; filename="${escapeMultipartValue(fileName)}"\r\n`
    + `Content-Type: ${mimeType}\r\n\r\n`
  ));
  chunks.push(fileBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    boundary,
  };
};

const parseTwilioResponse = (body) => {
  try {
    return body ? JSON.parse(body) : {};
  } catch (error) {
    return { message: 'Twilio returned a non-JSON response' };
  }
};

const classifyTwilioUploadError = (statusCode, payload = {}) => {
  const twilioCode = normalizeText(payload.code);
  const twilioMessage = normalizeText(payload.message || payload.error || payload.failure_reason);

  if (statusCode === 401 || twilioCode === '20003') {
    return {
      status: 'authentication_error',
      message: twilioMessage || 'Twilio authentication failed. Check TWILIO_ACCOUNT_SID, TWILIO_API_KEY, and TWILIO_API_SECRET.',
      httpStatus: statusCode,
      twilioCode,
      twilioMessage,
    };
  }

  if (statusCode === 403 || twilioCode === '20403') {
    return {
      status: 'permission_error',
      message: twilioMessage || 'Twilio account does not have permission to upload Phone Number documents.',
      httpStatus: statusCode,
      twilioCode,
      twilioMessage,
    };
  }

  return {
    status: statusCode >= 500 ? 'twilio_unavailable' : 'twilio_error',
    message: twilioMessage || 'Twilio Documents API returned an error.',
    httpStatus: statusCode,
    twilioCode,
    twilioMessage,
  };
};

const postMultipartToTwilio = ({ apiKey, apiSecret, body, boundary }) => new Promise((resolve, reject) => {
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const request = https.request(
    {
      hostname: TWILIO_DOCUMENT_HOST,
      method: 'POST',
      path: TWILIO_DOCUMENT_PATH,
      timeout: 30000,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    },
    (response) => {
      let responseBody = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        const payload = parseTwilioResponse(responseBody);
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ statusCode: response.statusCode, payload });
          return;
        }

        const classified = classifyTwilioUploadError(response.statusCode, payload);
        const error = new Error(classified.message);
        error.details = classified;
        reject(error);
      });
    }
  );

  request.on('timeout', () => {
    request.destroy(new Error('Twilio document upload request timed out'));
  });
  request.on('error', reject);
  request.write(body);
  request.end();
});

const resolveSafeUploadPath = (storagePath) => {
  const uploadsRoot = path.resolve(process.cwd(), 'uploads');
  const resolvedPath = path.resolve(uploadsRoot, normalizeText(storagePath));

  if (!resolvedPath.startsWith(`${uploadsRoot}${path.sep}`)) {
    const error = new Error('Stored document path is invalid');
    error.code = 'INVALID_DOCUMENT_PATH';
    throw error;
  }

  return resolvedPath;
};

const uploadUtilityBillDocument = async ({ storagePath, fileName, mimeType, fileSize, friendlyName }) => {
  const normalizedMimeType = normalizeText(mimeType).toLowerCase();
  if (!TWILIO_SUPPORTED_MIME_TYPES.has(normalizedMimeType)) {
    const error = new Error('Twilio upload supports only PDF, JPG, JPEG, or PNG Recent Bill documents');
    error.code = 'UNSUPPORTED_TWILIO_DOCUMENT_TYPE';
    throw error;
  }

  if (Number(fileSize || 0) <= 0 || Number(fileSize || 0) > MAX_TWILIO_DOCUMENT_SIZE) {
    const error = new Error('Twilio document must be 10 MB or smaller');
    error.code = 'TWILIO_DOCUMENT_TOO_LARGE';
    throw error;
  }

  const { apiKey, apiSecret } = getTwilioCredentials();
  const filePath = resolveSafeUploadPath(storagePath);
  const fileBuffer = await fs.readFile(filePath);

  if (fileBuffer.length > MAX_TWILIO_DOCUMENT_SIZE) {
    const error = new Error('Twilio document must be 10 MB or smaller');
    error.code = 'TWILIO_DOCUMENT_TOO_LARGE';
    throw error;
  }

  const multipart = buildMultipartBody({
    fileBuffer,
    fileName: fileName || 'utility-bill',
    mimeType: normalizedMimeType,
    friendlyName,
  });
  const { payload } = await postMultipartToTwilio({
    apiKey,
    apiSecret,
    body: multipart.body,
    boundary: multipart.boundary,
  });

  if (!payload?.sid) {
    const error = new Error('Twilio did not return a document SID');
    error.details = {
      status: 'twilio_error',
      message: 'Twilio did not return a document SID',
      twilioCode: normalizeText(payload?.code),
      twilioMessage: normalizeText(payload?.message || payload?.failure_reason),
      httpStatus: null,
    };
    throw error;
  }

  return {
    sid: payload.sid,
    documentType: payload.document_type || TWILIO_PORTING_DOCUMENT_TYPE,
    status: payload.status || '',
    mimeType: payload.mime_type || normalizedMimeType,
    friendlyName: payload.friendly_name || friendlyName || '',
    failureReason: payload.failure_reason || '',
  };
};

module.exports = {
  TWILIO_PORTING_DOCUMENT_TYPE,
  TWILIO_SUPPORTED_MIME_TYPES,
  uploadUtilityBillDocument,
};
