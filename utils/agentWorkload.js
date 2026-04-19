const User = require('../models/User');

const normalizeAgentId = (value) => String(value || '').trim();

const buildCapacityFilter = (respectCapacity) => (
  respectCapacity
    ? {
        $expr: {
          $lt: [
            { $ifNull: ['$currentActiveChats', 0] },
            { $ifNull: ['$maxActiveChats', 5] },
          ],
        },
      }
    : {}
);

const incrementAgentWorkload = async (agentId, options = {}) => {
  const normalizedAgentId = normalizeAgentId(agentId);

  if (!normalizedAgentId) {
    return null;
  }

  const { respectCapacity = false } = options;

  return User.findOneAndUpdate(
    {
      agentId: normalizedAgentId,
      ...buildCapacityFilter(respectCapacity),
    },
    {
      $inc: { currentActiveChats: 1 },
    },
    {
      returnDocument: 'after',
    }
  ).select('agentId currentActiveChats maxActiveChats');
};

const decrementAgentWorkload = async (agentId) => {
  const normalizedAgentId = normalizeAgentId(agentId);

  if (!normalizedAgentId) {
    return null;
  }

  return User.findOneAndUpdate(
    {
      agentId: normalizedAgentId,
      currentActiveChats: { $gt: 0 },
    },
    {
      $inc: { currentActiveChats: -1 },
    },
    {
      returnDocument: 'after',
    }
  ).select('agentId currentActiveChats maxActiveChats');
};

const syncAssignmentWorkload = async (previousAgentId, nextAgentId, options = {}) => {
  const previous = normalizeAgentId(previousAgentId);
  const next = normalizeAgentId(nextAgentId);

  if (previous === next) {
    return {
      previous,
      next,
      decremented: null,
      incremented: null,
      changed: false,
    };
  }

  const { respectNextCapacity = false } = options;

  const decremented = previous
    ? await decrementAgentWorkload(previous)
    : null;

  const incremented = next
    ? await incrementAgentWorkload(next, { respectCapacity: respectNextCapacity })
    : null;

  return {
    previous,
    next,
    decremented,
    incremented,
    changed: true,
  };
};

module.exports = {
  normalizeAgentId,
  incrementAgentWorkload,
  decrementAgentWorkload,
  syncAssignmentWorkload,
};
