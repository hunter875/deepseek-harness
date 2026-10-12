const base=process.env.FIXTURE_MQ_URL;
const admin={authorization:'Basic '+Buffer.from('fixture_admin:fake-rabbit-admin-canary').toString('base64'),'content-type':'application/json'};
const reader={authorization:'Basic '+Buffer.from('observer:fake-rabbit-observer-canary').toString('base64'),'content-type':'application/json'};
const req=async(method,path,body,headers=admin)=>{const response=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined});const text=await response.text();let data=null;try{data=JSON.parse(text);}catch(error){/* Empty management response */}return {status:response.status,data};};
const queue='/api/queues/fixture/user_profile_updates';
if(process.argv[2]==='setup') {
  for(const [method,payload]of [['PUT',{auto_delete:false,durable:false,arguments:{}}]]){const result=await req(method,queue,payload);if(result.status>=300)throw Error('Queue fixture setup failed');}
  const published=await req('POST','/api/exchanges/fixture/amq.default/publish',{properties:{},routing_key:'user_profile_updates',payload:'fake-message-canary',payload_encoding:'string'});
  if(published.status>=300||!published.data.routed)throw Error('Fixture publish failed');console.log('SETUP_OK');
} else {
  const before=await req('GET',queue),read=await req('GET',queue,null,reader);
  const get=await req('POST',queue+'/get',{count:1,ackmode:'ack_requeue_false',encoding:'auto',truncate:100},reader);
  const purge=await req('DELETE',queue+'/contents',null,reader);
  const after=await req('GET',queue);
  const a=before.data?.messages,b=after.data?.messages;
  const passed=read.status===200&&get.status>=400&&purge.status>=400&&a===b&&a===1;
  console.log(JSON.stringify({passed,metadataReadStatus:read.status,getStatus:get.status,purgeStatus:purge.status,before:a,after:b,payloadFetched:false}));
  process.exitCode=passed?0:1;
}
