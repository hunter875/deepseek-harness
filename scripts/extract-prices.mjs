import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import StreamJson from 'stream-json';
import Pick from 'stream-json/filters/Pick.js';
import StreamObject from 'stream-json/streamers/StreamObject.js';
import {ROOT,readJson,writeJson,utc,requireGate} from '../lib/common.mjs';
const criteria={
  ec2Hour:['AmazonEC2',p=>p.productFamily==='Compute Instance'&&p.attributes.instanceType==='t3a.large'&&p.attributes.operatingSystem==='Linux'&&p.attributes.tenancy==='Shared'&&p.attributes.preInstalledSw==='NA'&&p.attributes.capacitystatus==='Used'&&p.attributes.operation==='RunInstances'],
  gp3GbMonth:['AmazonEC2',p=>p.attributes.usagetype==='APS1-EBS:VolumeUsage.gp3'],
  snapshotGbMonth:['AmazonEC2',p=>p.attributes.usagetype==='APS1-EBS:SnapshotUsage'],
  outboundGb:['AWSDataTransfer',p=>p.attributes.usagetype==='APS1-DataTransfer-Out-Bytes'&&p.attributes.transferType==='AWS Outbound'],
  ecrGbMonth:['AmazonECR',p=>p.attributes.usagetype==='APS1-TimedStorage-ByteHrs'],
  logIngestGb:['AmazonCloudWatch',p=>p.attributes.usagetype==='APS1-DataProcessing-Bytes'&&p.attributes.version==='Current'],
  logStorageGbMonth:['AmazonCloudWatch',p=>p.attributes.usagetype==='APS1-TimedStorage-ByteHrs'&&p.attributes.version==='Current'],
  logQueryGb:['AmazonCloudWatch',p=>p.attributes.usagetype==='APS1-DataScanned-Bytes'],
  ipv4Hour:['AmazonVPC',p=>p.attributes.usagetype==='APS1-PublicIPv4:InUseAddress'],
  s3GbMonth:['AmazonS3',p=>p.attributes.usagetype==='APS1-TimedStorage-ByteHrs'&&p.attributes.storageClass==='General Purpose'],
  s3PutRequest:['AmazonS3',p=>p.attributes.usagetype==='APS1-Requests-Tier1'&&p.attributes.group==='S3-API-Tier1'],
  s3GetRequest:['AmazonS3',p=>p.attributes.usagetype==='APS1-Requests-Tier2'&&p.attributes.group==='S3-API-Tier2']
};
const matched={},prices={},provenance=[];
async function* entries(file,filter) {
  const stream=fs.createReadStream(file).pipe(StreamJson.parser()).pipe(Pick.pick({filter})).pipe(StreamObject.streamObject());
  for await(const item of stream)yield item;
}
for(const service of [...new Set(Object.values(criteria).map(c=>c[0]))]) {
  const file=path.join(ROOT,'artifacts/pricing',`${service}.json`);const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  for await(const {key,value}of entries(file,'products'))for(const [name,[svc,select]]of Object.entries(criteria))if(svc===service&&select(value)){
    requireGate(!matched[name],'SCHEMA_MISMATCH',`Pricing selector is ambiguous: ${name}`);matched[name]={sku:key,product:value};
  }
  const selected=Object.entries(matched).filter(([name])=>criteria[name][0]===service);
  for await(const {key,value}of entries(file,'terms.OnDemand'))for(const [name,record]of selected)if(record.sku===key) {
    const dimensions=Object.values(value).flatMap(term=>Object.values(term.priceDimensions)).filter(d=>Number(d.beginRange)===0&&Number(d.pricePerUnit.USD)>0);
    // Skip the provider's zero-priced/free allowance tier; quote first paid marginal tier conservatively.
    const all=Object.values(value).flatMap(term=>Object.values(term.priceDimensions)).filter(d=>Number(d.pricePerUnit.USD)>0).sort((a,b)=>Number(a.beginRange)-Number(b.beginRange));
    const dimension=dimensions[0]??all[0];requireGate(dimension,'SCHEMA_MISMATCH',`No paid pricing dimension: ${name}`);
    prices[name]={rate:Number(dimension.pricePerUnit.USD),sku:key,unit:dimension.unit,description:dimension.description,attributes:record.product.attributes,effectiveDate:Object.values(value)[0].effectiveDate};
  }
  provenance.push({service,url:`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${service}/current/ap-southeast-1/index.json`,catalogSha256:hash.digest('hex')});
  console.log(`${service}: extracted ${selected.map(([name])=>name).join(', ')}`);
}
requireGate(Object.keys(criteria).every(name=>prices[name]),'SCHEMA_MISMATCH',`Missing regional rate: ${Object.keys(criteria).filter(name=>!prices[name]).join(', ')}`);
const quote={schemaVersion:'1.0',quotedAt:utc(),region:'ap-southeast-1',source:'AWS public regional bulk catalogs',prices,provenance};await writeJson(path.join(ROOT,'artifacts/pricing-summary.json'),quote);
const plan=await readJson(path.join(ROOT,'config/cost-plan.json'));plan.status='VERIFIED_QUOTE';plan.quotedAt=quote.quotedAt;
for(const name of Object.keys(plan.rates))if(prices[name])plan.rates[name]=prices[name].rate;
plan.rates.s3Requests=1000*prices.s3PutRequest.rate+10000*prices.s3GetRequest.rate;
plan.assumptions.s3PutRequests=1000;plan.assumptions.s3GetRequests=10000;plan.assumptions.taxPercent=20;plan.assumptions.taxPercentMeaning='Conservative 20% tax/fee reserve, not the actual account tax rate';plan.sources=provenance.map(p=>p.url);
await writeJson(path.join(ROOT,'config/cost-plan.json'),plan);console.log('Current regional quote written; tax/fee reserve is an explicit assumption.');
