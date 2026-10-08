#!/bin/bash
# install.sh — Deploy freellmapi to k3s
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="/home/aldo/dev/08-infra-k3s/manifests/service-definitions/freellmapi"
kubectl apply -f "$K8S_DIR/"
kubectl rollout status deployment/freellmapi --timeout=120s
