import supabase from './supabase';

export async function getAIAgentInfo(agent_id: string) {
  console.log('Getting AI agent info for:', agent_id);
  const { data, error } = await supabase
    .from('ai_agents')
    .select('*')
    .eq('id', agent_id)
    .single();

  if (error) {
    console.error('Error fetching AI agent info:', error);
    return null;
  }
  return data;
}
