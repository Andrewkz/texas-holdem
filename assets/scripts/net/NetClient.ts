import { ClientMessage, ServerMessage } from './protocol';

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

const defaultFactory: SocketFactory = (url: string) => new WebSocket(url) as unknown as WebSocketLike;

export class NetClient {
  public onMessage: ((message: ServerMessage) => void) | null = null;
  public onClose: (() => void) | null = null;
  private socket: WebSocketLike | null = null;

  public constructor(
    private readonly url: string,
    private readonly factory: SocketFactory = defaultFactory,
  ) {}

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.factory(this.url);
      this.socket = socket;

      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`无法连接服务器 ${this.url}`));
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          this.onMessage?.(message);
        } catch {
          // 忽略无法解析的推送
        }
      };
      socket.onclose = () => {
        this.socket = null;
        this.onClose?.();
      };
    });
  }

  public send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  public close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
