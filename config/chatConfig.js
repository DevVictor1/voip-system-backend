const INTERNAL_AGENTS = {
  agent_1: { name: 'John Doe', role: 'Tech Support' },
  agent_2: { name: 'Sarah Lee', role: 'Customer Service' },
  agent_3: { name: 'Mike Chen', role: 'Sales' },
};

const TEAM_CHATS = [
  {
    id: 'team_tech',
    name: 'Tech Team',
    participants: ['agent_1'],
  },
  {
    id: 'team_customer_service',
    name: 'Customer Service Team',
    participants: ['agent_2'],
  },
  {
    id: 'team_sales',
    name: 'Sales Team',
    participants: ['agent_3'],
  },
  {
    id: 'team_agents',
    name: 'Agent Channel',
    participants: ['agent_1', 'agent_2', 'agent_3'],
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
