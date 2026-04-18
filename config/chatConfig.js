const INTERNAL_AGENTS = {
  agent_1: { name: 'Tech Support - Slot 1', role: 'Tech Support' },
  agent_2: { name: 'Tech Support - Slot 2', role: 'Tech Support' },
  agent_3: { name: 'Customer Support - Slot 1', role: 'Customer Support' },
  agent_4: { name: 'Sales - Slot 1', role: 'Sales' },
  agent_5: { name: 'Sales - Slot 2', role: 'Sales' },
};

const TEAM_CHANNELS = [
  {
    id: 'team_tech',
    name: 'Tech Support Team',
    department: 'tech',
    members: ['agent_1', 'agent_2'],
  },
  {
    id: 'team_support',
    name: 'Customer Support Team',
    department: 'support',
    members: ['agent_3'],
  },
  {
    id: 'team_sales',
    name: 'Sales Team',
    department: 'sales',
    members: ['agent_4', 'agent_5'],
  },
];

const buildDmConversationId = (agentA, agentB) => {
  const participants = [agentA, agentB].filter(Boolean).sort();
  return `dm:${participants.join(':')}`;
};

const getAgentMeta = (agentId) => {
  return INTERNAL_AGENTS[agentId] || { name: agentId, role: 'Agent' };
};

module.exports = {
  INTERNAL_AGENTS,
  TEAM_CHANNELS,
  buildDmConversationId,
  getAgentMeta,
};
