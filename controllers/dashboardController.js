const Call = require('../models/Call');
const Message = require('../models/Message');

const getStartOfDay = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start;
};

exports.getStats = async (req, res) => {
  try {
    const startOfDay = getStartOfDay();

    const activeConversationsAgg = await Message.aggregate([
      {
        $project: {
          key: {
            $cond: [
              { $eq: ['$direction', 'outbound'] },
              '$to',
              '$from'
            ]
          }
        }
      },
      { $group: { _id: '$key' } },
      { $count: 'count' }
    ]);

    const activeConversations = activeConversationsAgg[0]?.count || 0;

    const callsToday = await Call.find({ createdAt: { $gte: startOfDay } });
    const totalSeconds = callsToday.reduce((sum, call) => {
      const seconds = Number(call.duration);
      return Number.isFinite(seconds) ? sum + seconds : sum;
    }, 0);
    const dailyCallMinutes = Math.round((totalSeconds / 60) * 10) / 10;

    const smsDelivered = await Message.countDocuments({
      direction: 'outbound',
      status: { $in: ['delivered', 'sent'] }
    });

    const missedCalls = await Call.countDocuments({
      status: { $in: ['missed', 'no-answer', 'no_answer', 'noanswer', 'busy', 'failed'] }
    });

    res.json({
      activeConversations,
      dailyCallMinutes,
      smsDelivered,
      missedCalls
    });
  } catch (error) {
    console.error('❌ Dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to load stats' });
  }
};
