import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const SITE='https://agf-radar.kemalgokayyarar.chatgpt.site';
export const AUDIENCE=`${SITE}/api/workout-collector`;
const MAX_BYTES=1024*1024;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function allowedWorkoutUrl(value){
 try{
  const url=new URL(value),keys=[...url.searchParams.keys()];
  return url.origin==='https://www.tjk.org'&&!url.username&&!url.password&&!url.hash
   &&['/TR/YarisSever/Query/Page/IdmanIstatistikleri','/TR/YarisSever/Query/DataRows/IdmanIstatistikleri'].includes(url.pathname)
   &&/^\d+$/.test(url.searchParams.get('QueryParameter_AtId')??'')
   &&keys.every(key=>['QueryParameter_AtId','PageNumber','Sort'].includes(key))&&new Set(keys).size===keys.length
   &&(!url.searchParams.has('PageNumber')||/^\d{1,2}$/.test(url.searchParams.get('PageNumber')))
   &&(!url.searchParams.has('Sort')||url.searchParams.get('Sort')==='IDMANTARIH Desc');
 }catch{return false;}
}

/** A normal curl request: TLS verification stays on, with no redirects, cookies, proxies or retry rotation. */
export function readWorkout(url,launch=spawn){
 if(!allowedWorkoutUrl(url))throw new Error('The server returned an unexpected workout URL.');
 return new Promise(resolve=>{
  let text='',bytes=0,settled=false;
  const child=launch('curl',['--http2','--silent','--show-error','--connect-timeout','10','--max-time','25',
   '--max-filesize',String(MAX_BYTES),'--user-agent','RaceScope/1.0','--header','Accept: text/html',
   '--header','Accept-Language: tr-TR,tr;q=0.9','--write-out','\nRACESCOPE_HTTP_STATUS:%{http_code}',url],{stdio:['ignore','pipe','pipe']});
  const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish({failure:'timeout',httpStatus:null});},28_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>MAX_BYTES+100){child.kill('SIGKILL');finish({failure:'http-error',httpStatus:null});}else text+=chunk;});
  child.stderr.resume(); // Never log remote bodies, headers, cookies or credentials.
  child.once('error',()=>finish({failure:'network',httpStatus:null}));
  child.once('close',code=>{
   const match=/\nRACESCOPE_HTTP_STATUS:(\d{3})$/.exec(text),status=match?Number(match[1]):0;
   if([401,403,429].includes(status))return finish({failure:'refused',httpStatus:status});
   if(code!==0)return finish({failure:code===28?'timeout':'network',httpStatus:status||null});
   if(status!==200||!match)return finish({failure:'http-error',httpStatus:status||null});
   finish({httpStatus:200,html:text.slice(0,match.index)});
  });
 });
}

export function createAuthorization(env=process.env,read=fetch){
 let cached=null,expiresAt=0;
 return async()=>{
  if(env.RACESCOPE_SCHEDULER_SECRET?.length>=32)return `Bearer ${env.RACESCOPE_SCHEDULER_SECRET}`;
  if(cached&&Date.now()<expiresAt)return `Bearer ${cached}`;
  if(!env.ACTIONS_ID_TOKEN_REQUEST_URL||!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)throw new Error('Collector authorization is unavailable.');
  const url=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.actions.githubusercontent.com'))throw new Error('Unexpected GitHub identity endpoint.');
  url.searchParams.set('audience',AUDIENCE);
  const response=await read(url,{redirect:'error',signal:AbortSignal.timeout(10_000),headers:{authorization:`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`}});
  if(!response.ok)throw new Error('GitHub identity could not be obtained.');
  const body=await response.json();
  if(typeof body.value!=='string'||body.value.length>16_384||body.value.split('.').length!==3)throw new Error('GitHub identity response is invalid.');
  cached=body.value;expiresAt=Date.now()+120_000;
  if(env.GITHUB_ACTIONS==='true')process.stdout.write(`::add-mask::${cached}\n`);
  return `Bearer ${cached}`;
 };
}

export async function runCollector({read=fetch,source=readWorkout,authorization=createAuthorization(),pause=wait,limit=30,checkOnly=false,log=console.log}={}){
 const api=async(path,payload)=>{
  const response=await read(`${AUDIENCE}/${path}`,{method:payload===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(60_000),
   headers:{authorization:await authorization(),'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  if(!response.ok)throw new Error(`RaceScope ${path} returned HTTP ${response.status}.`);
  return response.json();
 };
 const status=await api('status');
 log(JSON.stringify({event:'workout-collector-status',status:status.status,lastFinishedAt:status.lastFinishedAt??null}));
 if(checkOnly)return {status:'checked',pages:0,stored:0};
 let pages=0,stored=0;
 for(let i=0;i<Math.max(1,Math.min(30,Math.floor(limit)));i++){
  const job=await api('claim',{});
  if(job.status!=='claimed'){log(JSON.stringify({event:'workout-collector-wait',status:job.status,retryAt:job.retryAt??null}));return {status:job.status,pages,stored};}
  const evidence=await source(job.sourceUrl);
  const receipt=await api('result',{claimId:job.claimId,token:job.token,sourceUrl:job.sourceUrl,...evidence});
  pages++;stored+=Number(receipt.stored??0);
  log(JSON.stringify({event:'workout-collector-receipt',status:receipt.status,stored:receipt.stored,checkedAt:receipt.checkedAt,sourceChecked:receipt.sourceChecked}));
  if(!['success','partial'].includes(receipt.status))return {status:receipt.status,pages,stored};
  if(i+1<limit)await pause(2_000);
 }
 return {status:'bounded',pages,stored};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const authorization=createAuthorization(),checkOnly=process.argv.includes('--check');
  if(checkOnly&&process.env.GITHUB_ACTIONS==='true'){
   const value=await authorization();
   const claims=JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString());
   const fields=['iss','aud','sub','repository','repository_id','repository_owner','repository_owner_id','workflow_ref','ref','ref_type','runner_environment','event_name','iat','nbf','exp'];
   console.log(JSON.stringify({event:'workout-collector-identity-scope',...Object.fromEntries(fields.map(key=>[key,claims[key]??null]))}));
  }
  const result=await runCollector({authorization,checkOnly});console.log(JSON.stringify({event:'workout-collector-finished',...result}));if(['error','blocked'].includes(result.status))process.exitCode=1;
 }
 catch(error){console.error(error instanceof Error?error.message:'Collector failed.');process.exitCode=1;}
}
