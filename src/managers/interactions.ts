import {
  ChannelType,
  composePrompt,
  Content,
  createUniqueUuid,
  EventType,
  type IAgentRuntime,
  logger,
  type Memory,
  MessagePayload,
  ModelType,
  UUID,
} from '@elizaos/core';
import type { Cast as NeynarCast } from '@neynar/nodejs-sdk/build/api/index.js';
import type { FarcasterClient } from '../client';
import { AsyncQueue } from '../common/asyncqueue';
import { standardCastHandlerCallback } from '../common/callbacks';
import { FARCASTER_SOURCE } from '../common/constants';
import { formatCast, formatTimeline } from '../common/prompts';
import { shouldRespondTemplate } from '@elizaos/core';
import {
  type Cast,
  type FarcasterConfig,
  FarcasterEventTypes,
  FarcasterGenericCastPayload,
  type Profile,
} from '../common/types';
import {
  castUuid,
  formatCastTimestamp,
  neynarCastToCast,
} from '../common/utils';
interface FarcasterInteractionParams {
  client: FarcasterClient;
  runtime: IAgentRuntime;
  config: FarcasterConfig;
}

export class FarcasterInteractionManager {
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private isRunning: boolean = false;
  private client: FarcasterClient;
  private runtime: IAgentRuntime;
  private config: FarcasterConfig;

  private asyncQueue: AsyncQueue;

  constructor(opts: FarcasterInteractionParams) {
    this.client = opts.client;
    this.runtime = opts.runtime;
    this.config = opts.config;
    this.asyncQueue = new AsyncQueue(1);
  }

  public async start(): Promise<void> {
    logger.info('Starting Farcaster interactions');
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    // never await this, it will block forever
    void this.runPeriodically();
  }

  public async stop(): Promise<void> {
    if (this.timeout) clearTimeout(this.timeout);
    this.isRunning = false;
  }

  private async runPeriodically(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.handleInteractions();

        // now sleep for the configured interval
        const delay = this.config.FARCASTER_POLL_INTERVAL * 1000;
        await new Promise(
          (resolve) => (this.timeout = setTimeout(resolve, delay))
        );
      } catch (error) {
        logger.error(
          '[Farcaster] Error in periodic interactions:',
          this.runtime.agentId,
          error
        );
      }
    }
  }

  private async ensureCastConnection(cast: Cast): Promise<Memory> {
    return await this.asyncQueue.submit(async () => {
      const memoryId = castUuid({
        agentId: this.runtime.agentId,
        hash: cast.hash,
      });
      const conversationId = cast.threadId ?? cast.inReplyTo?.hash ?? cast.hash;
      const entityId = createUniqueUuid(
        this.runtime,
        cast.authorFid.toString()
      );
      const worldId = createUniqueUuid(this.runtime, cast.authorFid.toString());
      const serverId = cast.authorFid.toString();
      const roomId = createUniqueUuid(this.runtime, conversationId);

      if (entityId !== this.runtime.agentId) {
        await this.runtime.ensureConnection({
          entityId,
          roomId,
          worldName: `${cast.profile.username}'s Farcaster`,
          userName: cast.profile.username,
          name: cast.profile.name,
          source: FARCASTER_SOURCE,
          type: ChannelType.THREAD,
          channelId: conversationId,
          serverId,
          worldId,
          metadata: {
            ownership: { ownerId: cast.authorFid.toString() },
            farcaster: {
              username: cast.profile.username,
              id: cast.authorFid.toString(),
              name: cast.profile.name,
            },
          },
        });
      }

      const memory: Memory = {
        id: memoryId,
        agentId: this.runtime.agentId,
        content: {
          text: cast.text,
          // need to pull imageUrls
          inReplyTo: cast.inReplyTo?.hash
            ? castUuid({
                agentId: this.runtime.agentId,
                hash: cast.inReplyTo.hash,
              })
            : undefined,
          source: FARCASTER_SOURCE,
          channelType: ChannelType.THREAD,
          metadata: {
            fid: cast.authorFid,
            authorFid: cast.authorFid,
            castHash: cast.hash,
            threadId: cast.threadId,
            username: cast.profile.username,
            displayName: cast.profile.name,
          },
        },
        entityId,
        roomId,
        createdAt: cast.timestamp.getTime(),
        ...(cast.authorFid && { fid: cast.authorFid }),
      };

      // no need to store the memory as it'll be stored in bootstrap side

      return memory;
    });
  }

  private async handleInteractions(): Promise<void> {
    const agentFid = this.config.FARCASTER_FID;
    const [mentions, agent] = await Promise.all([
      this.client.getMentions({
        fid: agentFid,
        pageSize: 20,
      }),
      this.client.getProfile(agentFid),
    ]);

    for (const cast of mentions) {
      const mention = neynarCastToCast(cast);
      const memoryId = castUuid({
        agentId: this.runtime.agentId,
        hash: mention.hash,
      });

      if (await this.runtime.getMemoryById(memoryId)) {
        continue;
      }

      logger.info('New Cast found', mention.hash);

      // filter out the agent mentions
      if (mention.authorFid === agentFid) {
        const memory = await this.ensureCastConnection(mention);
        await this.runtime.addEmbeddingToMemory(memory);
        await this.runtime.createMemory(memory, 'messages');
        continue;
      }

      await this.handleMentionCast({ agent, mention, cast });
    }
  }

  async buildThreadForCast(
    cast: Cast,
    skipMemoryId: Set<UUID>
  ): Promise<Cast[]> {
    const thread: Cast[] = [];
    const visited: Set<string> = new Set();
    const client = this.client;
    const runtime = this.runtime;
    const self = this;

    async function processThread(currentCast: Cast) {
      const memoryId = castUuid({
        hash: currentCast.hash,
        agentId: runtime.agentId,
      });

      if (visited.has(currentCast.hash) || skipMemoryId.has(memoryId)) {
        return;
      }

      visited.add(currentCast.hash);

      // Check if the current cast has already been saved
      const memory = await runtime.getMemoryById(memoryId);

      if (!memory) {
        logger.info('Creating memory for cast', currentCast.hash);
        const memory = await self.ensureCastConnection(currentCast);
        await runtime.createMemory(memory, 'messages');
        runtime.emitEvent(FarcasterEventTypes.THREAD_CAST_CREATED, {
          runtime,
          memory,
          cast: currentCast,
          source: FARCASTER_SOURCE,
        });
      }

      thread.unshift(currentCast);

      if (currentCast.inReplyTo) {
        const parentCast = await client.getCast(currentCast.inReplyTo.hash);
        await processThread(neynarCastToCast(parentCast));
      }
    }

    await processThread(cast);
    return thread;
  }

  private async handleMentionCast({
    agent,
    mention,
    cast,
  }: {
    agent: Profile;
    cast: NeynarCast;
    mention: Cast;
  }): Promise<void> {
    const senderFid = mention.authorFid; // <-- Access sender's FID here

    if (mention.profile.fid === agent.fid) {
      logger.info('skipping cast from bot itself', mention.hash);
      return;
    }

    // You can now use senderFid in your logic
    logger.info(
      `Processing mention from FID ${senderFid} (@${mention.profile.username})`
    );

    // Example: Store sender FID in metadata for later use
    const senderFidForLater = senderFid;

    // Process one at a time to ensure proper sequencing
    const memory = await this.ensureCastConnection(mention);
    const thread: Cast[] = await this.buildThreadForCast(
      mention,
      memory.id ? new Set([memory.id]) : new Set()
    );

    if (!memory.content.text || memory.content.text.trim() === '') {
      logger.info('skipping cast with no text', mention.hash);
      return;
    }

    // Build the state for the prompt
    const currentPost = formatCast(mention);
    const { timeline } = await this.client.getTimeline({
      fid: agent.fid,
      pageSize: 20,
    });
    const formattedTimeline = formatTimeline(this.runtime.character, timeline);
    const formattedConversation = thread
      .map((c) =>
        `
        - @${c.profile.username} (${formatCastTimestamp(c.timestamp)}):
          ${c.text}`.trim()
      )
      .join('\n\n');

    const state = await this.runtime.composeState(memory);
    state.values = {
      ...state.values,
      agentName: this.runtime.character.name || agent.name || agent.username,
      farcasterUsername: agent.username,
      timeline: formattedTimeline,
      currentPost,
      formattedConversation,
    };

    // DEBUG: Log state details
    console.log('=== STATE DEBUG ===');
    console.log('State.values:', JSON.stringify(state.values, null, 2));
    console.log('Character name:', this.runtime.character.name);
    console.log('Agent name:', agent.name);
    console.log('Agent username:', agent.username);
    console.log('=== END STATE DEBUG ===');

    // TEMPORARILY DISABLE OVERRIDE TO TEST TEMPLATE STRUCTURES
    // if (shouldRespondOverride === 'true' || shouldRespondOverride === true) {
    //   logger.info(
    //     'FARCASTER_ALWAYS_RESPOND/DISABLE_SHOULD_RESPOND is enabled, skipping shouldRespond template and proceeding to respond'
    //   );
    // } else {

    // Determine if we should respond to the cast
    // console.log('=== TEMPLATE DETECTION DEBUG ===');
    // console.log('character.templates:', this.runtime.character.templates);
    // console.log(
    //   'farcasterShouldRespondTemplate:',
    //   this.runtime.character.templates?.farcasterShouldRespondTemplate
    // );
    // console.log(
    //   'shouldRespondTemplate:',
    //   this.runtime.character?.templates?.shouldRespondTemplate
    // );
    // console.log('fallback shouldRespondTemplate:', shouldRespondTemplate);

    let template =
      this.runtime.character.templates?.farcasterShouldRespondTemplate ||
      this.runtime.character?.templates?.shouldRespondTemplate ||
      shouldRespondTemplate;

    // console.log('Selected template before function check:', template);
    // console.log('Template type before function check:', typeof template);

    // If template is a function, execute it to get the actual template string
    if (typeof template === 'function') {
      console.log('Template IS a function, executing...');
      try {
        // Try calling with state parameter first (for standard template functions)
        template = template({ state });
        console.log('Function executed with state param, result:', template);
      } catch {
        // Fall back to calling with no parameters (for simple character config functions)
        template = (template as any)();
        console.log('Function executed with no params, result:', template);
      }
    } else {
      console.log('Template is NOT a function');
    }

    // console.log('Final template:', template);
    // console.log('=== END TEMPLATE DETECTION DEBUG ===');

    // // DEBUG: Log inputs to composePrompt
    // console.log('=== COMPOSE PROMPT INPUT DEBUG ===');
    // console.log('State object:', state);
    // console.log('State.values keys:', Object.keys(state.values));
    // console.log('State.values.agentName:', state.values.agentName);
    // console.log(
    //   'Template contains {{agentName}}:',
    //   (template as string).includes('{{agentName}}')
    // );
    // console.log(
    //   'Template contains {{providers}}:',
    //   (template as string).includes('{{providers}}')
    // );

    // Try different state structures to see what composePrompt expects
    // console.log('=== TESTING DIFFERENT STATE STRUCTURES ===');

    // Test 1: Pass values directly as state
    const testState1 = state.values;
    const testPrompt1 = composePrompt({
      state: testState1 as any,
      template,
    });
    console.log(
      'Test 1 - Direct values as state:',
      testPrompt1.substring(0, 100)
    );

    // Test 2: Put agentName at top level of state
    const testState2 = {
      ...state,
      agentName: state.values.agentName,
      providers: state.values.providers || '',
    };
    const testPrompt2 = composePrompt({
      state: testState2 as any,
      template,
    });
    console.log('Test 2 - Top level agentName:', testPrompt2.substring(0, 100));

    // Test 3: Create minimal state with just what we need
    const testState3 = {
      agentName: state.values.agentName,
      providers: state.values.providers || '',
    };
    const testPrompt3 = composePrompt({
      state: testState3 as any,
      template,
    });
    console.log('Test 3 - Minimal state:', testPrompt3.substring(0, 100));

    console.log('=== END TESTING ===');
    console.log('=== END COMPOSE PROMPT INPUT DEBUG ===');

    // USE THE WORKING APPROACH FROM TEST 3
    const workingState = {
      agentName: state.values.agentName,
      providers: state.values.providers || '',
    };

    const shouldRespondPrompt = composePrompt({
      state: workingState as any,
      template,
    });

    // console.log('=== USING WORKING STATE STRUCTURE ===');
    // console.log('Working state:', workingState);
    // console.log(
    //   'Working prompt result:',
    //   shouldRespondPrompt.substring(0, 100)
    // );
    // console.log('=== END WORKING STATE TEST ===');

    // AGGRESSIVE MANUAL FIX: Force replace all placeholders
    let finalPrompt = shouldRespondPrompt;

    // Replace all variations of agentName placeholders
    const agentName = state.values.agentName || 'agent';
    finalPrompt = finalPrompt.replace(/\{\{agentName\}\}/g, agentName);
    finalPrompt = finalPrompt.replace(/\{\{\s*agentName\s*\}\}/g, agentName);

    // Replace providers placeholder (usually empty)
    const providers = state.values.providers || '';
    finalPrompt = finalPrompt.replace(/\{\{providers\}\}/g, providers);
    finalPrompt = finalPrompt.replace(/\{\{\s*providers\s*\}\}/g, providers);

    // DEBUG: Check if substitution worked
    console.log('=== COMPOSE PROMPT OUTPUT DEBUG ===');
    console.log('Original shouldRespond prompt:', shouldRespondPrompt);
    console.log('Fixed shouldRespond prompt:', finalPrompt);
    console.log(
      'shouldRespond prompt contains agentName:',
      finalPrompt.includes(agentName)
    );
    console.log(
      'shouldRespond prompt still has {{agentName}}:',
      finalPrompt.includes('{{agentName}}')
    );
    console.log(
      'shouldRespond prompt still has {{providers}}:',
      finalPrompt.includes('{{providers}}')
    );
    console.log('=== END COMPOSE PROMPT OUTPUT DEBUG ===');

    const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: finalPrompt,
    });

    // DEBUG: Log AI response details
    console.log('AI response:', JSON.stringify(response));
    console.log('AI response type:', typeof response);
    console.log('AI response raw:', response);

    const responseActions = (response.match(
      /(?:RESPOND|REPLY|IGNORE|STOP)/g
    ) || ['IGNORE'])[0];

    // DEBUG: Log extraction results
    console.log('Extracted action:', responseActions);
    console.log(
      'Match result:',
      response.match(/(?:RESPOND|REPLY|IGNORE|STOP)/g)
    );
    console.log('=== END DEBUG ===');

    // setup callback for the response
    const callback = standardCastHandlerCallback({
      client: this.client,
      runtime: this.runtime,
      config: this.config,
      roomId: memory.roomId,
      inReplyTo: {
        hash: mention.hash,
        fid: mention.authorFid,
      },
    });

    // CRITICAL: Store FID in runtime cache for easy access
    const fidCacheKey = `farcaster:fid:${memory.id}`;
    await this.runtime.setCache(fidCacheKey, {
      fid: senderFid,
      authorFid: senderFid,
      username: mention.profile.username,
      displayName: mention.profile.name,
      castHash: mention.hash,
    });

    // ARCHITECTURAL FIX: Create memory and emit events BEFORE shouldRespond check
    // This ensures actions can run regardless of character response decisions
    try {
      await this.runtime.createMemory(memory, 'messages');
    } catch (error) {
      logger.error('Error creating memory', error);
    }

    // Emit platform-specific MENTION_RECEIVED event with enhanced FID data
    const mentionPayload: FarcasterGenericCastPayload = {
      runtime: this.runtime,
      memory,
      cast,
      source: FARCASTER_SOURCE,
      // ENHANCED: Add FID data directly to payload
      fid: senderFid,
      authorFid: senderFid,
      username: mention.profile.username,
      callback: async (ontent: Content, _files: any[]) => {
        logger.info(
          '[Farcaster] mention received response (callback executed)'
        );
        return [];
      },
    };
    this.runtime.emitEvent(
      FarcasterEventTypes.MENTION_RECEIVED,
      mentionPayload
    );

    // CRITICAL: Process voting actions after emitting event
    // This ensures voting actions run regardless of shouldRespond decision
    try {
      const actions = this.runtime.actions || [];
      const votingActionNames = [
        'CAST_VOTE',
        'SUBMIT_MEMBER',
        'GET_VOTING_STATS',
        'CHECK_MEMBERSHIP',
        'CHECK_PROPOSAL_STATUS',
        'SUBMIT_REMOVAL',
        'REJOIN_GROUP',
        'INITIALIZE_VOTING',
        'WEBHOOK_PROPOSAL',
      ];

      const votingActions = actions.filter((action) =>
        votingActionNames.includes(action.name)
      );

      logger.info(
        `Processing ${
          votingActions.length
        } voting actions for message: ${memory.content.text?.substring(
          0,
          50
        )}...`
      );

      for (const action of votingActions) {
        try {
          const isValid = await action.validate(this.runtime, memory);
          if (isValid) {
            logger.info(
              `Voting action ${action.name} validated successfully, executing handler...`
            );
            await action.handler(this.runtime, memory, state, {}, callback);
          }
        } catch (actionError) {
          logger.error(
            `Error processing voting action ${action.name}:`,
            actionError
          );
        }
      }
    } catch (error) {
      logger.error('Error processing voting actions:', error);
    }

    // Character response decision - actions have already been triggered above
    if (responseActions !== 'RESPOND' && responseActions !== 'REPLY') {
      logger.info(
        `Not responding to cast based on shouldRespond decision: ${responseActions} (but actions were processed)`
      );
      return;
    }
  }
}
