const path = require('path');
const mongoose = require('mongoose');
const ClientAccount = require('../models/ClientAccount');
const ClientPhoneNumber = require('../models/ClientPhoneNumber');
const PortingRequest = require('../models/PortingRequest');
const User = require('../models/User');
const { syncClientAccountAssignedNumbers } = require('../utils/clientNumberOwnership');

const PORTING_STATUSES = new Set(['draft', 'review', 'submitted', 'scheduled', 'porting', 'completed', 'rejected', 'cancelled']);
const DOCUMENT_TYPES = new Set(['loa', 'bill', 'csr', 'other']);

const normalizeTrimmedText = (value) => String(value || '').trim();

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
      billingTelephoneNumber: normalizeTrimmedText(body.billingTelephoneNumber),
      accountNumber: normalizeTrimmedText(body.accountNumber),
      pinOrPasscode: normalizeTrimmedText(body.pinOrPasscode),
      serviceAddress: {
        street: normalizeTrimmedText(body.serviceAddress?.street),
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
      status: normalizeStatus(body.status),
      notes: normalizeTrimmedText(body.notes),
      twilioPortOrderId: normalizeTrimmedText(body.twilioPortOrderId),
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
    notes: item.notes || '',
  })),
  currentCarrier: request.currentCarrier || '',
  billingTelephoneNumber: request.billingTelephoneNumber || '',
  accountNumber: request.accountNumber || '',
  pinOrPasscode: request.pinOrPasscode || '',
  serviceAddress: {
    street: request.serviceAddress?.street || '',
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
  })),
  statusHistory: (Array.isArray(request.statusHistory) ? request.statusHistory : []).map((entry) => ({
    id: String(entry._id),
    status: entry.status || '',
    description: entry.description || '',
    actorName: entry.actorName || '',
    createdAt: entry.createdAt,
  })),
  twilioPortOrderId: request.twilioPortOrderId || '',
  activatedAt: request.activatedAt,
  archivedAt: request.archivedAt,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

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
