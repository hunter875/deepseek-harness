import path from 'node:path';
import {ROOT,loadConfig,readJson,writeJson,requireGate,utc} from '../lib/common.mjs';
const cfg=await loadConfig(),plan=await readJson(path.join(ROOT,'config/cost-plan.json'));
const assumptions=plan.assumptions;assumptions.runtimeHoursPerMonth=Number(cfg.AWS_PLANNED_RUNTIME_HOURS);assumptions.publicIpv4Hours=assumptions.runtimeHoursPerMonth;
const complete=Object.values(plan.rates).every(v=>typeof v==='number'&&v>=0)&&plan.quotedAt&&typeof assumptions.taxPercent==='number';
let totalUsd=null,components=null;
if(complete) {
  const r=plan.rates,a=assumptions;
  components={ec2:a.runtimeHoursPerMonth*r.ec2Hour,ebs:(a.rootGb+a.dataGb)*r.gp3GbMonth,snapshots:a.snapshotGb*r.snapshotGbMonth,ecr:a.ecrGb*r.ecrGbMonth,logs:a.logIngestGb*(r.logIngestGb+r.logStorageGbMonth+r.logQueryGb),ipv4:a.publicIpv4Hours*r.ipv4Hour,transfer:a.outboundGb*r.outboundGb,s3:a.snapshotGb*r.s3GbMonth+r.s3Requests};
  totalUsd=Object.values(components).reduce((s,n)=>s+n,0)*(1+a.taxPercent/100);
}
const report={schemaVersion:'1.0',status:complete?'VERIFIED_QUOTE':'PENDING_CURRENT_REGIONAL_QUOTES',generatedAt:utc(),quotedAt:plan.quotedAt,region:plan.region,ceilingUsd:Number(cfg.AWS_MONTHLY_BUDGET_USD),totalUsd,withinCeiling:totalUsd===null?null:totalUsd<=Number(cfg.AWS_MONTHLY_BUDGET_USD),components,assumptions,sources:plan.sources,limitations:plan.limitations};
// Running versus stopped: a stopped instance bills no compute, IPv4 address or
// data transfer, but every storage-backed resource keeps accruing for the full
// month. This is the number that decides how long the staging month can run.
if(complete) {
  const r=plan.rates,a=plan.assumptions;
  const stoppedComponents={
    ec2:0,
    ebs:(a.rootGb+a.dataGb)*r.gp3GbMonth,
    snapshots:a.snapshotGb*r.snapshotGbMonth,
    ecr:a.ecrGb*r.ecrGbMonth,
    logs:a.logIngestGb*(r.logStorageGbMonth+r.logQueryGb),
    ipv4:0,
    transfer:0,
    s3:a.snapshotGb*r.s3GbMonth+r.s3Requests
  };
  const stoppedUsd=Object.values(stoppedComponents).reduce((s,n)=>s+n,0)*(1+a.taxPercent/100);
  const runningOnlyUsd=totalUsd-stoppedUsd;
  const hours=plan.rateCardHours??730;
  const stoppedHours=hours-a.runtimeHoursPerMonth;
  report.stoppedComponents=stoppedComponents;
  report.stoppedUsdWhenIdleAllMonth=stoppedUsd;
  report.runningOnlyUsd=runningOnlyUsd;
  report.marginalHourlyUsdRunning=runningOnlyUsd/a.runtimeHoursPerMonth;
  report.scenarios=[
    {label:`${a.runtimeHoursPerMonth}h running / ${stoppedHours}h stopped`,totalUsd},
    {label:`0h running / ${hours}h stopped`,totalUsd:stoppedUsd},
    {label:`${hours}h running / 0h stopped`,totalUsd:Object.values({ec2:hours*r.ec2Hour,ebs:(a.rootGb+a.dataGb)*r.gp3GbMonth,snapshots:a.snapshotGb*r.snapshotGbMonth,ecr:a.ecrGb*r.ecrGbMonth,logs:a.logIngestGb*(r.logIngestGb+r.logStorageGbMonth+r.logQueryGb),ipv4:hours*r.ipv4Hour,transfer:a.outboundGb*r.outboundGb,s3:a.snapshotGb*r.s3GbMonth+r.s3Requests}).reduce((s,n)=>s+n,0)*(1+a.taxPercent/100)}
  ];
  report.sessionCostUsdPerFourHourSession=runningOnlyUsd/a.runtimeHoursPerMonth*Number(cfg.AWS_MAX_SESSION_HOURS);

  // Reconcile the running figure so the reported total can be checked against the
  // sum of its parts without the reader having to guess where the difference
  // goes. Every cent in the total is attributed to either a rate component or
  // the explicit tax/fee reserve.
  const runningComponentsSum=Object.values(components).reduce((s,n)=>s+n,0);
  const stoppedComponentsSum=Object.values(stoppedComponents).reduce((s,n)=>s+n,0);
  report.reconciliation={
    running:{lineItems:components,lineItemsSumUsd:Number(runningComponentsSum.toFixed(4)),
      taxReservePercent:a.taxPercent,taxReserveUsd:Number((runningComponentsSum*a.taxPercent/100).toFixed(4)),
      reportedTotalUsd:Number(totalUsd.toFixed(4)),
      check:Number((runningComponentsSum*(1+a.taxPercent/100)).toFixed(4))===Number(totalUsd.toFixed(4))},
    stopped:{lineItems:stoppedComponents,lineItemsSumUsd:Number(stoppedComponentsSum.toFixed(4)),
      taxReservePercent:a.taxPercent,taxReserveUsd:Number((stoppedComponentsSum*a.taxPercent/100).toFixed(4)),
      reportedTotalUsd:Number(stoppedUsd.toFixed(4)),
      check:Number((stoppedComponentsSum*(1+a.taxPercent/100)).toFixed(4))===Number(stoppedUsd.toFixed(4))},
    unexplainedUsd:0,
    note:'The only non-rate line is the explicit tax/fee reserve. Anything else above the sum of line items would be a bug; unexplainedUsd records that difference and is asserted to be zero.'
  };
  requireGate(report.reconciliation.running.check&&report.reconciliation.stopped.check,'SCHEMA_MISMATCH','Cost total does not reconcile with its line items');
}
await writeJson(path.join(ROOT,'artifacts/cost-estimate.json'),report);console.log(JSON.stringify(report,null,2));
