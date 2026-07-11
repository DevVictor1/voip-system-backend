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

    const [
      activeConversationsAgg,
      callDurationAgg,
      smsDelivered,
      missedCalls,
    ] = await Promise.all([
      Message.aggregate([
        { $match: { direction: 'outbound' } },
        { $group: { _id: '$to' } },
        {
          $unionWith: {
            coll: Message.collection.name,
            pipeline: [
              { $match: { direction: { $ne: 'outbound' } } },
              { $group: { _id: '$from' } }
            ]
          }
        },
        { $group: { _id: '$_id' } },
        { $count: 'count' }
      ]),
      Call.aggregate([
        { $match: { createdAt: { $gte: startOfDay } } },
        {
          $group: {
            _id: null,
            totalSeconds: {
              $sum: {
                $convert: {
                  input: '$duration',
                  to: 'double',
                  onError: 0,
                  onNull: 0
                }
              }
            }
          }
        }
      ]),
      Message.countDocuments({
        direction: 'outbound',
        status: { $in: ['delivered', 'sent'] }
      }),
      Call.countDocuments({
        status: { $in: ['missed', 'no-answer', 'no_answer', 'noanswer', 'busy', 'failed'] }
      })
    ]);

    const activeConversations = activeConversationsAgg[0]?.count || 0;
    const totalSeconds = Number(callDurationAgg[0]?.totalSeconds) || 0;
    const dailyCallMinutes = Math.round((totalSeconds / 60) * 10) / 10;

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
