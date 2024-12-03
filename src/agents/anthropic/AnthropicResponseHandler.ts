import Anthropic from '@anthropic-ai/sdk';
import type { Stream } from '@anthropic-ai/sdk/streaming';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import type { Channel, MessageResponse, StreamChat } from 'stream-chat';

export class AnthropicResponseHandler {
  private message_text = '';
  private chunk_counter = 0;

  constructor(
    private readonly anthropicStream: Stream<RawMessageStreamEvent>,
    private readonly chatClient: StreamChat,
    private readonly channel: Channel,
    private readonly message: MessageResponse,
  ) {
    this.chatClient.on('ai_indicator.stop', this.handleStopGenerating);
  }

  run = async () => {
    for await (const messageStreamEvent of this.anthropicStream) {
      try {
        await this.handle(messageStreamEvent);
      } catch (error) {
        console.error('Error handling message stream event', error);
      }
    }
  };

  dispose = () => {
    this.chatClient.off('ai_indicator.stop', this.handleStopGenerating);
  };

  private handleStopGenerating = async () => {
    console.log('Stop generating');
    if (!this.anthropicStream) {
      console.log('Anthropic not initialized');
      return;
    }
    this.anthropicStream.controller.abort();
    await this.chatClient.partialUpdateMessage(this.message.id, {
      set: { generating: false },
    });
    await this.channel.sendEvent({
      // @ts-expect-error - will become available in the next version of the types
      type: 'ai_indicator.clear',
      message_id: this.message.id,
    });
  };

  private handle = async (
    messageStreamEvent: Anthropic.Messages.RawMessageStreamEvent,
  ) => {
    switch (messageStreamEvent.type) {
      case 'content_block_start':
        await this.channel.sendEvent({
          // @ts-expect-error
          type: 'ai_indicator.update',
          ai_state: 'AI_STATE_GENERATING',
          message_id: this.message.id,
        });
        break;
      case 'content_block_delta':
        if (messageStreamEvent.delta.type !== 'text_delta') break;
        this.message_text += messageStreamEvent.delta.text;
        this.chunk_counter++;
        if (
          this.chunk_counter % 15 === 0 ||
          (this.chunk_counter < 8 && this.chunk_counter % 2 !== 0)
        ) {
          await this.chatClient.partialUpdateMessage(this.message.id, {
            set: { text: this.message_text, generating: true },
          });
        }
        break;
      case 'message_stop':
        await this.chatClient.partialUpdateMessage(this.message.id, {
          set: { text: this.message_text, generating: false },
        });
        await this.channel.sendEvent({
          // @ts-expect-error
          type: 'ai_indicator.clear',
          message_id: this.message.id,
        });
        break;
    }
  };
}