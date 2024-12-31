import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { AIAgent } from './agents/types';
import { createAgent } from './agents/createAgent';
import { apiKey, serverClient } from './serverClient';
import { getAIAgentInfo } from './lib/agent';
import { AnthropicResponseHandler } from './agents/anthropic/AnthropicResponseHandler';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Map to store the AI Agent instances
// [cid: string]: AI Agent
const aiAgentCache = new Map<string, AIAgent>();
const pendingAiAgents = new Set<string>();

// TODO: temporary set to 8 hours, should be cleaned up at some point
const inactivityThreshold = 480 * 60 * 1000;
setInterval(async () => {
  const now = Date.now();
  for (const [userId, aiAgent] of aiAgentCache) {
    if (now - aiAgent.getLastInteraction() > inactivityThreshold) {
      console.log(`Disposing AI Agent due to inactivity: ${userId}`);
      await disposeAiAgent(aiAgent, userId);
      aiAgentCache.delete(userId);
    }
  }
}, 5000);

app.get('/', (req, res) => {
  res.json({
    message: 'GetStream AI Server is running',
    apiKey: apiKey,
    activeAgents: aiAgentCache.size,
  });
});

/**
 * Handle the request to start the AI Agent
 */
app.post('/start-ai-agent', async (req, res) => {
  const {
    channel_id,
    channel_type = 'messaging',
    platform = 'anthropic',
  } = req.body;

  console.log('DEBUG: Starting AI Agent for channel_id: ', channel_id);
  // Validation for channel_id
  if (!channel_id) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  // Get channel id
  let channel_id_updated = channel_id;
  if (channel_id.includes(':')) {
    const parts = channel_id.split(':');
    if (parts.length > 1) {
      channel_id_updated = parts[1];
    }
  }

  // Get channel
  const channel = serverClient.channel(channel_type, channel_id_updated);

  // Get channel members
  const channelMembers = await channel.queryMembers({});

  // Finds the member that is an AI Agent by checking the isAIAgent flag
  const aiAgent = channelMembers.members.find(
    (member) => !!member.user?.isAIAgent,
  );

  if (!aiAgent || !aiAgent.user?.id) {
    res.status(400).json({ error: 'AI Agent not found in the channel' });
    return;
  }

  // Get Agent info from supabase
  const agent_id = aiAgent.user?.id;
  const agentInfo = await getAIAgentInfo(agent_id);

  // Add null check and provide default values
  if (!agentInfo) {
    console.warn(
      `Failed to fetch agent info for ${agent_id}, using default values`,
    );
  }

  console.log('agentInfo', agentInfo);

  try {
    if (!aiAgentCache.has(agent_id) && !pendingAiAgents.has(agent_id)) {
      pendingAiAgents.add(agent_id);

      if (!aiAgent) {
        await channel.addMembers([agent_id]);
      }

      await channel.watch();

      const agent = await createAgent(
        agent_id,
        platform,
        channel_type,
        channel_id_updated,
        agentInfo, // Provide default values
      );

      await agent.init();
      if (aiAgentCache.has(agent_id)) {
        await agent.dispose();
      } else {
        aiAgentCache.set(agent_id, agent);
      }
    } else {
      console.log(`AI Agent ${agent_id} already started`);
    }

    res.json({ message: 'AI Agent started', data: [] });
  } catch (error) {
    const errorMessage = (error as Error).message;
    console.error('Failed to start AI Agent', errorMessage);
    res
      .status(500)
      .json({ error: 'Failed to start AI Agent', reason: errorMessage });
  } finally {
    pendingAiAgents.delete(agent_id);
  }
});

/**
 * Handle the request to stop the AI Agent
 */
app.post('/stop-ai-agent', async (req, res) => {
  const { channel_id } = req.body;
  const channel_type = 'messaging';

  if (!channel_id) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const channel = serverClient.channel(channel_type, channel_id);
  const channelMembers = await channel.queryMembers({});

  const aiAgent = channelMembers.members.find(
    (member) => !!member.user?.isAIAgent,
  );

  if (!aiAgent || !aiAgent.user?.id) {
    res.status(400).json({ error: 'AI Agent not found in the channel' });
    return;
  }

  const agent_id = aiAgent.user?.id;

  try {
    //const userId = `ai-bot-${channel_id.replace(/!/g, '')}`;
    const aiAgent = aiAgentCache.get(agent_id);
    if (aiAgent) {
      await disposeAiAgent(aiAgent, agent_id);
      aiAgentCache.delete(agent_id);
    }
    res.json({ message: 'AI Agent stopped', data: [] });
  } catch (error) {
    const errorMessage = (error as Error).message;
    console.error('Failed to stop AI Agent', errorMessage);
    res
      .status(500)
      .json({ error: 'Failed to stop AI Agent', reason: errorMessage });
  }
});

async function disposeAiAgent(aiAgent: AIAgent, userId: string) {
  await aiAgent.dispose();

  // const channel = serverClient.channel(
  //   aiAgent.channel.type,
  //   aiAgent.channel.id,
  // );
  // await channel.removeMembers([userId]);
}

app.post('/new-ai-message', async (req, res) => {
  const {
    channel_id,
    channel_type = 'messaging',
    platform = 'anthropic',
  } = req.body;

  if (!channel_id) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  let channel_id_updated = channel_id;
  if (channel_id.includes(':')) {
    const parts = channel_id.split(':');
    if (parts.length > 1) {
      channel_id_updated = parts[1];
    }
  }

  const channel = serverClient.channel(channel_type, channel_id_updated);
  const channelMembers = await channel.queryMembers({});

  const aiAgent = channelMembers.members.find(
    (member) => !!member.user?.isAIAgent,
  );

  if (!aiAgent || !aiAgent.user?.id) {
    res.status(400).json({ error: 'AI Agent not found in the channel' });
    return;
  }

  const agent_id = aiAgent.user?.id;

  const agentInfo = await getAIAgentInfo(agent_id);

  // Add null check and provide default values
  if (!agentInfo) {
    console.warn(
      `Failed to fetch agent info for ${agent_id}, using default values`,
    );
  }
  console.log('agentInfo', agentInfo);
  try {
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    let agentProfile = '';

    const gender = agentInfo?.gender || 'female';

    if (gender === 'female') {
      agentProfile = `You are a virtual girlfried named ${agentInfo.name}.`;
    } else {
      agentProfile = `You are a virtual boyfriend named ${agentInfo.name}.`;
    }
    agentProfile +=
      'You have personality: ' +
      agentInfo.personality +
      'and you style is ' +
      `${agentInfo.style}` +
      '.' +
      'Your traits are: ' +
      agentInfo.traits +
      +'Your quirks are: ' +
      agentInfo.quirks +
      '.' +
      `You have a biography: ${agentInfo.bio}.`;

    const response = await anthropic.messages.create({
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content:
            'Write a short, friendly welcome message for the user. Make it short. Do not include any actions, emotes, or asterisks. Provide the direct speech/message. Use emojis to express emotions instead of action text or emotes. Keep it natural and friendly.',
        },
      ],
      model: 'claude-3-5-sonnet-20241022',
      stream: false,
      system: agentProfile,
    });

    if (response.content[0].type === 'text' && response.content[0].text) {
      await channel.sendMessage({
        text: response.content[0].text,
        ai_generated: true,
        user_id: agent_id,
      });
    }

    res.json({ message: 'AI Agent started', data: [] });
  } catch (error) {
    const errorMessage = (error as Error).message;
    console.error('Failed to start AI Agent', errorMessage);
    res
      .status(500)
      .json({ error: 'Failed to start AI Agent', reason: errorMessage });
  } finally {
    pendingAiAgents.delete(agent_id);
  }
});

// Start the Express server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
