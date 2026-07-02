const path = require('path');
const mongoose = require('mongoose');
const ClientAccount = require('../models/ClientAccount');
const ClientPhoneNumber = require('../models/ClientPhoneNumber');
const PortingRequest = require('../models/PortingRequest');
const User = require('../models/User');
const { checkPhoneNumberPortability } = require('../services/twilioPortingService');
const { syncClientAccountAssignedNumbers } = require('../utils/clientNumberOwnership');

const PORTING_STATUSES = new Set(['draft', 'review', 'submitted', 'scheduled', 'porting', 'completed', 'rejected', 'cancelled']);
const DOCUMENT_TYPES = new Set(['loa', 'bill', 'csr', 'other']);

const normalizeTrimmedText = (value) => String(value || '').trim();

const normalizeStringList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTrimmedText(item)).filter(Boolean);
  }

  return normalizeTrimmedText(value)
    .split(',')
    .map((item) => normalizeTrimmedText(item))
    .filter(Boolean);
};

const normalizeCustomerType = (value) => {
  const normalized = normalizeTrimmedText(value).toLowerCase();
  if (normalized === 'business') return 'Business';
  if (normalized === 'individual') return 'Individual';
  return '';
};

const normalizeOptionalObjectId = (value) => {
  const trimmed = normalizeTrimmedText(value);
  if (!trimmed) return null;
  return mongoose.Types.ObjectId.isValid(trimmed) ? trimmed : '__invalid__';
};

const normalizeBooleanCapabilities = (value) => {
  if (Array.isArray(value)) {
    const values = new Set(value.map((item) => normalizeTrimmedText(item).toLowerCase()));
    return {
      voice: values.has('voice'),
      sms: values.has('sms'),
      mms: values.has('mms'),
    };
  }

  if (value && typeof value === 'object') {
    return {
      voice: Boolean(value.voice),
      sms: Boolean(value.sms),
      mms: Boolean(value.mms),
    };
  }

  const text = normalizeTrimmedText(value).toLowerCase();
  return {
    voice: !text || text.includes('voice'),
    sms: text.includes('sms') || text.includes('messaging'),
    mms: text.includes('mms'),
  };
};

const normalizeStatus = (value, fallback = 'draft') => {
  const normalized = normalizeTrimmedText(value).toLowerCase();
  return PORTING_STATUSES.has(normalized) ? normalized : fallback;
};

const normalizeDocumentType = (value) => {
  const normalized = normalizeTrimmedText(value).toLowerCase();
  return DOCUMENT_TYPES.has(normalized) ? normalized : 'other';
};

const normalizeDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getActorName = (user) => user?.name || user?.email || 'Admin';

const ACTIVATION_COMPLETED_ERROR = {
  title: 'Activation Already Completed',
  message: 'This porting request has already been activated.\nTo change the workflow, first archive or deactivate the activated client phone numbers if appropriate.\nThe request will remain in Completed status.',
};

const sendActivationCompletedError = (res) => res.status(409).json({
  error: ACTIVATION_COMPLETED_ERROR.title,
  ...ACTIVATION_COMPLETED_ERROR,
});

const buildStatusEntry = (status, description, user) => ({
  status,
  description: normalizeTrimmedText(description),
  actorId: user?._id || null,
  actorName: getActorName(user),
  createdAt: new Date(),
});

const sanitizePhoneNumbers = async (items = [], clientAccountId) => {
  if (!Array.isArray(items)) return { phoneNumbers: [] };

  const phoneNumbers = [];
  const seen = new Set();

  for (const item of items) {
    const phoneNumber = normalizeTrimmedText(item?.phoneNumber);
    if (!phoneNumber) continue;

    const key = phoneNumber.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const assignedUserId = normalizeOptionalObjectId(item?.assignedUserId);
    if (assignedUserId === '__invalid__') {
      return { error: 'Assigned user id is invalid' };
    }

    if (assignedUserId) {
      const user = await User.findById(assignedUserId).select('_id clientAccountId');
      if (!user) return { error: 'Assigned user not found' };
      const userClientId = user.clientAccountId ? String(user.clientAccountId) : '';
      if (userClientId && userClientId !== String(clientAccountId)) {
        return { error: 'Assigned user belongs to another client organization' };
      }
    }

    phoneNumbers.push({
      phoneNumber,
      label: normalizeTrimmedText(item?.label),
      capabilities: normalizeBooleanCapabilities(item?.capabilities),
      assignedUserId: assignedUserId || null,
      assignedDepartment: normalizeTrimmedText(item?.assignedDepartment),
      pinOrPasscode: normalizeTrimmedText(item?.pinOrPasscode),
      portabilityStatus: normalizeTrimmedText(item?.portabilityStatus),
      portabilityCheckedAt: normalizeDate(item?.portabilityCheckedAt),
      portable: typeof item?.portable === 'boolean' ? item.portable : null,
      notPortableReason: normalizeTrimmedText(item?.notPortableReason),
      notPortableReasonCode: normalizeTrimmedText(item?.notPortableReasonCode),
      numberType: normalizeTrimmedText(item?.numberType),
      country: normalizeTrimmedText(item?.country),
      pinAndAccountNumberRequired: typeof item?.pinAndAccountNumberRequired === 'boolean'
        ? item.pinAndAccountNumberRequired
        : null,
      twilioPortInPhoneNumberSid: normalizeTrimmedText(item?.twilioPortInPhoneNumberSid),
      twilioIncomingPhoneNumberSid: normalizeTrimmedText(item?.twilioIncomingPhoneNumberSid),
      notes: normalizeTrimmedText(item?.notes),
    });
  }

  return { phoneNumbers };
};

const buildPayload = async (body = {}) => {
  const clientAccountId = normalizeOptionalObjectId(body.clientAccountId);
  if (!clientAccountId || clientAccountId === '__invalid__') {
    return { error: 'Client organization is required' };
  }

  const clientAccount = await ClientAccount.findById(clientAccountId).select('_id resellerId');
  if (!clientAccount) {
    return { error: 'Client organization not found' };
  }

  const phoneResult = await sanitizePhoneNumbers(body.phoneNumbers, clientAccount._id);
  if (phoneResult.error) return phoneResult;
  if (phoneResult.phoneNumbers.length === 0) {
    return { error: 'At least one phone number is required' };
  }

  return {
    payload: {
      clientAccountId: clientAccount._id,
      resellerId: clientAccount.resellerId || null,
      phoneNumbers: phoneResult.phoneNumbers,
      currentCarrier: normalizeTrimmedText(body.currentCarrier) || 'RingCentral',
      customerType: normalizeCustomerType(body.customerType),
      customerName: normalizeTrimmedText(body.customerName),
      notificationEmails: normalizeStringList(body.notificationEmails),
      billingTelephoneNumber: normalizeTrimmedText(body.billingTelephoneNumber),
      accountNumber: normalizeTrimmedText(body.accountNumber),
      pinOrPasscode: normalizeTrimmedText(body.pinOrPasscode),
      serviceAddress: {
        street: normalizeTrimmedText(body.serviceAddress?.street),
        street2: normalizeTrimmedText(body.serviceAddress?.street2),
        city: normalizeTrimmedText(body.serviceAddress?.city),
        state: normalizeTrimmedText(body.serviceAddress?.state),
        postalCode: normalizeTrimmedText(body.serviceAddress?.postalCode),
        country: normalizeTrimmedText(body.serviceAddress?.country) || 'US',
      },
      authorizedSigner: {
        name: normalizeTrimmedText(body.authorizedSigner?.name),
        title: normalizeTrimmedText(body.authorizedSigner?.title),
        email: normalizeTrimmedText(body.authorizedSigner?.email).toLowerCase(),
        phone: normalizeTrimmedText(body.authorizedSigner?.phone),
      },
      desiredPortDate: normalizeDate(body.desiredPortDate),
      targetPortInTimeRangeStart: normalizeTrimmedText(body.targetPortInTimeRangeStart),
      targetPortInTimeRangeEnd: normalizeTrimmedText(body.targetPortInTimeRangeEnd),
      status: normalizeStatus(body.status),
      notes: normalizeTrimmedText(body.notes),
      twilioPortOrderId: normalizeTrimmedText(body.twilioPortOrderId),
      twilioPortInRequestSid: normalizeTrimmedText(body.twilioPortInRequestSid),
    },
  };
};

const populatePortingRequest = (query) => query
  .populate('clientAccountId', 'companyName accountStatus resellerId')
  .populate('resellerId', 'companyName status')
  .populate('phoneNumbers.assignedUserId', 'name email role clientAccountId')
  .populate('activatedBy', 'name email')
  .populate('archivedBy', 'name email');

const sanitizePortingRequest = (request) => ({
  id: String(request._id),
  clientAccountId: request.clientAccountId?._id
    ? String(request.clientAccountId._id)
    : String(request.clientAccountId || ''),
  clientAccount: request.clientAccountId?._id
    ? {
        id: String(request.clientAccountId._id),
        companyName: request.clientAccountId.companyName || '',
        accountStatus: request.clientAccountId.accountStatus || 'pending',
      }
    : null,
  resellerId: request.resellerId?._id
    ? String(request.resellerId._id)
    : (request.resellerId ? String(request.resellerId) : null),
  reseller: request.resellerId?._id
    ? {
        id: String(request.resellerId._id),
        companyName: request.resellerId.companyName || '',
        status: request.resellerId.status || 'pending',
      }
    : null,
  phoneNumbers: (Array.isArray(request.phoneNumbers) ? request.phoneNumbers : []).map((item) => ({
    phoneNumber: item.phoneNumber || '',
    label: item.label || '',
    capabilities: {
      voice: Boolean(item.capabilities?.voice),
      sms: Boolean(item.capabilities?.sms),
      mms: Boolean(item.capabilities?.mms),
    },
    assignedUserId: item.assignedUserId?._id
      ? String(item.assignedUserId._id)
      : (item.assignedUserId ? String(item.assignedUserId) : null),
    assignedUser: item.assignedUserId?._id
      ? {
          id: String(item.assignedUserId._id),
          name: item.assignedUserId.name || '',
          email: item.assignedUserId.email || '',
          role: item.assignedUserId.role || '',
        }
      : null,
    assignedDepartment: item.assignedDepartment || '',
    pinOrPasscode: item.pinOrPasscode || '',
    portabilityStatus: item.portabilityStatus || '',
    portabilityCheckedAt: item.portabilityCheckedAt,
    portable: typeof item.portable === 'boolean' ? item.portable : null,
    notPortableReason: item.notPortableReason || '',
    notPortableReasonCode: item.notPortableReasonCode || '',
    numberType: item.numberType || '',
    country: item.country || '',
    pinAndAccountNumberRequired: typeof item.pinAndAccountNumberRequired === 'boolean'
      ? item.pinAndAccountNumberRequired
      : null,
    twilioPortInPhoneNumberSid: item.twilioPortInPhoneNumberSid || '',
    twilioIncomingPhoneNumberSid: item.twilioIncomingPhoneNumberSid || '',
    notes: item.notes || '',
  })),
  currentCarrier: request.currentCarrier || '',
  customerType: request.customerType || '',
  customerName: request.customerName || '',
  notificationEmails: Array.isArray(request.notificationEmails) ? request.notificationEmails : [],
  billingTelephoneNumber: request.billingTelephoneNumber || '',
  accountNumber: request.accountNumber || '',
  pinOrPasscode: request.pinOrPasscode || '',
  serviceAddress: {
    street: request.serviceAddress?.street || '',
    street2: request.serviceAddress?.street2 || '',
    city: request.serviceAddress?.city || '',
    state: request.serviceAddress?.state || '',
    postalCode: request.serviceAddress?.postalCode || '',
    country: request.serviceAddress?.country || 'US',
  },
  authorizedSigner: {
    name: request.authorizedSigner?.name || '',
    title: request.authorizedSigner?.title || '',
    email: request.authorizedSigner?.email || '',
    phone: request.authorizedSigner?.phone || '',
  },
  desiredPortDate: request.desiredPortDate,
  targetPortInTimeRangeStart: request.targetPortInTimeRangeStart || '',
  targetPortInTimeRangeEnd: request.targetPortInTimeRangeEnd || '',
  status: request.status || 'draft',
  notes: request.notes || '',
  documents: (Array.isArray(request.documents) ? request.documents : []).map((document) => ({
    id: String(document._id),
    documentType: document.documentType || 'other',
    fileName: document.fileName || '',
    fileType: document.fileType || '',
    fileSize: document.fileSize || 0,
    fileUrl: document.fileUrl || '',
    uploadedByName: document.uploadedByName || '',
    uploadedAt: document.uploadedAt,
    twilioDocumentSid: document.twilioDocumentSid || '',
    twilioDocumentType: document.twilioDocumentType || '',
    twilioUploadedAt: document.twilioUploadedAt,
  })),
  statusHistory: (Array.isArray(request.statusHistory) ? request.statusHistory : []).map((entry) => ({
    id: String(entry._id),
    status: entry.status || '',
    description: entry.description || '',
    actorName: entry.actorName || '',
    createdAt: entry.createdAt,
  })),
  twilioPortOrderId: request.twilioPortOrderId || '',
  twilioPortInRequestSid: request.twilioPortInRequestSid || '',
  webhookEvents: (Array.isArray(request.webhookEvents) ? request.webhookEvents : []).map((entry) => ({
    eventType: entry.eventType || '',
    status: entry.status || '',
    portInRequestSid: entry.portInRequestSid || '',
    portInPhoneNumberSid: entry.portInPhoneNumberSid || '',
    phoneNumber: entry.phoneNumber || '',
    receivedAt: entry.receivedAt,
  })),
  activatedAt: request.activatedAt,
  archivedAt: request.archivedAt,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

const applyPortabilityResultToNumber = (item, result) => {
  item.portabilityStatus = result.portabilityStatus || '';
  item.portabilityCheckedAt = result.portabilityCheckedAt || new Date();
  item.portable = typeof result.portable === 'boolean' ? result.portable : null;
  item.notPortableReason = result.notPortableReason || result.twilioMessage || '';
  item.notPortableReasonCode = result.notPortableReasonCode || result.twilioCode || '';
  item.numberType = result.numberType || '';
  item.country = result.country || '';
  item.pinAndAccountNumberRequired = typeof result.pinAndAccountNumberRequired === 'boolean'
    ? result.pinAndAccountNumberRequired
    : null;
};

const buildPortabilityErrorPayload = (error, fallbackMessage) => {
  if (error?.details) {
    return {
      error: error.details.message || fallbackMessage,
      status: error.details.status || 'twilio_error',
      twilioCode: error.details.twilioCode || null,
      twilioMessage: error.details.twilioMessage || '',
      httpStatus: error.details.httpStatus || null,
    };
  }

  if (error?.code === 'TWILIO_PORTING_CONFIG_MISSING') {
    return {
      error: 'Twilio porting credentials are not configured',
      status: 'configuration_error',
      twilioCode: null,
      twilioMessage: '',
      httpStatus: null,
    };
  }

  return {
    error: error?.message || fallbackMessage,
    status: 'network_or_configuration_error',
    twilioCode: null,
    twilioMessage: error?.message || '',
    httpStatus: null,
  };
};

exports.listPortingRequests = async (req, res) => {
  try {
    const includeArchived = String(req.query?.includeArchived || '').toLowerCase() === 'true';
    const query = includeArchived ? {} : { archivedAt: null };
    const requests = await populatePortingRequest(
      PortingRequest.find(query).sort({ updatedAt: -1, createdAt: -1 })
    );

    return res.json({ portingRequests: requests.map(sanitizePortingRequest) });
  } catch (error) {
    console.error('Porting request list error:', error);
    return res.status(500).json({ error: 'Failed to load porting requests' });
  }
};

exports.getPortingRequest = async (req, res) => {
  try {
    const request = await populatePortingRequest(PortingRequest.findById(req.params.id));
    if (!request) {
      return res.status(404).json({ error: 'Porting request not found' });
    }

    return res.json({ portingRequest: sanitizePortingRequest(request) });
  } catch (error) {
    console.error('Porting request detail error:', error);
    return res.status(500).json({ error: 'Failed to load porting request' });
  }
};

exports.checkStandalonePhoneNumberPortability = async (req, res) => {
  try {
    const phoneNumber = normalizeTrimmedText(req.body?.phoneNumber || req.query?.phoneNumber);
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const result = await checkPhoneNumberPortability(phoneNumber);
    return res.json({
      result,
      createdOrModifiedTwilioData: false,
      checkedTwilioEndpoint: 'Portability',
    });
  } catch (error) {
    console.error('Standalone portability check error:', {
      message: error.message,
      status: error?.details?.status || error?.code || 'unknown',
    });
    const payload = buildPortabilityErrorPayload(error, 'Failed to check phone number portability');
    return res.status(payload.httpStatus && payload.httpStatus >= 500 ? 502 : 400).json(payload);
  }
};

exports.checkPortingRequestPortability = async (req, res) => {
  try {
    const request = await PortingRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Porting request not found' });
    }

    const requestedPhoneNumber = normalizeTrimmedText(req.body?.phoneNumber || req.query?.phoneNumber);
    const numbersToCheck = (request.phoneNumbers || []).filter((item) => {
      const phoneNumber = normalizeTrimmedText(item.phoneNumber);
      if (!phoneNumber) return false;
      return requestedPhoneNumber
        ? phoneNumber === requestedPhoneNumber
        : true;
    });

    if (numbersToCheck.length === 0) {
      return res.status(404).json({ error: 'Phone number not found on this porting request' });
    }

    const results = [];
    for (const item of numbersToCheck) {
      const result = await checkPhoneNumberPortability(item.phoneNumber);
      applyPortabilityResultToNumber(item, result);
      results.push(result);
    }

    request.markModified('phoneNumbers');
    await request.save();

    const populated = await populatePortingRequest(PortingRequest.findById(request._id));
    return res.json({
      portingRequest: sanitizePortingRequest(populated),
      results,
      createdOrModifiedTwilioData: false,
      checkedTwilioEndpoint: 'Portability',
    });
  } catch (error) {
    console.error('Porting request portability check error:', {
      message: error.message,
      status: error?.details?.status || error?.code || 'unknown',
      requestId: req.params.id,
    });
    const payload = buildPortabilityErrorPayload(error, 'Failed to check porting request portability');
    return res.status(payload.httpStatus && payload.httpStatus >= 500 ? 502 : 400).json(payload);
  }
};

exports.createPortingRequest = async (req, res) => {
  try {
    const payloadResult = await buildPayload(req.body || {});
    if (payloadResult.error) {
      return res.status(400).json({ error: payloadResult.error });
    }

    const created = await PortingRequest.create({
      ...payloadResult.payload,
      statusHistory: [
        buildStatusEntry(payloadResult.payload.status, 'Porting request created', req.user),
      ],
    });

    const populated = await populatePortingRequest(PortingRequest.findById(created._id));
    return res.status(201).json({ portingRequest: sanitizePortingRequest(populated) });
  } catch (error) {
    console.error('Porting request create error:', error);
    return res.status(500).json({ error: 'Failed to create porting request' });
  }
};

exports.updatePortingRequest = async (req, res) => {
  try {
    const request = await PortingRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Porting request not found' });
    }

    const payloadResult = await buildPayload({
      ...req.body,
      status: req.body?.status || request.status,
    });
    if (payloadResult.error) {
      return res.status(400).json({ error: payloadResult.error });
    }

    const previousStatus = request.status;
    if (request.activatedAt && previousStatus === 'completed' && payloadResult.payload.status !== 'completed') {
      return sendActivationCompletedError(res);
    }

    Object.assign(request, payloadResult.payload);
    if (previousStatus !== request.status) {
      request.statusHistory.push(buildStatusEntry(request.status, 'Porting request status updated', req.user));
    }
    await request.save();

    const populated = await populatePortingRequest(PortingRequest.findById(request._id));
    return res.json({ portingRequest: sanitizePortingRequest(populated) });
  } catch (error) {
    console.error('Porting request update error:', error);
    return res.status(500).json({ error: 'Failed to update porting request' });
  }
};

exports.updatePortingRequestStatus = async (req, res) => {
  try {
    const request = await PortingRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Porting request not found' });
    }

    const nextStatus = normalizeStatus(req.body?.status, request.status);
    if (!PORTING_STATUSES.has(nextStatus)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (request.activatedAt && request.status === 'completed' && nextStatus !== 'completed') {
      return sendActivationCompletedError(res);
    }

    request.status = nextStatus;
    request.statusHistory.push(buildStatusEntry(
      nextStatus,
      req.body?.description || `Status changed to ${nextStatus}`,
      req.user
    ));
    await request.save();

    const populated = await populatePortingRequest(PortingRequest.findById(request._id));
    return res.json({ portingRequest: sanitizePortingRequest(populated) });
  } catch (error) {
    console.error('Porting request status error:', error);
    return res.status(500).json({ error: 'Failed to update porting request status' });
  }
};

exports.uploadPortingDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Document file is required' });
    }

    const request = await PortingRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Porting request not found' });
    }

    request.documents.push({
      documentType: normalizeDocumentType(req.body?.documentType),
      fileName: req.file.originalname || req.file.filename,
      fileType: req.file.mimetype,
      fileSize: req.file.size,
      fileUrl: `/uploads/porting-documents/${req.file.filename}`,
      storagePath: path.posix.join('porting-documents', req.file.filename),
      uploadedBy: req.user?._id || null,
      uploadedByName: getActorName(req.user),
      uploadedAt: new Date(),
    });
    request.statusHistory.push(buildStatusEntry(request.status, 'Porting document uploaded', req.user));
    await request.save();

    const populated = await populatePortingRequest(PortingRequest.findById(request._id));
    return res.status(201).json({ portingRequest: sanitizePortingRequest(populated) });
  } catch (error) {
    console.error('Porting document upload error:', error);
    return res.status(500).json({ error: 'Failed to upload porting document' });
  }
};

exports.archivePortingRequest = async (req, res) => {
  try {
    const request = await PortingRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Porting request not found' });
    }

    request.archivedAt = request.archivedAt || new Date();
    request.archivedBy = request.archivedBy || req.user?._id || null;
    request.statusHistory.push(buildStatusEntry(request.status, 'Porting request archived', req.user));
    await request.save();

    const populated = await populatePortingRequest(PortingRequest.findById(request._id));
    return res.json({ portingRequest: sanitizePortingRequest(populated) });
  } catch (error) {
    console.error('Porting request archive error:', error);
    return res.status(500).json({ error: 'Failed to archive porting request' });
  }
};

exports.activatePortingNumbers = async (req, res) => {
  try {
    const confirmed = req.body?.confirm === true || req.body?.confirm === 'true';
    if (!confirmed) {
      return res.status(400).json({ error: 'Activation confirmation is required' });
    }

    const request = await PortingRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Porting request not found' });
    }

    if (request.status !== 'completed') {
      return res.status(400).json({ error: 'Only completed porting requests can be activated' });
    }

    if (request.activatedAt) {
      const populatedExisting = await populatePortingRequest(PortingRequest.findById(request._id));
      return res.json({
        portingRequest: sanitizePortingRequest(populatedExisting),
        activatedNumbers: [],
        message: 'Numbers were already activated',
      });
    }

    const activatedNumbers = [];
    for (const item of request.phoneNumbers || []) {
      const phoneNumber = normalizeTrimmedText(item.phoneNumber);
      if (!phoneNumber) continue;

      const existingNumber = await ClientPhoneNumber.findOne({ phoneNumber }).select('_id clientAccountId');
      if (existingNumber && String(existingNumber.clientAccountId) !== String(request.clientAccountId)) {
        return res.status(409).json({
          error: `Phone number ${phoneNumber} is already assigned to another client organization`,
        });
      }

      const payload = {
        phoneNumber,
        clientAccountId: request.clientAccountId,
        resellerId: request.resellerId || null,
        label: item.label || '',
        capabilities: {
          voice: Boolean(item.capabilities?.voice),
          sms: Boolean(item.capabilities?.sms),
          mms: Boolean(item.capabilities?.mms),
        },
        status: 'active',
        assignedUserId: item.assignedUserId || null,
        assignedDepartment: item.assignedDepartment || '',
        route: item.assignedDepartment || '',
        notes: item.notes || request.notes || '',
        source: 'portal',
        archivedAt: null,
        archivedBy: null,
      };

      const numberRecord = await ClientPhoneNumber.findOneAndUpdate(
        { phoneNumber },
        payload,
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
      );
      activatedNumbers.push(numberRecord);
    }

    request.activatedAt = new Date();
    request.activatedBy = req.user?._id || null;
    request.statusHistory.push(buildStatusEntry('completed', 'Completed numbers activated for client organization', req.user));
    await request.save();
    await syncClientAccountAssignedNumbers(request.clientAccountId);

    const populated = await populatePortingRequest(PortingRequest.findById(request._id));
    return res.json({
      portingRequest: sanitizePortingRequest(populated),
      activatedNumbers: activatedNumbers.map((number) => ({
        id: String(number._id),
        phoneNumber: number.phoneNumber,
      })),
    });
  } catch (error) {
    console.error('Porting activation error:', error);
    return res.status(500).json({ error: 'Failed to activate ported numbers' });
  }
};
