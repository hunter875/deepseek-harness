import amqp from 'amqplib';
const connection=await amqp.connect('amqp://observer:fake-rabbit-observer-canary@rabbitmq:5672/fixture');
const results=[];
for(const operation of ['get','consume','purge']) {
  const channel=await connection.createChannel();let error=null;channel.on('error',e=>{error=e;});
  try {
    if(operation==='get')await channel.get('user_profile_updates');
    else if(operation==='consume')await channel.consume('user_profile_updates',()=>{});
    else await channel.purgeQueue('user_profile_updates');
    results.push({operation,denied:false});
  }catch(caught){results.push({operation,denied:/ACCESS_REFUSED|403/.test(caught.message)||error?.code===403});}
  await channel.close().catch(()=>{});
}
await connection.close();const passed=results.every(r=>r.denied);console.log(JSON.stringify({passed,results}));process.exitCode=passed?0:1;
