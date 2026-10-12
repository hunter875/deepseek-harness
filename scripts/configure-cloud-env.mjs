import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, requireGate } from '../lib/common.mjs';

// Populate only values established by the current operator request or local facts.
// Account-bound values are deliberately left for AWS STS discovery.
const file=path.join(ROOT,'.env');
let text=await fs.readFile(file,'utf8');
const values={
  AWS_PROFILE:process.env.EDUMATCH_AWS_PROFILE ?? '',
  AWS_REGION:'ap-southeast-1',
  EDUMATCH_REGION:'ap-southeast-1',
  AWS_ACCOUNT_ID:process.env.EDUMATCH_AWS_ACCOUNT_ID ?? '',
  AWS_OBSERVER_ROLE_ARN:process.env.EDUMATCH_AWS_OBSERVER_ROLE_ARN ?? '',
  AWS_BUILD_ROLE_ARN:process.env.EDUMATCH_AWS_BUILD_ROLE_ARN ?? '',
  AWS_DEPLOY_ROLE_ARN:process.env.EDUMATCH_AWS_DEPLOY_ROLE_ARN ?? '',
  AWS_MONTHLY_BUDGET_USD:'50',
  AWS_PLANNED_RUNTIME_HOURS:'40',
  AWS_CREATE_RESOURCES_AUTHORIZED:process.env.EDUMATCH_AWS_CREATE_RESOURCES_AUTHORIZED ?? 'false',
  AWS_AUTHORIZATION_REF:process.env.EDUMATCH_AWS_AUTHORIZATION_REF ?? '',
  AWS_BUDGET_EMAIL:process.env.EDUMATCH_BUDGET_EMAIL,
  AWS_AMI_ID:process.env.EDUMATCH_AWS_AMI_ID ?? '',
  AWS_ALLOWED_WEB_CIDR:process.env.EDUMATCH_PUBLIC_CIDR,
  AWS_GITHUB_OIDC_PROVIDER_ARN:process.env.EDUMATCH_AWS_OIDC_ARN ?? '',
  AWS_OBSERVER_PRINCIPAL_ARN:process.env.EDUMATCH_AWS_OBSERVER_PRINCIPAL_ARN ?? '',
  AWS_RELEASE_BUCKET:process.env.EDUMATCH_AWS_RELEASE_BUCKET ?? '',
  AWS_MAX_SESSION_HOURS:'4'
};
requireGate(/^\d{1,3}(?:\.\d{1,3}){3}\/32$/.test(values.AWS_ALLOWED_WEB_CIDR??''),'INVALID_ARGUMENT','Expected current public IPv4 /32');
requireGate(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.AWS_BUDGET_EMAIL??''),'INVALID_ARGUMENT','Expected budget notification email');
requireGate(/^\d{12}$/.test(values.AWS_ACCOUNT_ID),'INVALID_ARGUMENT','Expected AWS account ID');
requireGate(/^ami-[a-f0-9]+$/.test(values.AWS_AMI_ID),'INVALID_ARGUMENT','Expected AMI ID');
requireGate(values.AWS_CREATE_RESOURCES_AUTHORIZED==='true'&&values.AWS_AUTHORIZATION_REF,'POLICY_DENIED','Explicit resource authorization reference is required');
for(const [key,value] of Object.entries(values)) {
  const line=new RegExp(`^${key}=.*$`,'m');
  requireGate(line.test(text),'BLOCKED',`Missing ${key} in .env`);
  text=text.replace(line,`${key}=${value}`);
}
await fs.writeFile(file,text,{mode:0o600});
console.log(JSON.stringify({updated:Object.keys(values),accountBoundValuesPreserved:true}));
