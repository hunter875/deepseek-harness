import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,loadConfig,readJson,writeJson,requireGate,utc,sha256} from '../lib/common.mjs';
import {runProcess} from '../lib/process.mjs';

const config=await loadConfig();
const action=process.argv[2]??'validate';
const region=config.EDUMATCH_REGION;
const profileEnv={
  USERPROFILE:process.env.USERPROFILE,
  HOME:process.env.USERPROFILE,
  AWS_CONFIG_FILE:path.join(process.env.USERPROFILE,'.aws','config'),
  AWS_SHARED_CREDENTIALS_FILE:path.join(process.env.USERPROFILE,'.aws','credentials'),
  AWS_LOGIN_CACHE_DIRECTORY:path.join(process.env.USERPROFILE,'.aws','login','cache'),
  AWS_PROFILE:config.AWS_PROFILE,
  AWS_REGION:region
};

function variables(oidcVerified) {
  return {
    account_id:config.AWS_ACCOUNT_ID,ami_id:config.AWS_AMI_ID,instance_type:config.AWS_INSTANCE_TYPE,
    allowed_web_cidr:config.AWS_ALLOWED_WEB_CIDR,github_oidc_provider_arn:config.AWS_GITHUB_OIDC_PROVIDER_ARN,
    github_build_sub:config.AWS_GITHUB_BUILD_OIDC_SUB,github_deploy_sub:config.AWS_GITHUB_OIDC_SUB,
    oidc_claims_verified:oidcVerified,deployment_mode:config.AWS_DEPLOYMENT_MODE??'manual',
    observer_principal_arn:config.AWS_OBSERVER_PRINCIPAL_ARN,
    budget_email:config.AWS_BUDGET_EMAIL,monthly_budget_usd:Number(config.AWS_MONTHLY_BUDGET_USD),
    max_session_hours:Number(config.AWS_MAX_SESSION_HOURS)
  };
}

async function currentEstimate() {
  const estimate=await readJson(path.join(ROOT,'artifacts','cost-estimate.json'));
  requireGate(estimate.status==='VERIFIED_QUOTE'&&estimate.totalUsd<=Number(config.AWS_MONTHLY_BUDGET_USD)&&Date.now()-Date.parse(estimate.quotedAt)<86400000*7,'BUDGET_EXCEEDED','Current complete estimate must fit the user ceiling');
  return estimate;
}

async function terraformEnv() {
  requireGate(config.AWS_PROFILE&&/^\d{12}$/.test(config.AWS_ACCOUNT_ID),'BLOCKED','AWS profile/account binding is incomplete');
  const exported=await runProcess('aws',['configure','export-credentials','--profile',config.AWS_PROFILE,'--format','process'],{cwd:ROOT,timeoutMs:30000,maxBytes:16384,env:profileEnv,captureJson:true});
  const c=exported.parsedJson;
  requireGate(exported.exitCode===0&&c?.AccessKeyId&&c?.SecretAccessKey&&c?.SessionToken,'BLOCKED','AWS temporary login is missing or expired; run aws login again');
  return {
    env:{...profileEnv,AWS_ACCESS_KEY_ID:c.AccessKeyId,AWS_SECRET_ACCESS_KEY:c.SecretAccessKey,AWS_SESSION_TOKEN:c.SessionToken},
    canaries:[c.AccessKeyId,c.SecretAccessKey,c.SessionToken],expiration:c.Expiration??null
  };
}

async function plan({bootstrap=false}={}) {
  const estimate=await currentEstimate();
  const mode=config.AWS_DEPLOYMENT_MODE??'manual';
  requireGate(['manual','github'].includes(mode),'INVALID_ARGUMENT','AWS_DEPLOYMENT_MODE must be manual or github');
  if(!bootstrap&&mode==='github')requireGate(config.AWS_GITHUB_OIDC_CLAIMS_VERIFIED==='true','BLOCKED','Actual GitHub OIDC claim must succeed before a GitHub-mode plan');
  const vars=variables(mode==='github');requireGate(Object.values(vars).every(v=>v!==undefined&&v!==''),'BLOCKED','Cloud variables are incomplete');
  await writeJson(path.join(ROOT,'infra','terraform.tfvars.json'),vars);
  const auth=await terraformEnv();
  const name=bootstrap?'oidc-bootstrap.tfplan':'staging.tfplan';
  const args=['-chdir=infra','plan','-out',name,'-input=false'];
  if(bootstrap)args.push('-target=aws_iam_role.build');
  const run=await runProcess('terraform',args,{cwd:ROOT,timeoutMs:180000,maxBytes:204800,env:auth.env,canaries:auth.canaries});
  const planPath=path.join(ROOT,'infra',name);let planSha256=null;
  if(run.exitCode===0)planSha256=sha256(await fs.readFile(planPath));
  const artifact=bootstrap?'terraform-oidc-bootstrap-plan.json':'terraform-plan.json';
  await writeJson(path.join(ROOT,'artifacts',artifact),{kind:bootstrap?'oidc-bootstrap':'staging',exitCode:run.exitCode,output:run.output,planFile:name,planSha256,variablesSha256:sha256(vars),estimateSha256:sha256(estimate),createdAt:utc(),credentialExpiration:auth.expiration,authorizationRef:config.AWS_AUTHORIZATION_REF||null});
  console.log(run.output);process.exitCode=run.exitCode??1;
}

async function apply({bootstrap=false}={}) {
  requireGate(config.AWS_CREATE_RESOURCES_AUTHORIZED==='true'&&config.AWS_AUTHORIZATION_REF,'BLOCKED','Explicit cloud resource authorization is missing');
  await currentEstimate();
  const artifact=await readJson(path.join(ROOT,'artifacts',bootstrap?'terraform-oidc-bootstrap-plan.json':'terraform-plan.json'));
  const planPath=path.join(ROOT,'infra',artifact.planFile);
  requireGate(artifact.exitCode===0&&artifact.planSha256===sha256(await fs.readFile(planPath)),'POLICY_DENIED','Saved reviewed plan binding failed');
  requireGate(Date.now()-Date.parse(artifact.createdAt)<3600000,'BLOCKED','Saved plan is older than one hour; re-plan');
  const auth=await terraformEnv();
  const run=await runProcess('terraform',['-chdir=infra','apply','-input=false','-auto-approve',artifact.planFile],{cwd:ROOT,timeoutMs:900000,maxBytes:307200,env:auth.env,canaries:auth.canaries});
  await writeJson(path.join(ROOT,'artifacts',bootstrap?'terraform-oidc-bootstrap-apply.json':'terraform-apply.json'),{kind:artifact.kind,exitCode:run.exitCode,output:run.output,planSha256:artifact.planSha256,appliedAt:utc(),authorizationRef:config.AWS_AUTHORIZATION_REF});
  console.log(run.output);process.exitCode=run.exitCode??1;
}

if(action==='validate') {
  const run=await runProcess('terraform',['-chdir=infra','validate','-json'],{cwd:ROOT,timeoutMs:30000,maxBytes:102400});
  let parsed;try{parsed=JSON.parse(run.output);}catch{parsed={valid:false,error:'Terraform validate failed before JSON report'};}
  await writeJson(path.join(ROOT,'artifacts','terraform-validation.json'),{source:'local-static-validation',...parsed,exitCode:run.exitCode,verifiedAt:utc()});
  console.log(JSON.stringify(parsed,null,2));process.exitCode=run.exitCode??1;
} else if(action==='plan') await plan();
else if(action==='apply') await apply();
else if(action==='oidc-bootstrap-plan') await plan({bootstrap:true});
else if(action==='oidc-bootstrap-apply') await apply({bootstrap:true});
else throw new Error('Usage: cloud.mjs validate | plan | apply | oidc-bootstrap-plan | oidc-bootstrap-apply');
