export interface RouterMessage {
    chatId: number;
    userId?: number;
    text: string;
    metadata?: Record<string, any>;
}

export interface Channel {
    id: string;
    send(message: RouterMessage): Promise<void>;
}

export type ReceiveHandler = (channelId: string, message: RouterMessage) => Promise<void>;

class Router {
    private channels = new Map<string, Channel>();
    private handlers: ReceiveHandler[] = [];

    register(channel: Channel) {
        this.channels.set(channel.id, channel);
        console.log(`🔌 Channel registered: ${channel.id}`);
    }

    receive(handler: ReceiveHandler) {
        this.handlers.push(handler);
    }

    async send(channelId: string, message: RouterMessage) {
        const channel = this.channels.get(channelId);
        if (!channel) {
            console.error(`❌ Channel not found: ${channelId}`);
            return;
        }
        await channel.send(message);
    }

    async dispatch(channelId: string, message: RouterMessage) {
        for (const handler of this.handlers) {
            await handler(channelId, message);
        }
    }
}

export const router = new Router();
