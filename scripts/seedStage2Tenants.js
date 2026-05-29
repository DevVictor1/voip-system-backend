require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const Reseller = require('../models/Reseller');
const ClientAccount = require('../models/ClientAccount');
const ClientPhoneNumber = require('../models/ClientPhoneNumber');

const CONFIRM_VALUE = 'local-stage2-seed';
const DEFAULT_PASSWORD = 'Stage2Test!2026';

const seedUsers = [
  {
    key: 'platformAdmin',
    name: 'Stage2 Platform Admin',
    email: 'platform.admin@stage2.test',
    role: 'platform_admin',
    agentId: 'stage2_platform_admin',
    department: 'support',
  },
  {
    key: 'resellerAdminA',
    name: 'Stage2 Reseller Admin A',
    email: 'reseller.admin.a@stage2.test',
    role: 'reseller_admin',
    agentId: 'stage2_reseller_admin_a',
    department: 'sales',
  },
  {
    key: 'resellerAdminB',
    name: 'Stage2 Reseller Admin B',
    email: 'reseller.admin.b@stage2.test',
    role: 'reseller_admin',
    agentId: 'stage2_reseller_admin_b',
    department: 'sales',
  },
  {
    key: 'clientAdminA1',
    name: 'Stage2 Client Admin A1',
    email: 'client.admin.a1@stage2.test',
    role: 'client_admin',
    agentId: 'stage2_client_admin_a1',
    department: 'support',
  },
  {
    key: 'clientAdminA2',
    name: 'Stage2 Client Admin A2',
    email: 'client.admin.a2@stage2.test',
    role: 'client_admin',
    agentId: 'stage2_client_admin_a2',
    department: 'support',
  },
  {
    key: 'clientAdminB1',
    name: 'Stage2 Client Admin B1',
    email: 'client.admin.b1@stage2.test',
    role: 'client_admin',
    agentId: 'stage2_client_admin_b1',
    department: 'support',
  },
  {
    key: 'clientUserA1',
    name: 'Stage2 Client User A1',
    email: 'client.user.a1@stage2.test',
    role: 'client_user',
    agentId: 'stage2_client_user_a1',
    department: 'tech',
  },
  {
    key: 'clientUserB1',
    name: 'Stage2 Client User B1',
    email: 'client.user.b1@stage2.test',
    role: 'client_user',
    agentId: 'stage2_client_user_b1',
    department: 'tech',
  },
];

const seedResellers = [
  {
    key: 'resellerA',
    name: 'Northstar Partner Group',
    companyName: 'Stage2 Reseller A',
    contactEmail: 'partners-a@stage2.test',
    contactPhone: '+15550100001',
    status: 'active',
    assignedUserKeys: ['resellerAdminA'],
  },
  {
    key: 'resellerB',
    name: 'Beacon Channel Partners',
    companyName: 'Stage2 Reseller B',
    contactEmail: 'partners-b@stage2.test',
    contactPhone: '+15550100002',
    status: 'active',
    assignedUserKeys: ['resellerAdminB'],
  },
];

const seedClientAccounts = [
  {
    key: 'clientA1',
    companyName: 'Stage2 Client A1',
    resellerKey: 'resellerA',
    adminUserKey: 'clientAdminA1',
    assignedUserKeys: ['clientAdminA1', 'clientUserA1'],
    plan: 'Growth',
    seatLimit: 5,
    accountStatus: 'active',
  },
  {
    key: 'clientA2',
    companyName: 'Stage2 Client A2',
    resellerKey: 'resellerA',
    adminUserKey: 'clientAdminA2',
    assignedUserKeys: ['clientAdminA2'],
    plan: 'Starter',
    seatLimit: 3,
    accountStatus: 'active',
  },
  {
    key: 'clientB1',
    companyName: 'Stage2 Client B1',
    resellerKey: 'resellerB',
    adminUserKey: 'clientAdminB1',
    assignedUserKeys: ['clientAdminB1', 'clientUserB1'],
    plan: 'Growth',
    seatLimit: 4,
    accountStatus: 'active',
  },
];

const seedNumbers = [
  {
    phoneNumber: '+15550101001',
    clientKey: 'clientA1',
    label: 'Main Line',
    capabilities: { voice: true, sms: true, mms: false },
    status: 'active',
    assignedUserKey: 'clientUserA1',
    assignedDepartment: 'support',
  },
  {
    phoneNumber: '+15550101002',
    clientKey: 'clientA1',
    label: 'Sales Line',
    capabilities: { voice: true, sms: false, mms: false },
    status: 'active',
    assignedDepartment: 'sales',
  },
  {
    phoneNumber: '+15550102001',
    clientKey: 'clientA2',
    label: 'Pending Port',
    capabilities: { voice: true, sms: true, mms: true },
    status: 'pending',
    assignedDepartment: 'support',
  },
  {
    phoneNumber: '+15550103001',
    clientKey: 'clientB1',
    label: 'Main Line',
    capabilities: { voice: true, sms: true, mms: false },
    status: 'active',
    assignedUserKey: 'clientUserB1',
    assignedDepartment: 'support',
  },
];

const getArg = (flag) => process.argv.includes(flag);

const isSafeMongoUri = () => {
  const mongoUri = String(process.env.MONGO_URI || '').toLowerCase();
  return mongoUri.includes('localhost')
    || mongoUri.includes('127.0.0.1')
    || mongoUri.includes('stage')
    || mongoUri.includes('test')
    || mongoUri.includes('dev');
};

const assertSeedSafety = () => {
  const mongoUri = String(process.env.MONGO_URI || '');

  if (process.env.STAGE2_SEED_CONFIRM !== CONFIRM_VALUE) {
    throw new Error(`Refusing to seed. Set STAGE2_SEED_CONFIRM=${CONFIRM_VALUE} for local/staging QA.`);
  }

  if (!isSafeMongoUri() && process.env.STAGE2_SEED_ALLOW_NON_LOCAL !== 'true') {
    throw new Error('Refusing to seed because MONGO_URI does not look local/staging/test. Set STAGE2_SEED_ALLOW_NON_LOCAL=true only for an approved staging database.');
  }

  if (process.env.STAGE2_SEED_ALLOW_NON_LOCAL === 'true') {
    console.warn('REMOTE STAGING SEED WARNING: STAGE2_SEED_ALLOW_NON_LOCAL=true is set.');
    console.warn('Confirm this MongoDB URI is a dedicated Stage 2 QA/staging database, never production:');
    console.warn(mongoUri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:<redacted>@'));
  }
};

const toIds = (items) => items.map((item) => item._id);

const upsertUser = async (definition, existingClientAccountId = null) => {
  const update = {
    name: definition.name,
    role: definition.role,
    agentId: definition.agentId,
    department: definition.department,
    isActive: true,
    status: 'available',
    availabilityStatus: 'online',
    isAssignable: true,
    maxActiveChats: 5,
    currentActiveChats: 0,
    maxConcurrentCalls: 1,
    clientAccountId: existingClientAccountId,
  };

  const existing = await User.findOne({ email: definition.email });
  if (existing) {
    Object.assign(existing, update);
    await existing.save();
    return existing;
  }

  return User.create({
    ...update,
    email: definition.email,
    password: DEFAULT_PASSWORD,
  });
};

const upsertReseller = async (definition, usersByKey) => {
  return Reseller.findOneAndUpdate(
    { companyName: definition.companyName },
    {
      $set: {
        name: definition.name,
        companyName: definition.companyName,
        contactEmail: definition.contactEmail,
        contactPhone: definition.contactPhone,
        status: definition.status,
        notes: 'QA boundary testing partner. Safe to remove after review.',
        assignedUserIds: toIds(definition.assignedUserKeys.map((key) => usersByKey[key])),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

const upsertClientAccount = async (definition, usersByKey, resellersByKey) => {
  const assignedUsers = definition.assignedUserKeys.map((key) => usersByKey[key]);
  const clientAccount = await ClientAccount.findOneAndUpdate(
    { companyName: definition.companyName },
    {
      $set: {
        resellerId: resellersByKey[definition.resellerKey]._id,
        companyName: definition.companyName,
        accountStatus: definition.accountStatus,
        plan: definition.plan,
        seatLimit: definition.seatLimit,
        adminUserId: usersByKey[definition.adminUserKey]._id,
        assignedUserIds: toIds(assignedUsers),
        onboardingStatus: 'in_progress',
        onboardingChecklist: [
          { key: 'business_info', label: 'Business information confirmed', completed: true },
          { key: 'admin_user', label: 'Primary administrator assigned', completed: true },
          { key: 'phone_numbers', label: 'Phone numbers reviewed', completed: definition.key !== 'clientA2' },
          { key: 'production_ready', label: 'Ready for production', completed: false },
        ],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await User.updateMany(
    { _id: { $in: toIds(assignedUsers) } },
    { clientAccountId: clientAccount._id }
  );

  return clientAccount;
};

const upsertClientPhoneNumber = async (definition, usersByKey, clientsByKey) => {
  const clientAccount = clientsByKey[definition.clientKey];
  return ClientPhoneNumber.findOneAndUpdate(
    { phoneNumber: definition.phoneNumber },
    {
      $set: {
        phoneNumber: definition.phoneNumber,
        clientAccountId: clientAccount._id,
        resellerId: clientAccount.resellerId || null,
        label: definition.label,
        capabilities: definition.capabilities,
        status: definition.status,
        assignedUserId: definition.assignedUserKey ? usersByKey[definition.assignedUserKey]._id : null,
        assignedDepartment: definition.assignedDepartment || '',
        route: '',
        notes: 'QA test number only. Do not connect to live Twilio routing.',
        source: 'portal',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

const syncLegacyNumberMetadata = async (clientsByKey, numbersByPhone) => {
  for (const clientDefinition of seedClientAccounts) {
    const clientAccount = clientsByKey[clientDefinition.key];
    const clientNumbers = seedNumbers
      .filter((numberDefinition) => numberDefinition.clientKey === clientDefinition.key)
      .map((numberDefinition) => numbersByPhone[numberDefinition.phoneNumber]);

    clientAccount.assignedNumbers = clientNumbers.map((number) => number.phoneNumber);
    clientAccount.assignedNumberRecords = clientNumbers.map((number) => ({
      phoneNumber: number.phoneNumber,
      label: number.label,
      type: number.capabilities.sms ? 'voice+sms' : 'voice',
      status: number.status,
      assignedUserId: number.assignedUserId,
      assignedDepartment: number.assignedDepartment,
      notes: number.notes,
    }));

    await clientAccount.save();
  }
};

const cleanup = async () => {
  const userEmails = seedUsers.map((user) => user.email);
  const resellerCompanyNames = seedResellers.map((reseller) => reseller.companyName);
  const clientCompanyNames = seedClientAccounts.map((client) => client.companyName);
  const phoneNumbers = seedNumbers.map((number) => number.phoneNumber);

  await ClientPhoneNumber.deleteMany({ phoneNumber: { $in: phoneNumbers } });
  await ClientAccount.deleteMany({ companyName: { $in: clientCompanyNames } });
  await Reseller.deleteMany({ companyName: { $in: resellerCompanyNames } });
  await User.deleteMany({ email: { $in: userEmails } });

  console.log('Stage 2 seed data removed.');
};

const run = async () => {
  assertSeedSafety();
  await connectDB();

  try {
    if (getArg('--cleanup')) {
      await cleanup();
      return;
    }

    const usersByKey = {};
    for (const userDefinition of seedUsers) {
      usersByKey[userDefinition.key] = await upsertUser(userDefinition);
    }

    const resellersByKey = {};
    for (const resellerDefinition of seedResellers) {
      resellersByKey[resellerDefinition.key] = await upsertReseller(resellerDefinition, usersByKey);
    }

    const clientsByKey = {};
    for (const clientDefinition of seedClientAccounts) {
      clientsByKey[clientDefinition.key] = await upsertClientAccount(clientDefinition, usersByKey, resellersByKey);
    }

    const numbersByPhone = {};
    for (const numberDefinition of seedNumbers) {
      numbersByPhone[numberDefinition.phoneNumber] = await upsertClientPhoneNumber(
        numberDefinition,
        usersByKey,
        clientsByKey
      );
    }
    await syncLegacyNumberMetadata(clientsByKey, numbersByPhone);

    console.log('Stage 2 reseller/client QA seed data ready.');
    console.log(JSON.stringify({
      password: DEFAULT_PASSWORD,
      users: seedUsers.map((user) => ({
        key: user.key,
        email: user.email,
        role: user.role,
      })),
      resellers: Object.fromEntries(Object.entries(resellersByKey).map(([key, reseller]) => [key, String(reseller._id)])),
      clientAccounts: Object.fromEntries(Object.entries(clientsByKey).map(([key, client]) => [key, String(client._id)])),
      phoneNumbers: seedNumbers.map((number) => ({
        phoneNumber: number.phoneNumber,
        clientKey: number.clientKey,
        status: number.status,
        voice: Boolean(number.capabilities.voice),
      })),
      note: 'Seed data is for local/staging Stage 2 QA only. It does not connect to live Twilio routing.',
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
};

run().catch((error) => {
  console.error('Failed to prepare Stage 2 seed data:', error.message);
  process.exit(1);
});
