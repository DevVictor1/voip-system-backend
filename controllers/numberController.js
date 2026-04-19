const PortingNumber = require('../models/PortingNumber');

const allowedStatuses = ['active', 'pending', 'porting', 'completed', 'failed'];
const allowedCapabilities = ['voice', 'messaging', 'voice + messaging'];

const sanitizePayload = (body = {}) => {
  const payload = {
    phoneNumber: String(body.phoneNumber || '').trim(),
    label: String(body.label || '').trim(),
    provider: String(body.provider || '').trim(),
    status: String(body.status || 'pending').trim(),
    capabilities: String(body.capabilities || 'voice').trim(),
    assignedTo: String(body.assignedTo || '').trim(),
    notes: String(body.notes || '').trim(),
    requestedPortDate: body.requestedPortDate || null,
    completedDate: body.completedDate || null,
  };

  if (payload.requestedPortDate) {
    payload.requestedPortDate = new Date(payload.requestedPortDate);
  }

  if (payload.completedDate) {
    payload.completedDate = new Date(payload.completedDate);
  }

  return payload;
};

const validatePayload = (payload) => {
  if (!payload.phoneNumber) {
    return 'phoneNumber is required';
  }

  if (!allowedStatuses.includes(payload.status)) {
    return 'Invalid status';
  }

  if (!allowedCapabilities.includes(payload.capabilities)) {
    return 'Invalid capabilities';
  }

  return null;
};

exports.getNumbers = async (req, res) => {
  try {
    const numbers = await PortingNumber.find().sort({ updatedAt: -1, createdAt: -1 });
    res.json(numbers);
  } catch (error) {
    console.error('Numbers fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch numbers' });
  }
};

exports.createNumber = async (req, res) => {
  try {
    const payload = sanitizePayload(req.body);
    const validationError = validatePayload(payload);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const created = await PortingNumber.create(payload);
    res.status(201).json(created);
  } catch (error) {
    console.error('Numbers create error:', error);
    res.status(500).json({ error: 'Failed to create number' });
  }
};

exports.updateNumber = async (req, res) => {
  try {
    const payload = sanitizePayload(req.body);
    const validationError = validatePayload(payload);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const updated = await PortingNumber.findByIdAndUpdate(
      req.params.id,
      payload,
      { returnDocument: 'after', runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Number not found' });
    }

    res.json(updated);
  } catch (error) {
    console.error('Numbers update error:', error);
    res.status(500).json({ error: 'Failed to update number' });
  }
};

exports.deleteNumber = async (req, res) => {
  try {
    const deleted = await PortingNumber.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: 'Number not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Numbers delete error:', error);
    res.status(500).json({ error: 'Failed to delete number' });
  }
};
