import { ClientMessage, parseServerMessage, PROTOCOL_VERSION, ServerMessage } from './protocol';

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => WebSocketLike;
export interface NetClientTimings {
  connectTimeoutMs?: number;
  helloTimeoutMs?: number;
  joinedTimeoutMs?: number;
}
const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;
const mismatch = () => Object.assign(new Error('联机版本不兼容，请刷新页面或升级服务器'), { code: 'protocol-mismatch' });
export type Admission = Extract<ServerMessage,{type:'joined'|'leftIdentity'|'sessionEnded'}>;
type Joined = Extract<ServerMessage, { type: 'joined' }>;

export class NetClient {
  public onMessage: ((message: ServerMessage) => void) | null = null;
  public onClose: (() => void) | null = null;
  private socket: WebSocketLike | null = null;
  private negotiated = false;
  private cancelConnect: ((error: Error) => void) | null = null;
  private listeners = new Set<(message: ServerMessage) => void>();
  private responseWaiters = new Set<{predicate:(message:ServerMessage)=>boolean;resolve:(message:ServerMessage)=>void;reject:(error:Error)=>void}>();
  private joinedWaiters = new Set<{ resolve: (message: Joined) => void; reject: (error: Error) => void }>();

  public constructor(private readonly url: string, private readonly factory: SocketFactory = defaultFactory,
    private readonly timings: NetClientTimings = {}) {}

  public connect(timeoutMs?: number): Promise<void> {
    if (this.socket) return Promise.reject(new Error('已连接或正在连接'));
    return new Promise((resolve, reject) => {
      const socket = this.factory(this.url);
      this.socket = socket;
      this.negotiated = false;
      const started = Date.now();
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelConnect = null;
        if (this.socket === socket) {
          this.socket = null;
          this.negotiated = false;
          this.rejectJoined(error);
          socket.close();
        }
        reject(error);
      };
      this.cancelConnect = fail;
      timer = setTimeout(() => fail(new Error('连接超时')), Math.min(this.timings.connectTimeoutMs ?? 10_000, timeoutMs ?? Infinity));
      socket.onopen = () => {
        if (this.socket !== socket || settled) return;
        clearTimeout(timer);
        const remaining = timeoutMs === undefined ? Infinity : Math.max(0, timeoutMs - (Date.now() - started));
        timer = setTimeout(() => fail(mismatch()), Math.min(this.timings.helloTimeoutMs ?? 5_000, remaining));
        socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
      };
      socket.onerror = () => {
        if (this.socket !== socket) return;
        if (!settled) fail(new Error(`无法连接服务器 ${this.url}`));
        else this.disconnect(new Error('连接异常'), true);
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        let raw: unknown;
        try { raw = JSON.parse(String(event.data)); } catch { raw = null; }
        const message = parseServerMessage(raw);
        if (!this.negotiated) {
          if (message?.type !== 'hello' || message.protocolVersion !== PROTOCOL_VERSION) { fail(mismatch()); return; }
          settled = true;
          clearTimeout(timer);
          this.cancelConnect = null;
          this.negotiated = true;
          resolve();
          return;
        }
        if (!message || message.type === 'hello') {
          this.onMessage?.({ type: 'error', code: 'protocol-mismatch', message: mismatch().message });
          if (this.socket === socket) this.disconnect(mismatch(), false);
          return;
        }
        for(const waiter of Array.from(this.responseWaiters)) {
          if(message.type==='error') waiter.reject(Object.assign(new Error(message.message),{code:message.code}));
          else if(waiter.predicate(message)) waiter.resolve(message);
        }
        for(const listener of Array.from(this.listeners)) listener(message);
        if (message.type === 'joined') {
          for (const waiter of Array.from(this.joinedWaiters)) waiter.resolve(message);
        } else if (message.type === 'error') {
          this.rejectJoined(Object.assign(new Error(message.message), { code: message.code }));
        }
        this.onMessage?.(message);
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        if (!settled) { fail(new Error('连接已关闭')); this.onClose?.(); }
        else this.disconnect(new Error('连接已关闭'), true);
      };
    });
  }

  public subscribe(listener:(message:ServerMessage)=>void):()=>void {
    this.listeners.add(listener);return ()=>this.listeners.delete(listener);
  }
  public waitForAdmission(timeoutMs?:number):Promise<Admission> {
    return this.waitForMessage(message=>message.type==='joined'||message.type==='leftIdentity'||message.type==='sessionEnded',timeoutMs??this.timings.joinedTimeoutMs??10000,true) as Promise<Admission>;
  }
  public lookupRoom(roomCode:string,timeoutMs=10000):Promise<Extract<ServerMessage,{type:'roomLookup'}>> {
    const result=this.waitForMessage(message=>message.type==='roomLookup' && message.roomCode===roomCode,timeoutMs);
    this.send({type:'lookupRoom',roomCode});
    return result as Promise<Extract<ServerMessage,{type:'roomLookup'}>>;
  }
  public waitForMessage(predicate:(message:ServerMessage)=>boolean,timeoutMs=10000,closeOnTimeout=false):Promise<ServerMessage> {
    if(!this.socket||!this.negotiated) return Promise.reject(new Error('连接尚未完成协议确认'));
    return new Promise((resolve,reject)=>{
      const finish=()=>{clearTimeout(timer);this.responseWaiters.delete(waiter);};
      const waiter={predicate,resolve:(message:ServerMessage)=>{finish();resolve(message);},reject:(error:Error)=>{finish();reject(error);}};
      const timer=setTimeout(()=>{const error=new Error('服务器确认超时');waiter.reject(error);if(closeOnTimeout)this.disconnect(error,false);},Math.max(0,timeoutMs));
      this.responseWaiters.add(waiter);
    });
  }

  public waitForJoined(timeoutMs?: number): Promise<Joined> {
    if (!this.socket || !this.negotiated) return Promise.reject(new Error('连接尚未完成协议确认'));
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.joinedWaiters.delete(waiter); };
      const waiter = {
        resolve: (message: Joined) => { finish(); resolve(message); },
        reject: (error: Error) => { finish(); reject(error); },
      };
      const timer = setTimeout(() => this.disconnect(new Error('座位确认超时'), false),
        Math.min(this.timings.joinedTimeoutMs ?? 10_000, timeoutMs ?? Infinity));
      this.joinedWaiters.add(waiter);
    });
  }

  public send(message: ClientMessage): void {
    if (this.negotiated && message.type !== 'hello') this.socket?.send(JSON.stringify(message));
  }

  public close(): void { this.disconnect(new Error('连接已取消'), true); }

  private rejectJoined(error: Error): void {
    for (const waiter of Array.from(this.joinedWaiters)) waiter.reject(error);
  }

  private disconnect(error: Error, notify: boolean): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.negotiated = false;
    const cancel = this.cancelConnect;
    this.cancelConnect = null;
    cancel?.(error);
    this.rejectJoined(error);
    for(const waiter of Array.from(this.responseWaiters)) waiter.reject(error);
    socket.close();
    if (notify) this.onClose?.();
  }
}
