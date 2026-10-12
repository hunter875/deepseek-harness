import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import {ROOT,readJson} from '../lib/common.mjs';
const additions=`
# Local Harness web UI, independent of the EduMatch frontend on port 3000.
EDUMATCH_UI_PORT=3080
DEEPSEEK_UI_MAX_SECONDS=3600
DEEPSEEK_UI_MAX_TOKENS=1000000
DEEPSEEK_MODELS=deepseek-flash,deepseek-v4-pro

# Provider budget gateway: dated conservative USD per 1M token ceilings.
# Verify at https://api-docs.deepseek.com/quick_start/pricing/ before live use.
DEEPSEEK_MAX_API_CALLS=24
DEEPSEEK_INPUT_PRICE_CEILING_PER_M=
DEEPSEEK_OUTPUT_PRICE_CEILING_PER_M=
DEEPSEEK_PRICE_VERIFIED_AT=
GITHUB_OBSERVER_ENABLED=false
GITHUB_TOKEN_SCOPE_VERIFIED=false

# Cloud trust/bootstrap. Build and deploy use separate GitHub environments.
AWS_GITHUB_BUILD_OIDC_SUB=repo:hunter875/edumatch-production:environment:aws-staging-build
AWS_OBSERVER_PRINCIPAL_ARN=
AWS_RELEASE_BUCKET=
AWS_BUILD_BASE_IMAGES_JSON=
AWS_PLATFORM_IMAGES_JSON=
AWS_DATA_VOLUME_UUID=
AWS_COMPOSE_BINARY_SHA256=
AWS_RPO_MINUTES=
AWS_RTO_MINUTES=

# Runtime-only secrets: generated into a dedicated subset by runtime-env.mjs.
# They never enter a candidate verifier or diagnostic model process.
RABBITMQ_USERNAME=
AUTH_DB_ROOT_PASSWORD=
AUTH_DB_PASSWORD=
SCHOLARSHIP_DB_ROOT_PASSWORD=
SCHOLARSHIP_DB_PASSWORD=
CHAT_DB_ROOT_PASSWORD=
CHAT_DB_PASSWORD=
MATCHING_DB_PASSWORD=
RABBITMQ_PASSWORD=
EDUMATCH_JWT_SECRET=
EDUMATCH_JWT_PUBLIC_KEY=
EDUMATCH_JWT_PRIVATE_KEY=
SPRING_MAIL_PASSWORD=
SPRING_MAIL_USERNAME=
SPRING_MAIL_HOST=
SPRING_MAIL_PORT=587
SPRING_MAIL_STARTTLS_ENABLE=true
`;
const image=(await readJson(path.join(ROOT,'config/fixture-images.lock.json'))).images.node.image;
for(const name of ['.env.example','.env']) {
  const file=path.join(ROOT,name);let content=await fs.readFile(file,'utf8'),existing=dotenv.parse(content);
  const missing=additions.split('\n').filter(line=>!line.includes('=')||!Object.hasOwn(existing,line.slice(0,line.indexOf('='))));
  // Idempotent: no duplicate sections and no overwrite of credentials filled by the user.
  if(missing.some(line=>/^[A-Z][A-Z0-9_]*=/.test(line)))content+=`\n${missing.join('\n')}\n`;
  content=content.replace(/^SANDBOX_IMAGE=$/m,`SANDBOX_IMAGE=${image}`).replace(/^EDUMATCH_ISOLATION_ATTESTATION=$/m,'EDUMATCH_ISOLATION_ATTESTATION=./artifacts/isolation.json');
  await fs.writeFile(file,content,{mode:0o600});
}
console.log('Central .env updated; existing user values preserved.');
