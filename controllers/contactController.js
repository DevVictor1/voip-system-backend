const fs = require('fs');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const Contact = require('../models/Contact');

// 🔥 NORMALIZE PHONE
const normalizePhone = (phone) => {
  if (!phone) return '';
  return phone.toString().replace(/\D/g, '');
};

// 🔥 AUTO DETECT DBA
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

// 🔥 AUTO DETECT MID (NEW)
const getMID = (row) => {
  const keys = Object.keys(row);

  const foundKey = keys.find((key) =>
    key.toLowerCase().includes('mid') ||
    key.toLowerCase().includes('merchant')
  );

  return foundKey ? String(row[foundKey]).trim() : '';
};

// 📥 IMPORT CONTACTS
exports.importContacts = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const ext = req.file.originalname.split('.').pop().toLowerCase();

    let results = [];

    // ✅ XLSX
    if (ext === 'xlsx' || ext === 'xls') {
      const workbook = xlsx.readFile(filePath);

      const mainSheetName = workbook.SheetNames[0];
      console.log('📄 Using sheet:', mainSheetName);

      const sheet = workbook.Sheets[mainSheetName];
      const data = xlsx.utils.sheet_to_json(sheet);

      results = data.map((row) => ({
        firstName: row['First Name'] || row.firstName || '',
        lastName: row['Last Name'] || row.lastName || '',

        dba: row['DBA Name'] || getDBA(row),

        // 🔥 NEW MID
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
      // ✅ CSV
      await new Promise((resolve) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (row) => {
            results.push({
              firstName: row.firstName || row['First Name'] || '',
              lastName: row.lastName || row['Last Name'] || '',

              dba: getDBA(row),

              // 🔥 NEW MID
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

    // ✅ FILTER VALID
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
    console.error('❌ IMPORT ERROR:', error);
    res.status(500).json({ error: 'Failed to import contacts' });
  }
};

// 📚 GET (🔥 WITH SHARED INBOX LOGIC)
exports.getContacts = async (req, res) => {
  try {
    const { role = 'admin', userId = null } = req.query;

    let filter = {};

    // 🔥 AGENT: only see assigned + unassigned
    if (role === 'agent') {
      filter = {
        $or: [
          { assignedTo: userId },
          { isUnassigned: true }
        ]
      };
    }

    // 🔥 ADMIN: sees everything (no filter)

    const contacts = await Contact.find(filter).sort({ createdAt: -1 });

    res.json(contacts);

  } catch (error) {
    console.error('❌ FETCH CONTACTS ERROR:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

// 👤 ASSIGN CONTACT
exports.assignContact = async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    const updated = await Contact.findByIdAndUpdate(
      id,
      {
        assignedTo: userId,
        isUnassigned: false,
      },
      { new: true }
    );

    res.json(updated);

  } catch (err) {
    console.error('❌ Assign error:', err);
    res.status(500).json({ error: 'Failed to assign contact' });
  }
};

// 🗑 DELETE
exports.deleteContact = async (req, res) => {
  try {
    const { id } = req.params;
    await Contact.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Delete error:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
};

// 🧹 CLEAR
exports.clearContacts = async (req, res) => {
  try {
    await Contact.deleteMany({});
    res.json({ success: true, message: 'All contacts deleted' });
  } catch (error) {
    console.error('❌ Clear contacts error:', error);
    res.status(500).json({ error: 'Failed to clear contacts' });
  }
};