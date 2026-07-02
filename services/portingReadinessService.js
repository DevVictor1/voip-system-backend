const { parsePhoneNumberFromString } = require('libphonenumber-js');

const READINESS_STATUS_READY = 'Ready to Submit';
const READINESS_STATUS_NEEDS_ATTENTION = 'Needs Attention';

const normalizeText = (value) => String(value || '').trim();

const isPresent = (value) => normalizeText(value).length > 0;

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeText(value).toLowerCase());

const isValidE164 = (value) => {
  const phoneNumber = normalizeText(value);
  if (!/^\+[1-9]\d{1,14}$/.test(phoneNumber)) {
    return false;
  }

  const parsed = parsePhoneNumberFromString(phoneNumber);
  return Boolean(parsed?.isValid() && parsed.number === phoneNumber);
};

const buildItem = ({ key, group, label, passed, message, hint = '' }) => ({
  key,
  group,
  label,
  passed: Boolean(passed),
  message,
  hint,
});

const getPhoneNumbers = (request) => (
  Array.isArray(request?.phoneNumbers)
    ? request.phoneNumbers.filter((item) => isPresent(item?.phoneNumber))
    : []
);

const hasClientOrganization = (request) => {
  if (!request?.clientAccountId) return false;
  if (request.clientAccountId?._id) return true;
  return typeof request.clientAccountId === 'string' || typeof request.clientAccountId?.toString === 'function';
};

const hasCompleteServiceAddress = (request) => {
  const address = request?.serviceAddress || {};
  return ['street', 'city', 'state', 'postalCode', 'country'].every((field) => isPresent(address[field]));
};

const hasCompleteAuthorizedSigner = (request) => {
  const signer = request?.authorizedSigner || {};
  return isPresent(signer.name) && isValidEmail(signer.email) && isPresent(signer.phone);
};

const hasTwilioUploadedRecentBill = (request) => (
  Array.isArray(request?.documents)
  && request.documents.some((document) => (
    document?.documentType === 'bill'
    && isPresent(document?.twilioDocumentSid)
  ))
);

const hasRecentBill = (request) => (
  Array.isArray(request?.documents)
  && request.documents.some((document) => document?.documentType === 'bill')
);

const buildPortingReadiness = (request) => {
  const phoneNumbers = getPhoneNumbers(request);
  const notificationEmails = Array.isArray(request?.notificationEmails)
    ? request.notificationEmails
    : [];
  const validNotificationEmails = notificationEmails.filter(isValidEmail);
  const numbersNeedingPin = phoneNumbers.filter((item) => item?.pinAndAccountNumberRequired === true);
  const numbersMissingPin = numbersNeedingPin.filter((item) => (
    !isPresent(item?.pinOrPasscode) && !isPresent(request?.pinOrPasscode)
  ));
  const numbersWithoutPortabilityCheck = phoneNumbers.filter((item) => (
    !item?.portabilityCheckedAt || typeof item?.portable !== 'boolean'
  ));
  const nonPortableNumbers = phoneNumbers.filter((item) => item?.portable !== true);
  const invalidE164Numbers = phoneNumbers.filter((item) => !isValidE164(item?.phoneNumber));

  const checklist = [
    buildItem({
      key: 'client_organization',
      group: 'Organization',
      label: 'Client Organization',
      passed: hasClientOrganization(request),
      message: hasClientOrganization(request)
        ? 'Client organization is selected.'
        : 'Select a client organization for this porting request.',
    }),
    buildItem({
      key: 'customer_type',
      group: 'Organization',
      label: 'Customer Type',
      passed: ['Business', 'Individual'].includes(request?.customerType),
      message: ['Business', 'Individual'].includes(request?.customerType)
        ? 'Customer type is provided.'
        : 'Choose Business or Individual.',
    }),
    buildItem({
      key: 'customer_name',
      group: 'Organization',
      label: 'Customer Name',
      passed: isPresent(request?.customerName),
      message: isPresent(request?.customerName)
        ? 'Customer name is provided.'
        : 'Enter the customer name exactly as it appears with the current carrier.',
    }),
    buildItem({
      key: 'notification_email',
      group: 'Organization',
      label: 'Notification Email',
      passed: validNotificationEmails.length > 0,
      message: validNotificationEmails.length > 0
        ? `${validNotificationEmails.length} notification email${validNotificationEmails.length === 1 ? '' : 's'} ready.`
        : 'Add at least one valid notification email.',
    }),
    buildItem({
      key: 'current_carrier',
      group: 'Carrier Account',
      label: 'Current Carrier',
      passed: isPresent(request?.currentCarrier),
      message: isPresent(request?.currentCarrier)
        ? 'Current carrier is provided.'
        : 'Enter the current carrier, such as RingCentral.',
    }),
    buildItem({
      key: 'billing_telephone_number',
      group: 'Carrier Account',
      label: 'Billing Telephone Number',
      passed: isPresent(request?.billingTelephoneNumber),
      message: isPresent(request?.billingTelephoneNumber)
        ? 'Billing telephone number is provided.'
        : 'Enter the billing telephone number for the current carrier account.',
    }),
    buildItem({
      key: 'account_number',
      group: 'Carrier Account',
      label: 'Account Number',
      passed: isPresent(request?.accountNumber),
      message: isPresent(request?.accountNumber)
        ? 'Account number is provided.'
        : 'Enter the current carrier account number.',
    }),
    buildItem({
      key: 'service_address',
      group: 'Address & Signer',
      label: 'Service Address',
      passed: hasCompleteServiceAddress(request),
      message: hasCompleteServiceAddress(request)
        ? 'Service address is complete.'
        : 'Complete street, city, state, ZIP/postal code, and country.',
    }),
    buildItem({
      key: 'authorized_signer',
      group: 'Address & Signer',
      label: 'Authorized Signer',
      passed: hasCompleteAuthorizedSigner(request),
      message: hasCompleteAuthorizedSigner(request)
        ? 'Authorized signer details are complete.'
        : 'Enter signer name, valid email, and phone number.',
    }),
    buildItem({
      key: 'phone_number_count',
      group: 'Phone Numbers',
      label: 'At Least One Phone Number',
      passed: phoneNumbers.length > 0,
      message: phoneNumbers.length > 0
        ? `${phoneNumbers.length} phone number${phoneNumbers.length === 1 ? '' : 's'} added.`
        : 'Add at least one phone number to port.',
    }),
    buildItem({
      key: 'phone_number_e164',
      group: 'Phone Numbers',
      label: 'E.164 Phone Number Format',
      passed: phoneNumbers.length > 0 && invalidE164Numbers.length === 0,
      message: phoneNumbers.length > 0 && invalidE164Numbers.length === 0
        ? 'All phone numbers use E.164 format.'
        : 'Enter every phone number in E.164 format, for example +12605551234.',
    }),
    buildItem({
      key: 'portability_check_completed',
      group: 'Phone Numbers',
      label: 'Portability Check Completed',
      passed: phoneNumbers.length > 0 && numbersWithoutPortabilityCheck.length === 0,
      message: phoneNumbers.length > 0 && numbersWithoutPortabilityCheck.length === 0
        ? 'Portability has been checked for every number.'
        : 'Run Check Portability for every phone number.',
    }),
    buildItem({
      key: 'numbers_portable',
      group: 'Phone Numbers',
      label: 'Numbers Are Portable',
      passed: phoneNumbers.length > 0 && nonPortableNumbers.length === 0,
      message: phoneNumbers.length > 0 && nonPortableNumbers.length === 0
        ? 'Every checked number is portable.'
        : 'Only portable numbers can be submitted to Twilio.',
    }),
    buildItem({
      key: 'pin_if_required',
      group: 'Phone Numbers',
      label: 'PIN If Required',
      passed: numbersMissingPin.length === 0,
      message: numbersMissingPin.length === 0
        ? 'Required PIN/passcode information is available.'
        : 'Add a PIN/passcode for numbers where Twilio indicates it is required.',
    }),
    buildItem({
      key: 'recent_bill_exists',
      group: 'Documents',
      label: 'Recent Bill Exists',
      passed: hasRecentBill(request),
      message: hasRecentBill(request)
        ? 'A Recent Bill document is attached.'
        : 'Upload a Recent Bill before submitting.',
    }),
    buildItem({
      key: 'recent_bill_twilio_sid',
      group: 'Documents',
      label: 'Recent Bill Uploaded to Twilio',
      passed: hasTwilioUploadedRecentBill(request),
      message: hasTwilioUploadedRecentBill(request)
        ? 'A Recent Bill has been uploaded to Twilio.'
        : 'Upload a Recent Bill to Twilio before submitting.',
      hint: 'Use the Upload to Twilio action on an eligible Recent Bill document.',
    }),
  ];

  const passedCount = checklist.filter((item) => item.passed).length;
  const ready = checklist.length > 0 && passedCount === checklist.length;

  return {
    ready,
    status: ready ? READINESS_STATUS_READY : READINESS_STATUS_NEEDS_ATTENTION,
    passedCount,
    totalCount: checklist.length,
    checklist,
  };
};

module.exports = {
  READINESS_STATUS_NEEDS_ATTENTION,
  READINESS_STATUS_READY,
  buildPortingReadiness,
};
