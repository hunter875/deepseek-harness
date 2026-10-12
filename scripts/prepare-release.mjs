import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {ROOT,loadConfig,readJson,writeJson,sha256,requireGate} from '../lib/common.mjs';
import {validateRelease,APP_SERVICES,PLATFORM_SERVICES} from '../lib/release.mjs';
const [repoArg,manifestArg,outputArg]=process.argv.slice(2);
requireGate(repoArg&&manifestArg&&outputArg,'INVALID_ARGUMENT','Usage: prepare-release <repo> <manifest.json> <output-directory>');
const repo=path.resolve(repoArg),output=path.resolve(outputArg),release=await readJson(path.resolve(manifestArg));
const compose=YAML.parse(await fs.readFile(path.join(repo,'docker-compose.yml'),'utf8'));
const services={};
for(const service of [...APP_SERVICES,...PLATFORM_SERVICES,'matching-consumer']) {
  const old=compose.services[service];requireGate(old,'INVALID_ARGUMENT',`Service missing in audited Compose: ${service}`);
  const value=structuredClone(old);delete value.build;delete value.container_name;delete value.ports;delete value.profiles;
  value.image=release.images[service==='matching-consumer'?'matching-service':service];value.networks=['app'];value.restart='unless-stopped';
  value.logging={driver:'awslogs',options:{'awslogs-region':release.region,'awslogs-group':'/edumatch/staging','awslogs-stream':`${release.releaseId}/${service}`,'awslogs-create-group':'false'}};
  const env=Object.fromEntries((value.environment??[]).map(e=>{const i=e.indexOf('=');return [e.slice(0,i),e.slice(i+1)];}));
  if(APP_SERVICES.includes(service)||service==='matching-consumer') {
    Object.assign(env,{APP_VERSION:release.sourceRevision,GIT_COMMIT:release.sourceRevision,DEPLOY_ENVIRONMENT:'aws-staging',SPRING_JPA_HIBERNATE_DDL_AUTO:'validate',SPRING_FLYWAY_BASELINE_ON_MIGRATE:'false',MANAGEMENT_ENDPOINT_HEALTH_SHOW_DETAILS:'never'});
    // RSA material is mounted as files: a PEM key is multi-line and docker
    // compose --env-file cannot carry newlines reliably. Every consumer already
    // supports a path form (app.jwt.rsa.*-key-path, JWT_PUBLIC_KEY_PATH).
    // The Spring side injects these as `Resource`, and a bare absolute path is
    // resolved by DefaultResourceLoader as a *classpath* resource, so the
    // explicit `file:` scheme is required or startup fails with
    // "Could not open ServletContext resource [/run/secrets/jwt-public.pem]".
    if(service!=='frontend'&&service!=='api-gateway')Object.assign(env,{APP_JWT_REQUIRE_RSA:'true',JWT_REQUIRE_RSA:'true',APP_JWT_RSA_PUBLIC_KEY_PATH:'file:/run/secrets/jwt-public.pem',JWT_PUBLIC_KEY_PATH:'/run/secrets/jwt-public.pem'});
    if(service==='auth-service')Object.assign(env,{APP_AUTH_COOKIE_SECURE:'true',APP_JWT_RSA_PRIVATE_KEY_PATH:'file:/run/secrets/jwt-private.pem'});
    // app.jwt.secret is no longer required: the audited properties now default it
    // to empty, and JwtTokenProvider only reads it on the HS256 fallback path,
    // which fails closed when RSA is required. The audited Compose still declares
    // APP_JWT_SECRET/JWT_SECRET, so they are removed rather than populated: an
    // unused shared secret in the environment invites treating it as a real key.
    delete env.APP_JWT_SECRET;
    delete env.JWT_SECRET;
    if(service==='matching-service'||service==='matching-consumer'){env.JWT_ALGORITHM='RS256';env.JWT_SECRET='';}
  }
  // Azure telemetry is an optional audited upstream integration, not required by AWS.
  delete env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if(env.JAVA_TOOL_OPTIONS)env.JAVA_TOOL_OPTIONS=env.JAVA_TOOL_OPTIONS.replace('-javaagent:/opt/applicationinsights-agent.jar ','');
  // The audited Compose is a *local* stack whose service hostnames carry a
  // "-test" suffix. Rather than rewriting every environment value with a regex
  // — which could silently alter an unrelated hostname or a secret — the
  // deployment names for the known inter-service URLs are set explicitly.
  // application.properties in the audited source now defaults to the in-network
  // name, so this only has to correct the Compose-declared values.
  const serviceUrls={
    'auth-service':'http://auth-service:8081',
    'scholarship-service':'http://scholarship-service:8082',
    'chat-service':'http://chat-service:8083',
    'matching-service':'http://matching-service:8000'
  };
  // chat-service declares its datasource host as "chat-db-test", a name that
  // only exists on the developer Compose network. Corrected explicitly rather
  // than by rewriting every value, so an unrelated hostname or a secret that
  // happens to contain "-test" is never touched.
  const datasourceUrls={
    'chat-service':'jdbc:mysql://chat-db:3306/chat_db?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=UTC'
  };
  const interService={
    'auth-service':{},
    'scholarship-service':{AUTH_SERVICE_URL:serviceUrls['auth-service'],MATCHING_SERVICE_URL:serviceUrls['matching-service']},
    'chat-service':{AUTH_SERVICE_URL:serviceUrls['auth-service']},
    'matching-service':{},
    'matching-consumer':{}
  };
  Object.assign(env,interService[service]??{});
  if(datasourceUrls[service])env.SPRING_DATASOURCE_URL=datasourceUrls[service];
  // Service-to-service identity. auth-service verifies the client credentials and
  // issues the ROLE_SERVICE token; chat-service presents them to obtain one.
  // Both sides read the same values from the runtime env so the secret is never
  // baked into an image or a manifest.
  if(service==='auth-service'||service==='chat-service')Object.assign(env,{
    APP_SERVICE_AUTH_ENABLED:'${APP_SERVICE_AUTH_ENABLED:?Set APP_SERVICE_AUTH_ENABLED in runtime .env}',
    APP_SERVICE_AUTH_CLIENT_ID:'${APP_SERVICE_AUTH_CLIENT_ID:?Set APP_SERVICE_AUTH_CLIENT_ID in runtime .env}',
    APP_SERVICE_AUTH_CLIENT_SECRET:'${APP_SERVICE_AUTH_CLIENT_SECRET:?Set APP_SERVICE_AUTH_CLIENT_SECRET in runtime .env}'
  });
  // Browser requests that still carry an Origin are validated against the
  // Spring CORS allowlist, which otherwise only names local and Azure hosts; an
  // unlisted origin is rejected with "Invalid CORS request" before the
  // controller runs. The deployment supplies its own public origin here.
  if(service==='auth-service'||service==='scholarship-service'||service==='chat-service')Object.assign(env,{
    APP_CORS_ALLOWED_ORIGIN_PATTERNS:`https://${release.tlsDomain}`
  });
  // auth-service declares spring.mail.username/password without defaults, and
  // the audited Compose only forwards those two. Spring Boot then activates
  // MailHealthIndicator against the application.properties default host
  // (smtp.gmail.com), so /actuator/health reports 503 and never becomes ready.
  // EmailService.sendVerificationEmail has no caller in the audited source, so
  // the dependency is genuinely unused: disable the indicator and point the
  // mail client at a non-routable local port instead of a reachable sink that
  // would only make the check look healthy.
  if(service==='auth-service')Object.assign(env,{SPRING_MAIL_HOST:'127.0.0.1',SPRING_MAIL_PORT:'2525',SPRING_MAIL_SMTP_AUTH:'false',SPRING_MAIL_SMTP_STARTTLS_ENABLE:'false',MANAGEMENT_HEALTH_MAIL_ENABLED:'false'});
  if(service==='frontend'){env.NEXT_PUBLIC_API_GATEWAY=`https://${release.tlsDomain}`;env.NEXT_PUBLIC_SOCKET_URL=`wss://${release.tlsDomain}/api/ws`;value.healthcheck={test:['CMD','node','-e',"require('http').get('http://127.0.0.1:3000/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"],interval:'10s',timeout:'5s',retries:10};}
  value.environment=env;
  if(value.volumes)value.volumes=value.volumes.map(v=> {
    const [source,target]=v.split(':');return PLATFORM_SERVICES.includes(service)?`/srv/edumatch/${service}:${target}`:v;
  });
  if(['auth-service','scholarship-service','chat-service'].includes(service)){const port={ 'auth-service':8081,'scholarship-service':8082,'chat-service':8083 }[service];value.healthcheck={test:['CMD-SHELL',`wget --quiet --tries=1 --spider http://localhost:${port}/actuator/health || exit 1`],interval:'10s',timeout:'5s',retries:20,start_period:'90s'};}
  if(service==='redis')value.volumes=['/srv/edumatch/redis:/data'];
  if(service==='rabbitmq')value.volumes=['/srv/edumatch/rabbitmq:/var/lib/rabbitmq'];
  // Mount the RSA material the container was told to read. The public key is
  // shared by every service that verifies a token (including the consumer);
  // only auth-service signs and therefore also needs the private key.
  if((APP_SERVICES.includes(service)||service==='matching-consumer')&&service!=='frontend'&&service!=='api-gateway') {
    value.volumes=[...(value.volumes??[]),'/opt/edumatch/secrets/jwt-public.pem:/run/secrets/jwt-public.pem:ro'];
    if(service==='auth-service')value.volumes.push('/opt/edumatch/secrets/jwt-private.pem:/run/secrets/jwt-private.pem:ro');
  }
  if(service==='api-gateway'){value.ports=['443:443'];value.volumes=['./nginx.conf:/etc/nginx/nginx.conf:ro','/opt/edumatch/tls:/etc/nginx/tls:ro'];value.healthcheck={test:['CMD-SHELL','wget --no-check-certificate --quiet --tries=1 --spider https://localhost/gateway/health || exit 1'],interval:'10s',timeout:'5s',retries:10};}
  services[service]=value;
}
requireGate(typeof release.tlsDomain==='string'&&/^[a-zA-Z0-9.-]+$/.test(release.tlsDomain),'INVALID_ARGUMENT','TLS domain is required');
let nginx=(await fs.readFile(path.join(repo,'nginx-gateway/nginx.local.conf'),'utf8')).replaceAll('\r\n','\n');
nginx=nginx.replace('listen 80;','listen 443 ssl;\n        ssl_certificate /etc/nginx/tls/fullchain.pem;\n        ssl_certificate_key /etc/nginx/tls/privkey.pem;\n        ssl_protocols TLSv1.2 TLSv1.3;').replace('server_name localhost;',`server_name ${release.tlsDomain};`)
  .replaceAll('"path":"$request_uri"','"path":"$uri"');
nginx=nginx.replace('"environment":"local","services"',`"environment":"aws-staging","releaseId":"${release.releaseId}","sourceRevision":"${release.sourceRevision}","services"`);
nginx=nginx.split('\n').filter(line=>!line.includes('add_header Access-Control-')).join('\n').replace(',\'\n        \'"upstreamStatus":"$upstream_status","remoteAddr":"$remote_addr","userAgent":"$http_user_agent"}',',\'\n        \'"upstreamStatus":"$upstream_status"}');
// Remove IP and user-agent fields without depending on formatting.
nginx=nginx.replace(',"remoteAddr":"$remote_addr","userAgent":"$http_user_agent"','');
// The frontend posts to /api/v1/matching/batch-scores, but the audited nginx
// config only maps /api/v1/match, /api/v1/recommendations and the rewritten
// /api/matching/*. An unmatched /api/v1/matching/* request fell through to the
// frontend location and came back 401. A dedicated location forwards it to the
// matching service, which enforces its own authentication.
if(!nginx.includes('location /api/v1/matching/')) {
  const matchingLocation=[
    '        location /api/v1/matching/ {',
    '            limit_req zone=api_limit burst=20 nodelay;',
    '            proxy_pass $matching_upstream;',
    '            proxy_hide_header Access-Control-Allow-Origin;',
    '            proxy_hide_header Access-Control-Allow-Credentials;',
    '            proxy_set_header Host $host;',
    '            proxy_set_header X-Real-IP $remote_addr;',
    '            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '            proxy_set_header X-Forwarded-Proto $scheme;',
    '            proxy_set_header X-Request-Id $proxy_request_id;',
    '            proxy_set_header Authorization $http_authorization;',
    '            proxy_connect_timeout 60s;',
    '            proxy_send_timeout 60s;',
    '            proxy_read_timeout 60s;',
    '            add_header Access-Control-Allow-Origin $http_origin always;',
    '            add_header Access-Control-Allow-Credentials true always;',
    '            add_header Vary Origin always;',
    '        }',
    ''
  ].join('\n');
  // Insert before the frontend catch-all so the more specific prefix wins.
  const frontendLocation=nginx.indexOf('        # FRONTEND (Next.js - Port 3000)');
  requireGate(frontendLocation>0,'SCHEMA_MISMATCH','Cannot locate the frontend block to insert the matching route');
  nginx=nginx.slice(0,frontendLocation)+matchingLocation+'\n'+nginx.slice(frontendLocation);
}
const content=YAML.stringify({name:'edumatch-staging',services,networks:{app:{driver:'bridge'}}});
await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'compose.yml'),content);await fs.writeFile(path.join(output,'nginx.conf'),nginx);
const configVersion=sha256({compose:content,nginx});
if(release.configVersion)requireGate(release.configVersion===configVersion,'SCHEMA_MISMATCH','Config digest differs from generated config');
release.configVersion=configVersion;
// The preparation step only produces the artifact; it cannot know which release
// the host is currently running, so the expectedPreviousRelease consistency
// check belongs to the host-side guard (release_guard.py) which sees
// /opt/edumatch/current. Validating it here would reject every follow-up
// release before it could be deployed.
validateRelease(release,{accountId:release.accountId,previous:release.expectedPreviousRelease?{releaseId:release.expectedPreviousRelease}:null});
await writeJson(path.join(output,'manifest.json'),release);console.log(`Prepared digest-pinned release ${release.releaseId}`);
