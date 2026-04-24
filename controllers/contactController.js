const fs = require('fs');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const Contact = require('../models/Contact');
const {
  normalizeAgentId,
  syncAssignmentWorkload,
  syncLifecycleWorkload,
} = require('../utils/agentWorkload');

const CONTACT_ASSIGNMENT_STATUSES = ['open', 'resolved', 'closed'];
const normalizeAssignmentStatus = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return CONTACT_ASSIGNMENT_STATUSES.includes(normalized) ? normalized : '';
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ðŸ”¥ NORMALIZE PHONE
const normalizePhone = (phone) => {
  if (!phone) return '';
  return phone.toString().replace(/\D/g, '');
};

const normalizePhoneKey = (phone) => normalizePhone(phone).slice(-10);

const splitContactName = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return { firstName: '', lastName: '' };
  }

  const parts = trimmed.split(/\s+/);
  return {
    firstName: parts.shift() || '',
    lastName: parts.join(' '),
  };
};

const findExistingContactByPhone = async (phone) => {
  const normalizedPhone = normalizePhone(phone);
  const phoneKey = normalizePhoneKey(phone);

  if (!normalizedPhone && !phoneKey) {
    return null;
  }

  const phoneMatchers = [normalizedPhone, phoneKey]
    .filter(Boolean)
    .flatMap((value) => ([{ 'phones.number': value }]));

  if (phoneKey) {
    phoneMatchers.push({ 'phones.number': { $regex: `${escapeRegex(phoneKey)}$` } });
  }

  return Contact.findOne({ $or: phoneMatchers });
};

// ðŸ”¥ AUTO DETECT DBA
const getDBA = (row) => {
  const keys = Object.keys(row);

  const foundKey = keys.find((key) =>
    key.toLowerCase().includes('dba') ||
    key.toLowerCase().includes('business') ||
    key.toLowerCase().includes('company') ||
    key.toLowerCase().includes('shop')
  );

  return foundKey ? row[foundKey] : '';
};

// ðŸ”¥ AUTO DETECT MID (NEW)
const getMID = (row) => {
  const keys = Object.keys(row);

  const foundKey = keys.find((key) =>
    key.toLowerCase().includes('mid') ||
    key.toLowerCase().includes('merchant')
  );

  return foundKey ? String(row[foundKey]).trim() : '';
};

// ðŸ“¥ IMPORT CONTACTS
exports.importContacts = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const ext = req.file.originalname.split('.').pop().toLowerCase();

    let results = [];

    // âœ… XLSX
    if (ext === 'xlsx' || ext === 'xls') {
      const workbook = xlsx.readFile(filePath);

      const mainSheetName = workbook.SheetNames[0];
      console.log('ðŸ“„ Using sheet:', mainSheetName);

      const sheet = workbook.Sheets[mainSheetName];
      const data = xlsx.utils.sheet_to_json(sheet);

      results = data.map((row) => ({
        firstName: row['First Name'] || row.firstName || '',
        lastName: row['Last Name'] || row.lastName || '',

        dba: row['DBA Name'] || getDBA(row),

        // ðŸ”¥ NEW MID
        mid: getMID(row),

        phones: [
          {
            label: 'store',
            number: normalizePhone(row['Store Phone']),
          },
          {
            label: 'cell',
            number: normalizePhone(row['Cell Phone']),
          }
        ].filter(p => p.number),
      }));

    } else {
      // âœ… CSV
      await new Promise((resolve) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (row) => {
            results.push({
              firstName: row.firstName || row['First Name'] || '',
              lastName: row.lastName || row['Last Name'] || '',

              dba: getDBA(row),

              // ðŸ”¥ NEW MID
              mid: getMID(row),

              phones: [
                {
                  label: 'store',
                  number: normalizePhone(row['Store Phone'] || row.phone),
                },
                {
                  label: 'cell',
                  number: normalizePhone(row['Cell Phone']),
                }
              ].filter(p => p.number),
            });
          })
          .on('end', resolve);
      });
    }

    // âœ… FILTER VALID
    const valid = results.filter(
      (c) => c.firstName && c.phones.length > 0
    );

    await Contact.insertMany(valid);

    fs.unlinkSync(filePath);

    res.json({
      success: true,
      count: valid.length,
      message: 'Contacts imported successfully',
    });

  } catch (error) {
    console.error('âŒ IMPORT ERROR:', error);
    res.status(500).json({ error: 'Failed to import contacts' });
  }
};

// ðŸ“š GET (ðŸ”¥ WITH SHARED INBOX LOGIC)
exports.getContacts = async (req, res) => {
  try {
    const { role = 'admin', userId = null } = req.query;

    let filter = {};

    // ðŸ”¥ AGENT: only see assigned + unassigned
    if (role === 'agent') {
      filter = {
        $or: [
          { assignedTo: userId },
          { isUnassigned: true }
        ]
      };
    }

    // ðŸ”¥ ADMIN: sees everything (no filter)

    const contacts = await Contact.find(filter).sort({ createdAt: -1 });

    res.json(contacts);

  } catch (error) {
    console.error('âŒ FETCH CONTACTS ERROR:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

// ðŸ‘¤ ASSIGN CONTACT
exports.assignContact = async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    const nextAssignedTo = normalizeAgentId(userId);

    const existingContact = await Contact.findById(id);

    if (!existingContact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const previousAssignedTo = normalizeAgentId(existingContact.assignedTo);
    const nextIsUnassigned = !nextAssignedTo;

    if (
      previousAssignedTo === nextAssignedTo &&
      existingContact.isUnassigned === nextIsUnassigned
    ) {
      return res.json(existingContact);
    }

    const updated = await Contact.findByIdAndUpdate(
      id,
      {
        assignedTo: nextAssignedTo || null,
        isUnassigned: nextIsUnassigned,
      },
      { returnDocument: 'after' }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const workload = await syncAssignmentWorkload(previousAssignedTo, nextAssignedTo);

    if (workload.changed) {
      console.log(
        '[contact:assignment] Updated workload for contact',
        id,
        `(${previousAssignedTo || 'unassigned'} -> ${nextAssignedTo || 'unassigned'})`
      );
    }

    res.json(updated);

  } catch (err) {
    console.error('âŒ Assign error:', err);
    res.status(500).json({ error: 'Failed to assign contact' });
  }
};

exports.upsertContact = async (req, res) => {
  try {
    const {
      name = '',
      phone = '',
      business = '',
      merchantId = '',
      notes = '',
    } = req.body || {};

    const normalizedPhone = normalizePhone(phone);
    const phoneKey = normalizePhoneKey(phone);

    if (!normalizedPhone || !phoneKey) {
      return res.status(400).json({ error: 'Valid phone number is required' });
    }

    const { firstName, lastName } = splitContactName(name);
    const trimmedBusiness = String(business || '').trim();
    const trimmedMerchantId = String(merchantId || '').trim();
    const trimmedNotes = String(notes || '').trim();

    const existingContact = await findExistingContactByPhone(normalizedPhone);
    const normalizedPhones = (existingContact?.phones || []).map((entry) => ({
      ...entry,
      number: normalizePhone(entry.number),
    }));

    const hasMatchingPhone = normalizedPhones.some((entry) => normalizePhoneKey(entry.number) === phoneKey);
    const nextPhones = hasMatchingPhone
      ? normalizedPhones
      : [
          ...normalizedPhones,
          {
            label: normalizedPhones.length > 0 ? 'mobile' : 'primary',
            number: normalizedPhone,
          },
        ];

    if (existingContact) {
      existingContact.firstName = firstName || existingContact.firstName || '';
      existingContact.lastName = lastName || existingContact.lastName || '';
      existingContact.dba = trimmedBusiness || existingContact.dba || '';
      existingContact.mid = trimmedMerchantId || existingContact.mid || '';
      existingContact.notes = trimmedNotes || existingContact.notes || '';
      existingContact.phones = nextPhones;

      const updated = await existingContact.save();
      return res.json({ contact: updated, created: false });
    }

    const created = await Contact.create({
      firstName,
      lastName,
      dba: trimmedBusiness,
      mid: trimmedMerchantId,
      notes: trimmedNotes,
      phones: [
        {
          label: 'primary',
          number: normalizedPhone,
        },
      ],
      assignedTo: null,
      isUnassigned: true,
      assignmentStatus: 'open',
    });

    return res.status(201).json({ contact: created, created: true });
  } catch (error) {
    console.error('Upsert contact error:', error);
    return res.status(500).json({ error: 'Failed to save contact' });
  }
};

exports.updateAssignmentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const nextStatus = normalizeAssignmentStatus(req.body?.assignmentStatus);

    if (!nextStatus) {
      return res.status(400).json({ error: 'Invalid assignmentStatus' });
    }

    const existingContact = await Contact.findById(id);

    if (!existingContact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const previousStatus = normalizeAssignmentStatus(existingContact.assignmentStatus) || 'open';

    if (previousStatus === nextStatus) {
      return res.json(existingContact);
    }

    const updated = await Contact.findByIdAndUpdate(
      id,
      {
        assignmentStatus: nextStatus,
      },
      { returnDocument: 'after' }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const workload = await syncLifecycleWorkload(existingContact.assignedTo, previousStatus, nextStatus);

    if (workload.changed) {
      console.log(
        '[contact:lifecycle] Updated workload for contact',
        id,
        `(${previousStatus} -> ${nextStatus})`
      );
    }

    res.json(updated);
  } catch (error) {
    console.error('Assignment status error:', error);
    res.status(500).json({ error: 'Failed to update assignment status' });
  }
};

// ðŸ—‘ DELETE
exports.deleteContact = async (req, res) => {
  try {
    const { id } = req.params;
    await Contact.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('âŒ Delete error:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
};

// ðŸ§¹ CLEAR
exports.clearContacts = async (req, res) => {
  try {
    await Contact.deleteMany({});
    res.json({ success: true, message: 'All contacts deleted' });
  } catch (error) {
    console.error('âŒ Clear contacts error:', error);
    res.status(500).json({ error: 'Failed to clear contacts' });
  }
};
