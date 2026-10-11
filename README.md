# Kubernetes Linux Package Tracker

A small REST API for tracking Linux packages, used to demonstrate Kubernetes deployments, Helm, Argo CD GitOps, HashiCorp Vault secret injection, MongoDB authentication, and Prometheus metrics.

## Architecture

```mermaid
flowchart TB
  Git[(Git repository)] --> Argo[Argo CD]
  Argo --> API[Node.js API x2]
  Ingress[NGINX Ingress] --> API
  API --> DB[(MongoDB with persistent volume)]
  Vault[HashiCorp Vault] -. injects app URI .-> API
  API -. internal metrics :9090 .-> Prom[Prometheus]
  Grafana[Grafana] --> Prom
```

- **API:** Express 5, Mongoose, request validation, bounded pagination, readiness/liveness endpoints, and Prometheus metrics.
- **Secrets:** The application MongoDB URI is injected from Vault into `/vault/secrets/db-creds.json`. The MongoDB bootstrap/admin credential is created as a Kubernetes Secret and must not be committed to Git. The application uses a separate MongoDB account with `readWrite` access only to the `packages` database.
- **GitOps:** Argo CD reconciles the Helm chart from the `main` branch.
- **Health checks:** `/livez` checks the process; `/readyz` checks database readiness. A database outage should make the API unready, not cause liveness-driven restart loops.
- **Metrics:** The API serves Prometheus metrics on port `9090`, through a separate ClusterIP Service; the public Ingress only targets the HTTP service on port `3000`.

## Requirements

Install Docker, `kubectl`, Minikube, Helm, the Vault CLI, `openssl`, `curl`, and Git. Use a Linux host with enough resources for Minikube (4 CPUs and 6 GiB RAM is a reasonable starting point for this demo).

**MongoDB host-kernel note:** MongoDB's official documentation currently warns that some MongoDB 8.0 builds cannot start on Linux kernel versions 6.19 through 7.0.13; kernel 7.0.14 and later is listed as resolving that specific incompatibility. Check `uname -r` before running MongoDB in a container on a recent Tumbleweed kernel. See the [MongoDB 8.0 release notes](https://www.mongodb.com/docs/v8.0/release-notes/).

## 1. Start Minikube and create a bootstrap credential

Use a fresh local Minikube cluster for the first run. **Do not reuse a MongoDB data directory initialized without authentication without first backing up and migrating it.** `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` are only applied by the Mongo image during first-time initialization of an empty data directory.

```bash
minikube start --cpus=4 --memory=6144 --addons=ingress

# Keep this shell open; the variable is used later to authenticate to MongoDB.
MONGO_ROOT_PASSWORD="$(openssl rand -hex 24)"
kubectl create secret generic mongodb-root-credentials \
  --namespace default \
  --from-literal=username=admin \
  --from-literal=password="$MONGO_ROOT_PASSWORD"

# Build directly into Minikube's image store (no registry required for this local demo).
minikube image build -t package-tracker-api:v1.1.0 ./app
```

If `mongodb-root-credentials` already exists, do not blindly delete or replace it. Confirm the MongoDB data directory's authentication state first.

## 2. Install Vault for the local lab

The following Vault configuration is intentionally **dev-only**: data is not a durable secrets backend, and the root token is `root`. Never use it for a shared or production cluster.

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update
helm install vault hashicorp/vault \
  --set "server.dev.enabled=true" \
  --set "injector.enabled=true"

kubectl rollout status statefulset/vault --timeout=180s
```

In a separate terminal, forward Vault locally:

```bash
kubectl port-forward svc/vault 8200:8200
```

In the terminal you will use for Vault commands:

```bash
export VAULT_ADDR='http://127.0.0.1:8200'
export VAULT_TOKEN='root'
vault status
```

Configure Kubernetes authentication from inside the Vault pod so the Kubernetes API address is the in-cluster service address:

```bash
kubectl exec vault-0 -- sh -ec '
  export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=root
  vault auth enable kubernetes 2>/dev/null || true
  vault write auth/kubernetes/config \
    kubernetes_host="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}"
'
```

Generate a separate application password and store the URI in Vault. The hex password avoids characters that require percent-encoding inside a URI. Keep this shell open until you have created the MongoDB application user in step 5.

```bash
APP_DB_PASSWORD="$(openssl rand -hex 24)"
vault kv put secret/package-tracker \
  mongo_uri="mongodb://package_tracker:${APP_DB_PASSWORD}@mongodb-service:27017/packages?authSource=packages"

vault policy write app-policy - <<'POLICY'
path "secret/data/package-tracker" {
  capabilities = ["read"]
}
POLICY

vault write auth/kubernetes/role/package-tracker-role \
  bound_service_account_names="api-sa" \
  bound_service_account_namespaces="default" \
  policies="app-policy" \
  ttl="1h"
```

The application role can read only the one KV-v2 secret path. The Vault secret's key must be named `mongo_uri`, because the pod template renders that field into the JSON file consumed by the API.

## 3. Install monitoring and Argo CD

The chart's ServiceMonitor expects the Prometheus Operator CRD, so install the monitoring stack before syncing the application.

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace
kubectl wait --for=condition=Established --timeout=180s \
  crd/servicemonitors.monitoring.coreos.com

kubectl create namespace argocd
kubectl apply -n argocd -f \
  https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl rollout status deployment/argocd-server -n argocd --timeout=180s
kubectl apply -f application.yaml
```

Argo CD now reconciles the chart from the repository's `main` branch. Ensure the updated code and chart are committed and pushed before expecting GitOps to deploy these fixes. Check status with:

```bash
kubectl get applications -n argocd
kubectl get pods,svc,ingress,pvc
```

## 4. Create the least-privilege MongoDB application user

Wait for MongoDB to initialize and become ready:

```bash
kubectl rollout status deployment/mongodb --timeout=180s
```

Then create an application user with access only to the `packages` database. This command reads the root username/password from the pod's environment and sends the application password from the current shell to `mongosh` through standard input; the password is not written into a manifest.

```bash
kubectl exec -i deployment/mongodb -- /bin/sh -ec \
  'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" \
    --password "$MONGO_INITDB_ROOT_PASSWORD" \
    --authenticationDatabase admin' <<EOF
const appPassword = "${APP_DB_PASSWORD}";
const appDb = db.getSiblingDB("packages");
appDb.createUser({
  user: "package_tracker",
  pwd: appPassword,
  roles: [{ role: "readWrite", db: "packages" }]
});
EOF
```

If you rerun this command, MongoDB will report that the user already exists. Do not delete the PVC just to rerun setup unless this is disposable lab data; update the existing user's password intentionally if needed.

Wait for the API pods to become ready:

```bash
kubectl rollout status deployment/package-tracker-api --timeout=180s
kubectl get pods
```

## 5. Access the API

Map the local Ingress hostname to Minikube's IP:

```bash
echo "$(minikube ip) packagetracker.local" | sudo tee -a /etc/hosts
```

Create a package and list packages:

```bash
curl -i http://packagetracker.local/api/packages \
  -H 'Content-Type: application/json' \
  -d '{"name":"htop","manager":"zypper","description":"Interactive process viewer"}'

curl -i 'http://packagetracker.local/api/packages?page=1&pageSize=20'
curl -i http://packagetracker.local/readyz
curl -i http://packagetracker.local/livez
```

`POST /api/packages` returns `400` for missing/invalid fields and unknown properties. `GET /api/packages` supports `page` and `pageSize` (maximum `100`) and returns pagination metadata with the documents.

The Ingress is local HTTP only. Do not point a public DNS name at it without adding TLS, authentication, and an appropriate network/security policy.

## 6. Verify observability

The metrics listener is not exposed through the public Ingress. Check the metrics service from your local machine using port-forwarding:

```bash
kubectl port-forward svc/package-tracker-metrics 9090:9090
curl http://127.0.0.1:9090/metrics
```

Prometheus should discover the `package-tracker-api` ServiceMonitor in the `monitoring` namespace. In Prometheus, query `http_requests_total` and `http_request_duration_seconds_bucket` after making several API requests. Use Grafana to inspect Kubernetes resource dashboards and add an application dashboard using these metrics.

## 7. Local development and tests

```bash
cd app
npm install
npm test
npm run check
```

`npm install` generates `package-lock.json` if it is not present. Commit that lockfile and use `npm ci` in Docker/CI for repeatable dependency resolution; do not leave dependency resolution unpinned for a portfolio release.

Validate the Helm chart before pushing:

```bash
helm lint ./helm-chart
helm template package-tracker ./helm-chart --namespace default
```

## Limitations to document honestly

- The MongoDB Deployment has one replica. A PVC provides persistence, not database high availability or backup.
- The Vault `dev` server is ephemeral and is only for a laptop demo.
- The MongoDB root credential lives in a Kubernetes Secret; restrict RBAC and do not commit secret values. Only the API connection URI is injected from Vault in this demo.
- The sample Ingress serves HTTP and the API does not implement user authentication; keep it on a trusted local cluster.
- The project demonstrates rolling-update configuration, but claim zero downtime only after testing it while requests are continuously sent.

## Cleanup

```bash
kubectl delete -f application.yaml
helm uninstall monitoring -n monitoring
helm uninstall vault
minikube stop
```

The PVC has a keep policy to reduce the risk of deleting MongoDB data during chart cleanup. Inspect `kubectl get pvc` and delete `mongodb-pvc` manually only when you intentionally want to destroy the local lab database.
