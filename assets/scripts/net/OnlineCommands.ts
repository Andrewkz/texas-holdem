import { NetClient } from './NetClient';
import { highEntropyId } from './OnlineCredentials';
import { ClientMessage, CommandResult, CommandType } from './protocol';
export interface OnlineCommandsOptions { timeoutMs?:number; token?:string }
/** Commands retain their original request and payload. Card actions never enter this registry. */
export class OnlineCommands {
  private requests=new Map<string,{message:ClientMessage;command:CommandType}>();
  private waits=new Set<()=>void>();
  private disposed=false;
  public constructor(private readonly client:NetClient,private readonly sessionId:string,private readonly options:OnlineCommandsOptions={}){}
  public execute(command:CommandType,requestId=highEntropyId()):Promise<CommandResult> {
    if(this.requests.has(requestId)) {
      if(this.requests.get(requestId)!.command!==command) return Promise.reject(new Error('请求编号已经用于其他操作'));
      return this.retry(requestId);
    }
    const message:ClientMessage=command==='rejoin'
      ? {type:'rejoin',sessionId:this.sessionId,requestId,token:this.options.token??''}
      : {type:command,sessionId:this.sessionId,requestId};
    this.requests.set(requestId,{message,command});
    return this.submit(requestId,message);
  }
  public retry(requestId:string):Promise<CommandResult> {
    const request=this.requests.get(requestId);
    if(!request) return Promise.reject(new Error('找不到原请求，请勿新建编号重复操作'));
    return this.submit(requestId,request.message);
  }
  public query(requestId:string,originalCommand?:CommandType):Promise<CommandResult> {
    if(!this.requests.has(requestId)) {
      if(!originalCommand)return Promise.reject(new Error('查询恢复请求时必须指定原操作'));
      this.requests.set(requestId,{command:originalCommand,message:{type:'commandStatus',sessionId:this.sessionId,requestId,...(this.options.token?{token:this.options.token}:{})}});
    }
    return this.submit(requestId,{type:'commandStatus',sessionId:this.sessionId,requestId,...(this.options.token?{token:this.options.token}:{})});
  }
  public dispose():void {this.disposed=true;for(const cancel of Array.from(this.waits))cancel();}
  private submit(requestId:string,message:ClientMessage):Promise<CommandResult> {
    const request=this.requests.get(requestId)!;
    const unknown=():CommandResult=>({sessionId:this.sessionId,requestId,command:request.command,status:'pending',code:'confirmation-unknown',message:'结果待确认，请查询原请求'});
    if(this.disposed) return Promise.resolve(unknown());
    return new Promise(resolve=>{
      let finished=false;
      const finish=(result:CommandResult)=>{if(finished)return;finished=true;clearTimeout(timer);unsubscribe();this.waits.delete(cancel);resolve(result);};
      const cancel=()=>finish(unknown());
      const unsubscribe=this.client.subscribe(response=>{
        // A failed durable commit can already have renamed its new record. Only recovery can prove the outcome.
        if(response.type==='error' && response.code==='storage-failed') finish(unknown());
        if(response.type==='error' && ['command-not-found','invalid-proof','request-conflict','not-in-room'].indexOf(response.code)>=0) finish({...unknown(),status:'rejected',code:response.code,message:response.message});
        if(response.type==='commandResult' && response.result.sessionId===this.sessionId && response.result.requestId===requestId) finish(response.result);
      });
      const timer=setTimeout(cancel,this.options.timeoutMs??10000);
      this.waits.add(cancel);
      try{this.client.send(message);}catch{cancel();}
    });
  }
}
