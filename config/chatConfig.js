const INTERNAL_AGENTS = {
  agent_1: { name: 'Tech Support - Slot 1', role: 'Tech Support' },
  agent_2: { name: 'Tech Support - Slot 2', role: 'Tech Support' },
  agent_3: { name: 'Customer Support - Slot 1', role: 'Customer Support' },
  agent_4: { name: 'Sales - Slot 1', role: 'Sales' },
  agent_5: { name: 'Sales - Slot 2', role: 'Sales' },
};

const TEAM_CHATS = [
  {
    id: 'team_tech',
    name: 'Tech Team',
    participants: ['agent_1'],
  },
  {
    id: 'team_customer_service',
    name: 'Customer Support Team',
    participants: ['agent_3'],
  },
  {
    id: 'team_sales',
    name: 'Sales Team',
    participants: ['agent_4', 'agent_5'],
  },
  {
    id: 'team_agents',
    name: 'Agent Channel',
    participants: ['agent_1', 'agent_2', 'agent_3', 'agent_4', 'agent_5'],
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
  TEAM_CHATS,
  buildDmConversationId,
  getAgentMeta,
};
