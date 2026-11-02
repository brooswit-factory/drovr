import {createHash,randomUUID} from 'node:crypto';
import {ManagedConversationSession,HANDOFF_ACK,HANDOFF_CHUNK_CHARS} from './conversation-session.js';
import {createClaudeAckCursor,type ClaudeAckCursor} from './native-transcript.js';
import type {ManagedHerdrIdentity} from './managed-herdr-lifecycle.js';
import type {DrovrClient} from './drovr-client.js';
export const CONTINUATION_BOUNDS=Object.freeze({maxWallMs:48*60*60*1000,roundTripMs:120000,pollMs:500});
export interface ContinuationSnapshot {sha256:string;bytes:number;chars:number;}
export interface ContinuationProgress {phase:'prepared'|'prompt-attempt'|'acknowledged'|'committed'|'source-retirement-attempt'|'source-retired'|'paused'|'blocked';index:number;total:number;sourceSHA256:string;committed:boolean;retirement:'not-attempted'|'attempted-uncertain'|'retired';offset?:number;}
export interface OwnedTargetContinuation {
 target:ManagedHerdrIdentity;targetSessionHash:string;sourceSessionHash:string;snapshot:ContinuationSnapshot;operationDeadline:number;
 progress:(event:ContinuationProgress)=>Promise<void>;
}
export interface ContinuationClock {wall:()=>number;monotonic:()=>number;wait:(ms:number)=>Promise<void>;}
export function continuationChunkCount(text:string):number {let count=0;for(let i=0;i<text.length;){let end=Math.min(i+HANDOFF_CHUNK_CHARS,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!))end--;i=end;count++;}return Math.max(1,count);}
/** Wall and monotonic clocks both bound the operation; a rollback cannot extend it. */
export function continuationDeadline(deadline:number,clock:ContinuationClock){
 const initial=clock.wall(),mono=clock.monotonic(),span=deadline-initial;
 if(!Number.isFinite(initial)||!Number.isFinite(mono)||!Number.isFinite(span)||span<=0||span>CONTINUATION_BOUNDS.maxWallMs)throw Error('Invalid explicit finite continuation deadline');
 return ()=>{const w=clock.wall(),m=clock.monotonic();if(!Number.isFinite(w)||!Number.isFinite(m)||m<mono)throw Error('Continuation clock uncertain');const n=Math.min(deadline-w,span-(m-mono));if(n<=0)throw Error('Continuation total deadline expired');return n;};
}
export interface ContinuationEnvironment {
 client:DrovrClient;source:ManagedHerdrIdentity;maxChars:number;
 readSource:()=>Promise<string>;assertSource:()=>Promise<void>;assertTarget:()=>Promise<{sessionId:string;ready:boolean}>;
 commit:()=>void;kickoff:string;clock?:ContinuationClock;
 cursorFactory?:typeof createClaudeAckCursor;cleanupWaitMs?:number;
}
/** Existing-target only. No launch/preparation/new-pane/target-close paths exist here. */
export async function continueOwnedTarget(configIn:OwnedTargetContinuation,env:ContinuationEnvironment):Promise<void>{
 const config={...configIn,target:{...configIn.target},snapshot:{...configIn.snapshot}};
 const clock=env.clock??{wall:Date.now,monotonic:()=>performance.now(),wait:(n:number)=>new Promise<void>(r=>setTimeout(r,n))};
 const timeRemaining=continuationDeadline(config.operationDeadline,clock);let abandoned=false;
 const remaining=()=>{if(abandoned)throw Error('Continuation transaction abandoned; no further effects permitted');return timeRemaining();};
 if(config.target.provider!=='claude'||config.target.paneId===env.source.paneId||config.target.cwd!==env.source.cwd||!/^[a-f0-9]{64}$/.test(config.sourceSessionHash)||!/^[a-f0-9]{64}$/.test(config.targetSessionHash)||!/^[a-f0-9]{64}$/.test(config.snapshot.sha256)||typeof config.progress!=='function')throw Error('Invalid explicit owned Claude continuation');
 let cursor:ClaudeAckCursor|undefined,index=0,total=0,committed=false,retirement:ContinuationProgress['retirement']='not-attempted',primary:unknown;
 const cleanupMs=env.cleanupWaitMs??5000;if(!Number.isSafeInteger(cleanupMs)||cleanupMs<=0||cleanupMs>5000)throw Error('Cleanup wait must be finite and bounded');
 let cleanupEnds:number|undefined;
 const cleanupBounded=async<T>(action:()=>Promise<T>)=>{cleanupEnds??=performance.now()+cleanupMs;const ms=cleanupEnds-performance.now();if(ms<=0)throw Error('Continuation cleanup-only deadline expired');let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([Promise.resolve().then(action),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Continuation cleanup-only deadline expired')),ms);})]);}finally{if(timer!==undefined)clearTimeout(timer);}};
 const progress=async(phase:ContinuationProgress['phase'],offset?:number)=>{remaining();await bounded(()=>config.progress({phase,index,total,sourceSHA256:config.snapshot.sha256,committed,retirement,...(offset===undefined?{}:{offset})}),CONTINUATION_BOUNDS.roundTripMs);remaining();};
 const bounded=async<T>(action:()=>Promise<T>,ms:number):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([Promise.resolve().then(()=>{remaining();return action();}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abandoned=true;reject(Error('Continuation bounded wait expired; outcome may be uncertain'));},Math.max(1,Math.min(ms,remaining())));})]);}finally{if(timer!==undefined)clearTimeout(timer);}};
 try{
  await bounded(env.assertSource,CONTINUATION_BOUNDS.roundTripMs);if(!(await bounded(env.assertTarget,CONTINUATION_BOUNDS.roundTripMs)).ready)throw Error('Continuation target is not idle');
  const transcript=await bounded(env.readSource,CONTINUATION_BOUNDS.roundTripMs);
  if(Buffer.byteLength(transcript)!==config.snapshot.bytes||transcript.length!==config.snapshot.chars||createHash('sha256').update(transcript).digest('hex')!==config.snapshot.sha256||!transcript.trim())throw Error('Continuation full source differs from approved snapshot');
  total=continuationChunkCount(transcript)+1;
  const native=await bounded(env.assertTarget,CONTINUATION_BOUNDS.roundTripMs);if(!native.ready)throw Error('Continuation target became busy');
  const opening=(env.cursorFactory??createClaudeAckCursor)({sessionId:native.sessionId,cwd:config.target.cwd,...(config.target.home?{home:config.target.home}:{})});
  void opening.then(c=>{if(abandoned)return c.close();}).catch(()=>{});
  cursor=await bounded(()=>opening,CONTINUATION_BOUNDS.roundTripMs);
  await progress('prepared');
  const send=async(prompt:string,token:string)=>{
   const roundStart=clock.monotonic();
   const roundRemaining=()=>{const n=Math.min(CONTINUATION_BOUNDS.roundTripMs-(clock.monotonic()-roundStart),remaining());if(n<=0)throw Error('Continuation ACK deadline expired');return n;};
   return bounded(async()=>{
    while(!await cursor!.beginPrompt(prompt,token)){roundRemaining();await clock.wait(Math.min(CONTINUATION_BOUNDS.pollMs,roundRemaining()));}
    await env.assertSource();if(!(await env.assertTarget()).ready)throw Error('Continuation target is not ready for prompt');await progress('prompt-attempt');
    await env.assertSource();if(!(await env.assertTarget()).ready)throw Error('Continuation identity changed during prompt progress');
    roundRemaining();await env.client.agent.prompt({target:config.target.paneId,text:prompt});
    for(;;){
     roundRemaining();const result=await cursor!.poll();
     if(result.atEnd&&result.reply){
      const state=await env.assertTarget();const confirmed=await cursor!.poll();
      if(state.ready&&confirmed.atEnd&&confirmed.reply===result.reply){await progress('acknowledged',confirmed.offset);return confirmed.reply;}
     }
     await clock.wait(Math.min(CONTINUATION_BOUNDS.pollMs,roundRemaining()));
    }
   },roundRemaining());
  };
  const bootstrapToken=`${HANDOFF_ACK}_${randomUUID()}`;
  await send(`Drovr owned-target continuation bootstrap. Do not use tools, change files, or continue work. This is a NEW import transaction; prior partial context is not proof of completion. Begin your response with ${bootstrapToken} on its own line, followed by Ready for the complete historical import.`,bootstrapToken);
  index=1;
  const session=new ManagedConversationSession({cwd:env.source.cwd,maxTranscriptChars:env.maxChars,readTranscript:async()=>transcript,createRunner:()=>({message:async(prompt,id)=>{
   if(id&&id!==config.target.paneId)throw Error('Continuation conversation identity changed');
   const token=`${HANDOFF_ACK}_${randomUUID()}`,instruction=`\nBegin your response with ${HANDOFF_ACK} on its own line, followed by the working summary.\n`,at=prompt.lastIndexOf(instruction);
   if(at<0)throw Error('Continuation ACK instruction missing');
   const exact=prompt.slice(0,at)+instruction.replace(HANDOFF_ACK,token)+prompt.slice(at+instruction.length);
   const response=await send(exact,token);index++;return{conversationId:config.target.paneId,response:response.replace(token,HANDOFF_ACK)};
  }}),commit:async()=>{
   if(index!==total)throw Error('Continuation has missing chunk ACKs');
   await bounded(env.assertSource,CONTINUATION_BOUNDS.roundTripMs);if(!(await bounded(env.assertTarget,CONTINUATION_BOUNDS.roundTripMs)).ready)throw Error('Continuation target is not complete at commit');
   if(await bounded(env.readSource,CONTINUATION_BOUNDS.roundTripMs)!==transcript)throw Error('Continuation source changed before commit');
   await bounded(env.assertSource,CONTINUATION_BOUNDS.roundTripMs);if(!(await bounded(env.assertTarget,CONTINUATION_BOUNDS.roundTripMs)).ready)throw Error('Continuation target drifted during final source read');
   remaining();env.commit();committed=true;await progress('committed');
  }});
  await session.switchProvider('claude','Complete bounded history import into explicitly owned existing target');
  await progress('source-retirement-attempt');
  await bounded(env.assertSource,CONTINUATION_BOUNDS.roundTripMs);if(!(await bounded(env.assertTarget,CONTINUATION_BOUNDS.roundTripMs)).ready)throw Error('Continuation target changed before retirement');
  retirement='attempted-uncertain';
  await bounded(()=>env.client.pane.close(env.source.paneId),CONTINUATION_BOUNDS.roundTripMs);retirement='retired';await progress('source-retired');
  if(!(await bounded(env.assertTarget,CONTINUATION_BOUNDS.roundTripMs)).ready)throw Error('Committed target changed before pause marker');
  await bounded(()=>env.client.agent.prompt({target:config.target.paneId,text:env.kickoff}),CONTINUATION_BOUNDS.roundTripMs);await progress('paused');
 }catch(error){
  // No target cleanup or implicit retry: progress is evidence, never a resume permit.
  primary=error;abandoned=true;
  try{await cleanupBounded(()=>config.progress({phase:'blocked',index,total,sourceSHA256:config.snapshot.sha256,committed,retirement}));}catch{}
  throw error;
 }finally{
  if(cursor)try{const closing=cursor.close();void closing.catch(()=>{});await cleanupBounded(()=>closing);}catch(closeError){
   if(primary instanceof Error){const e=primary as Error&{suppressed?:unknown[]};(e.suppressed??=[]).push(closeError);}else if(!primary)throw closeError;
  }
 }
}
