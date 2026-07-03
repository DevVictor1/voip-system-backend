const PortingRequest = require('../models/PortingRequest');

const normalizeText = (value) => String(value || '').trim();
const normalizeStatusKey = (value) => normalizeText(value).toLowerCase().replace(/[\s-]+/g, '_');

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
};

const getPayloadValue = (payload, snakeKey, camelKey = null) => (
  payload?.[snakeKey] ?? (camelKey ? payload?.[camelKey] : undefined)
);

const inferEventType = ({ status, portInPhoneNumberSid, phoneNumber }) => {
  const isPhoneEvent = Boolean(portInPhoneNumberSid || phoneNumber);
  const statusKey = normalizeStatusKey(status);

  if (isPhoneEvent) {
    const phoneEvents = {
      waiting_for_signature: 'PortInPhoneNumberWaitingForSignature',
      submitted: 'PortInPhoneNumberSubmitted',
      pending: 'PortInPhoneNumberPending',
      completed: 'PortInPhoneNumberCompleted',
      rejected: 'PortInPhoneNumberRejected',
      canceled: 'PortInPhoneNumberCanceled',
      cancelled: 'PortInPhoneNumberCanceled',
    };
    return phoneEvents[statusKey] || 'PortInPhoneNumberStatusUpdated';
  }

  const requestEvents = {
    waiting_for_signature: 'PortInWaitingForSignature',
    in_progress: 'PortInInProgress',
    completed: 'PortInCompleted',
    action_required: 'PortInActionRequired',
    canceled: 'PortInCanceled',
    cancelled: 'PortInCanceled',
    expired: 'PortInExpired',
    in_review: 'PortInInReview',
  };
  return requestEvents[statusKey] || 'PortInStatusUpdated';
};

const buildDedupeKey = ({ portInRequestSid, portInPhoneNumberSid, phoneNumber, status, lastDateUpdated }) => [
  portInRequestSid,
  portInPhoneNumberSid,
  phoneNumber,
  normalizeStatusKey(status),
  lastDateUpdated ? lastDateUpdated.toISOString() : '',
].join('|');

const isOlderThan = (incomingDate, existingDate) => (
  incomingDate && existingDate && incomingDate.getTime() < new Date(existingDate).getTime()
);

const mapRequestStatus = (status) => {
  const statusKey = normalizeStatusKey(status);
  if (statusKey === 'completed') return 'completed';
  if (statusKey === 'canceled' || statusKey === 'cancelled') return 'cancelled';
  if (statusKey === 'in_progress') return 'porting';
  if (statusKey === 'submitted' || statusKey === 'waiting_for_signature' || statusKey === 'in_review') return 'submitted';
  return null;
};

const shouldApplyInternalStatus = (request, nextStatus, incomingDate) => {
  if (!nextStatus) return false;
  if (request.status === nextStatus) return false;
  if (request.activatedAt) return false;
  if (isOlderThan(incomingDate, request.twilioLastUpdatedAt)) return false;

  const terminalStatuses = new Set(['completed', 'cancelled']);
  if (terminalStatuses.has(request.status) && !terminalStatuses.has(nextStatus)) return false;
  return true;
};

const findPhoneNumberEntry = (request, { portInPhoneNumberSid, phoneNumber }) => {
  const normalizedSid = normalizeText(portInPhoneNumberSid);
  const normalizedPhone = normalizeText(phoneNumber);
  const numbers = Array.isArray(request.phoneNumbers) ? request.phoneNumbers : [];

  if (normalizedSid) {
    const bySid = numbers.find((item) => normalizeText(item.twilioPortInPhoneNumberSid) === normalizedSid);
    if (bySid) return bySid;
  }

  if (normalizedPhone) {
    return numbers.find((item) => normalizeText(item.phoneNumber) === normalizedPhone) || null;
  }

  return null;
};

const buildHistoryDescription = ({ eventType, status, phoneNumber, ignoredReason }) => {
  if (ignoredReason) return `Twilio webhook ignored: ${ignoredReason}`;
  const target = phoneNumber ? ` for ${phoneNumber}` : '';
  return `Twilio update${target}: ${eventType}${status ? ` (${status})` : ''}`;
};

const addStatusHistoryIfMeaningful = (request, { eventType, status, phoneNumber, internalStatusChanged, phoneStatusChanged }) => {
  if (!internalStatusChanged && !phoneStatusChanged) return;

  request.statusHistory.push({
    status: request.status,
    description: buildHistoryDescription({ eventType, status, phoneNumber }),
    actorId: null,
    actorName: 'Twilio',
    createdAt: new Date(),
  });
};

const normalizeWebhookPayload = (payload = {}) => {
  const portInRequestSid = normalizeText(getPayloadValue(payload, 'port_in_request_sid', 'portInRequestSid'));
  const portInPhoneNumberSid = normalizeText(getPayloadValue(payload, 'port_in_phone_number_sid', 'portInPhoneNumberSid'));
  const phoneNumber = normalizeText(getPayloadValue(payload, 'phone_number', 'phoneNumber'));
  const status = normalizeText(getPayloadValue(payload, 'status'));
  const lastDateUpdated = parseDate(getPayloadValue(payload, 'last_date_updated', 'lastDateUpdated'));
  const eventType = normalizeText(getPayloadValue(payload, 'event_type', 'eventType'))
    || inferEventType({ status, portInPhoneNumberSid, phoneNumber });

  return {
    portInRequestSid,
    portInPhoneNumberSid,
    phoneNumber,
    status,
    lastDateUpdated,
    eventType,
    portable: parseBoolean(getPayloadValue(payload, 'portable')),
    notPortableReason: normalizeText(getPayloadValue(payload, 'not_portable_reason', 'notPortableReason')),
    notPortableReasonCode: normalizeText(getPayloadValue(payload, 'not_portable_reason_code', 'notPortableReasonCode')),
    rejectionReason: normalizeText(getPayloadValue(payload, 'rejection_reason', 'rejectionReason')),
    rejectionReasonCode: normalizeText(getPayloadValue(payload, 'rejection_reason_code', 'rejectionReasonCode')),
    orderCancellationReason: normalizeText(getPayloadValue(payload, 'order_cancellation_reason', 'orderCancellationReason')),
    portDate: parseDate(getPayloadValue(payload, 'port_date', 'portDate')),
  };
};

const appendWebhookEvent = (request, event, { processed, ignoredReason }) => {
  request.webhookEvents.push({
    eventType: event.eventType,
    status: event.status,
    portInRequestSid: event.portInRequestSid,
    portInPhoneNumberSid: event.portInPhoneNumberSid,
    phoneNumber: event.phoneNumber,
    dedupeKey: event.dedupeKey,
    lastDateUpdated: event.lastDateUpdated,
    processed,
    ignoredReason: ignoredReason || '',
    payload: event.rawPayload,
    receivedAt: new Date(),
  });
};

const syncPortingWebhookPayload = async (payload = {}) => {
  const normalized = normalizeWebhookPayload(payload);
  if (!normalized.portInRequestSid) {
    return {
      outcome: 'ignored',
      reason: 'Missing port_in_request_sid',
      statusCode: 200,
    };
  }

  const event = {
    ...normalized,
    rawPayload: payload,
    dedupeKey: buildDedupeKey(normalized),
  };

  const request = await PortingRequest.findOne({ twilioPortInRequestSid: event.portInRequestSid });
  if (!request) {
    return {
      outcome: 'unknown_request',
      reason: 'No local PortingRequest matches this Twilio PortIn Request SID',
      portInRequestSid: event.portInRequestSid,
      statusCode: 200,
    };
  }

  const duplicate = (request.webhookEvents || []).some((entry) => normalizeText(entry.dedupeKey) === event.dedupeKey);
  if (duplicate) {
    return {
      outcome: 'duplicate',
      reason: 'Webhook event already processed',
      portingRequestId: String(request._id),
      statusCode: 200,
    };
  }

  let ignoredReason = '';
  let internalStatusChanged = false;
  let phoneStatusChanged = false;
  const isPhoneScopedEvent = Boolean(event.portInPhoneNumberSid || event.phoneNumber);

  if (!isPhoneScopedEvent && isOlderThan(event.lastDateUpdated, request.twilioLastUpdatedAt)) {
    ignoredReason = 'Out-of-order request status update';
    appendWebhookEvent(request, event, { processed: false, ignoredReason });
    await request.save();
    return {
      outcome: 'ignored',
      reason: ignoredReason,
      portingRequestId: String(request._id),
      statusCode: 200,
    };
  }

  if (!isPhoneScopedEvent) {
    const previousTwilioStatus = normalizeText(request.twilioPortInRequestStatus);
    if (event.status && previousTwilioStatus !== event.status) {
      request.twilioPortInRequestStatus = event.status;
      request.twilioLastUpdatedAt = event.lastDateUpdated || new Date();
    }

    if (event.orderCancellationReason) {
      request.orderCancellationReason = event.orderCancellationReason;
    }

    const nextInternalStatus = mapRequestStatus(event.status);
    if (shouldApplyInternalStatus(request, nextInternalStatus, event.lastDateUpdated)) {
      request.status = nextInternalStatus;
      internalStatusChanged = true;
    }
  }

  const phoneEntry = findPhoneNumberEntry(request, event);
  if ((event.portInPhoneNumberSid || event.phoneNumber) && phoneEntry) {
    if (isOlderThan(event.lastDateUpdated, phoneEntry.twilioLastUpdatedAt)) {
      ignoredReason = 'Out-of-order phone number status update';
    } else {
      const previousPhoneStatus = normalizeText(phoneEntry.twilioPortInPhoneNumberStatus);
      if (event.portInPhoneNumberSid && !phoneEntry.twilioPortInPhoneNumberSid) {
        phoneEntry.twilioPortInPhoneNumberSid = event.portInPhoneNumberSid;
        phoneStatusChanged = true;
      }
      if (event.status && previousPhoneStatus !== event.status) {
        phoneEntry.twilioPortInPhoneNumberStatus = event.status;
        phoneEntry.twilioLastUpdatedAt = event.lastDateUpdated || new Date();
        phoneStatusChanged = true;
      }
      if (typeof event.portable === 'boolean') phoneEntry.portable = event.portable;
      if (event.notPortableReason) phoneEntry.notPortableReason = event.notPortableReason;
      if (event.notPortableReasonCode) phoneEntry.notPortableReasonCode = event.notPortableReasonCode;
      if (event.rejectionReason) phoneEntry.rejectionReason = event.rejectionReason;
      if (event.rejectionReasonCode) phoneEntry.rejectionReasonCode = event.rejectionReasonCode;
      if (event.portDate) phoneEntry.portDate = event.portDate;
      request.markModified('phoneNumbers');
    }
  } else if (event.portInPhoneNumberSid || event.phoneNumber) {
    ignoredReason = 'No matching local phone number found for webhook phone update';
  }

  appendWebhookEvent(request, event, { processed: !ignoredReason, ignoredReason });
  if (!ignoredReason) {
    addStatusHistoryIfMeaningful(request, {
      eventType: event.eventType,
      status: event.status,
      phoneNumber: event.phoneNumber,
      internalStatusChanged,
      phoneStatusChanged,
    });
  }

  await request.save();
  return {
    outcome: ignoredReason ? 'ignored' : 'processed',
    reason: ignoredReason,
    portingRequestId: String(request._id),
    internalStatusChanged,
    phoneStatusChanged,
    activatedNumbers: false,
    statusCode: 200,
  };
};

module.exports = {
  syncPortingWebhookPayload,
};
