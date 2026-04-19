const fs = require('fs');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const Contact = require('../models/Contact');
const {
  normalizeAgentId,
  syncAssignmentWorkload,
} = require('../utils/agentWorkload');

// ðŸ”¥ NORMALIZE PHONE
const normalizePhone = (phone) => {
  if (!phone) return '';
  return phone.toString().replace(/\D/g, '');
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
