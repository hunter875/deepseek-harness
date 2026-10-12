#!/bin/bash
set -euo pipefail
# EduMatch staging self-signed TLS.
#
# The staging host has no public DNS name and no CA-issued certificate, so the
# gateway terminates TLS with a self-signed certificate bound to a fixed
# staging hostname. The browser reaches that hostname through an SSM port
# forwarding session, and the certificate must be explicitly trusted on the
# test machine (see docs/STAGING-MANUAL-DEPLOY.md).
#
# Idempotent: an existing certificate bound to the same hostname is kept
# unless --force is passed.

hostname_value=${1:?staging hostname, e.g. edumatch.staging.local}
shift || true
force=false
[[ "${1:-}" == "--force" ]] && force=true

[[ "$hostname_value" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo "Invalid hostname: $hostname_value" >&2; exit 64; }

tls_dir=/opt/edumatch/tls
install -d -m 0700 "$tls_dir"
cert="$tls_dir/fullchain.pem"
key="$tls_dir/privkey.pem"

if [[ -s "$cert" && -s "$key" && "$force" != true ]]; then
  if openssl x509 -in "$cert" -noout -checkend 604800 >/dev/null 2>&1; then
    existing=$(openssl x509 -in "$cert" -noout -ext subjectAltName 2>/dev/null | tr -d ' ' | tail -n1)
    if [[ "$existing" == *"DNS:$hostname_value"* ]]; then
      echo "TLS_CERT_PRESENT hostname=$hostname_value expires=$(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)"
      exit 0
    fi
  fi
fi

openssl_config=$(mktemp)
trap 'rm -f "$openssl_config"' EXIT
cat > "$openssl_config" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no
[dn]
CN = $hostname_value
O = EduMatch staging (self-signed)
[v3_req]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
DNS.1 = $hostname_value
DNS.2 = localhost
IP.1 = 127.0.0.1
EOF

openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
  -keyout "$key" -out "$cert" -config "$openssl_config" >/dev/null 2>&1

chmod 0600 "$key"
chmod 0644 "$cert"

echo "TLS_SELF_SIGNED_CREATED hostname=$hostname_value sha256=$(openssl x509 -in "$cert" -noout -fingerprint -sha256 | cut -d= -f2)"
echo "Export the certificate for the test machine with:"
echo "  aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSession"
