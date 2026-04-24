require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const TextingGroup = require('../models/TextingGroup');

const DEFAULT_GROUP = {
  name: 'Text Support Group',
  slug: 'text_support_group',
  assignedNumber: '+12605440829', // Replace with a valid Twilio number in your account
  isActive: true,
};

const readArgValue = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index === -1) return '';
  return String(process.argv[index + 1] || '').trim();
};

const parseMembersArg = () => {
  const rawMembers = readArgValue('--members');
  if (!rawMembers) return [];

  return [...new Set(
    rawMembers
      .split(',')
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
};

const resolveTargetUser = async () => {
  const agentId = readArgValue('--agentId');
  const email = readArgValue('--email').toLowerCase();

  if (agentId) {
    return User.findOne({ agentId }).select('name email agentId role isActive');
  }

  if (email) {
    return User.findOne({ email }).select('name email agentId role isActive');
  }

  return null;
};

async function run() {
  await connectDB();

  try {
    const cleanup = process.argv.includes('--cleanup');

    if (cleanup) {
      const deleted = await TextingGroup.findOneAndDelete({ slug: DEFAULT_GROUP.slug });
      if (deleted) {
        console.log(`Deleted temporary texting group: ${deleted.slug}`);
      } else {
        console.log(`No texting group found for slug: ${DEFAULT_GROUP.slug}`);
      }
      return;
    }

    const membersFromArg = parseMembersArg();
    const user = membersFromArg.length === 0
      ? await resolveTargetUser()
      : null;

    if (membersFromArg.length === 0 && !user) {
      throw new Error('No matching user found. Pass --members <agentId1,agentId2> or use --agentId <agentId> / --email <email>.');
    }

    if (user && !user.agentId) {
      throw new Error(`User "${user.email}" does not have an agentId. TextingGroup.members must use agentId strings.`);
    }

    const nextMembers = membersFromArg.length > 0
      ? membersFromArg
      : [...new Set([user.agentId])];
    const createdBy = nextMembers[0];

    const textingGroup = await TextingGroup.findOneAndUpdate(
      { slug: DEFAULT_GROUP.slug },
      {
        $set: {
          ...DEFAULT_GROUP,
          createdBy,
          members: nextMembers,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    console.log('Temporary texting group ready for testing:');
    console.log(JSON.stringify({
      id: textingGroup._id,
      name: textingGroup.name,
      slug: textingGroup.slug,
      assignedNumber: textingGroup.assignedNumber,
      members: textingGroup.members,
      createdBy: textingGroup.createdBy,
      isActive: textingGroup.isActive,
      targetUser: user ? {
        name: user.name,
        email: user.email,
        agentId: user.agentId,
      } : null,
      note: 'Temporary test helper only. Safe to delete after texting-group unread testing.',
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error('Failed to seed temporary texting group:', error.message);
  process.exit(1);
});
