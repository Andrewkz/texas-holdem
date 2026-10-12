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
    if (this.socket) {
      return Promise.reject(new Error('已连接或正在连接'));
    }

    return new Promise((resolve, reject) => {
      const socket = this.factory(this.url);
      this.socket = socket;
      let settled = false;

      socket.onopen = () => {
        if (this.socket !== socket || settled) {
          return;
        }
        settled = true;
        resolve();
      };
      socket.onerror = () => {
        if (this.socket !== socket || settled) {
          return;
        }
        settled = true;
        reject(new Error(`无法连接服务器 ${this.url}`));
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) {
          return;
        }
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          this.onMessage?.(message);
        } catch {
          // 忽略无法解析的推送
        }
      };
      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        if (!settled) {
          settled = true;
          reject(new Error('连接已关闭'));
        }
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
