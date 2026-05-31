# FreeLLMAPI on Oracle Cloud Always Free — complete deployment guide

One end-to-end runbook: from a fresh OCI account to a hardened, always-on `https://freeai.punkadillo.com`, using only Always Free services, with secrets in Vault, full observability, and email alerts before any limit is exhausted. The final section answers "can I deploy this with Terraform?" — yes, and there's a starter scaffold.

```
Client ──▶ DNS: freeai.punkadillo.com ──▶ Load Balancer (public subnet, TLS 443)
                                                   │
                                                   ▼
                                      A1 instance (private subnet, nginx → :3001)
                                                   │
                              ┌────────────────────┼────────────────────┐
                              ▼                                          ▼
                        Vault (keys)                          Logging + Monitoring
                          all inside one VCN, watched by alarms → email
```

---

## Read this first — the free-tier catches that actually cost money

1. **Vault: create a DEFAULT vault, never "Virtual Private Vault."** The private type is a paid resource. Free allowance is **20 key versions** — fine for one master key plus secrets.
2. **Load Balancer is capped at 10 Mbps.** Choose the **Flexible** shape, min = max = 10. Plenty for JSON/SSE; useless for video.
3. **Ampere A1 capacity** is frequently "Out of capacity" — use Ashburn or Phoenix and retry. This is the step most likely to stall you.
4. **`ENCRYPTION_KEY` decrypts every stored provider key.** Back it up with the database or the keys are unrecoverable.
5. The app is **single-user by design**; keep the endpoint locked to IPs you control.

---

## Phase 0 — Account and guardrails (do this before building anything)

1. Sign up at `https://cloud.oracle.com`. A card is required for verification (small temporary hold; no charge inside Always Free). Pick **US East (Ashburn)** or **US West (Phoenix)** as home region for A1 availability.
2. **Budget alert** (dollar backstop): Console → **Billing & Cost Management → Budgets → Create Budget**. Scope your root compartment, period Monthly, amount **$1**. Add an alert rule: type **Actual spend**, threshold **80%**, your email. On a free-only account this should never fire.
3. **Quota guardrail** (prevents accidental paid compute): Console → **Governance & Administration → Quota Policies → Create**:
   ```
   set  compute-core quota standard-a1-core-count to 4 in compartment <compartment>
   zero compute-core quota standard-e4-core-count    in compartment <compartment>
   zero compute-core quota standard-e5-core-count    in compartment <compartment>
   ```
   (The console autocompletes exact limit names.)

Guardrails first means a mistake during the build can't quietly start billing.

---

## Phase 1 — Network (VCN, subnets, security groups)

1. Console → **Networking → Virtual Cloud Networks → Start VCN Wizard** → "VCN with Internet Connectivity." This creates a VCN with a **public subnet** and a **private subnet**, plus Internet Gateway, **NAT Gateway**, and route tables. The NAT Gateway lets the private instance reach providers and Vault outbound while staying unreachable inbound.
2. Create two **Network Security Groups** (Networking → VCN → Network Security Groups):
   - **nsg-lb** (for the load balancer): ingress TCP **443** from `0.0.0.0/0` — or, tighter, only from your office/known IPs.
   - **nsg-app** (for the instance): ingress TCP **3001** *only* with source = **nsg-lb**. No internet ingress at all.

---

## Phase 2 — Compute (A1 instance, private)

1. Console → **Compute → Instances → Create instance**.
   - Image **Canonical Ubuntu 22.04**.
   - Shape → *Change shape* → **Ampere → VM.Standard.A1.Flex**, set **1 OCPU / 6 GB** (the app idles at ~40 MB; leaves headroom).
   - Networking: **private subnet**, **do not assign a public IPv4**, attach **nsg-app**.
   - Paste your SSH public key.
   - On `Out of capacity`: retry, switch Availability Domain, or use a community retry script.
2. SSH into a private instance via **OCI Bastion** (no extra charge): **Identity & Security → Bastion** → create a bastion → create an SSH session to the instance. (OCI Cloud Shell also works.)

---

## Phase 3 — Install and run the app

> **Two ways to run it. This repo is Docker-first and that's the supported path
> here.** CI (`.github/workflows/docker.yml`) builds a multi-arch image and
> publishes it to `ghcr.io/<owner>/freellmapi`, and `terraform/cloud-init.sh`
> installs Docker on the A1 box and runs that image plus **Watchtower** (which
> auto-redeploys on every new push). If you provision with `terraform/`, the app
> is already running on first boot — skip the manual steps below. The bare-metal
> Node + PM2 + nginx instructions that follow are the alternative for a hand-built
> instance; with the Docker path the LB talks straight to the container on `:3001`,
> so **no nginx is needed**.

On the instance (bare-metal alternative):

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential python3 git    # build-essential compiles better-sqlite3 on ARM

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install

cp .env.example .env
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
sed -i "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$KEY/" .env   # clean single-line replace

npm run build
node server/dist/index.js     # smoke test on :3001, then Ctrl-C
```

Keep it always-on with PM2:

```bash
sudo npm install -g pm2
pm2 start server/dist/index.js --name freellmapi
pm2 save
pm2 startup systemd           # run the sudo command it prints
```

Reverse proxy with nginx (HTTP only — the LB handles TLS in Phase 5, Pattern A):

```bash
sudo apt install -y nginx
sudo tee /etc/nginx/sites-available/freellmapi >/dev/null <<'NGINX'
server {
    listen 80;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;     # required: the API streams via SSE
    }
}
NGINX
sudo ln -s /etc/nginx/sites-available/freellmapi /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

---

## Phase 4 — Secrets in Vault

Pattern with no app code changes: Vault protects the master `ENCRYPTION_KEY` (and optionally backs up provider keys); the instance pulls it at boot via **instance principals**, so nothing sensitive sits in plaintext on disk.

1. **Identity & Security → Vault → Create Vault** — **leave the default type; do NOT tick Virtual Private Vault.**
2. In the vault: **Create Key** (AES, software-protected) — your one master key.
3. **Create Secrets** under that key: `freellmapi-encryption-key` = the 64-char hex value; optionally one secret per provider key as backup.
4. Authorize the instance:
   - **Dynamic group** matching the instance OCID.
   - **Policy:** `Allow dynamic-group freellmapi-instances to read secret-family in compartment <compartment>`
5. Install the CLI and fetch at boot (add before `pm2 start`, e.g. in a small systemd pre-start or the cloud-init script):
   ```bash
   bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"
   SECRET_OCID="<ocid of freellmapi-encryption-key>"
   KEY=$(oci secrets secret-bundle get --auth instance_principal --secret-id "$SECRET_OCID" \
         --query 'data."secret-bundle-content".content' --raw-output | base64 -d)
   sed -i "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$KEY/" ~/freellmapi/.env
   ```

---

## Phase 5 — Public entry point: Load Balancer + DNS + HTTPS

**Load Balancer:**
1. **Networking → Load Balancers → Create Load Balancer.** Type Load Balancer (L7), Visibility **Public** in the **public subnet**, Shape **Flexible min 10 / max 10**, attach **nsg-lb**.
2. **Backend set:** add the instance on port **3001**; health check HTTP `GET /api/ping` (unauthenticated — unlike `/v1/models`, which needs a bearer token and would read as unhealthy).
3. **Listener:** **HTTPS on 443**, terminating TLS at the LB with an **OCI Certificates-service** cert (below). Instance stays plain HTTP on 3001.
4. Copy the LB **public IP**.

**DNS:** in your `punkadillo.com` DNS host, add an **A record** `freeai` → `<LB public IP>`, TTL 300.

**Certificate — OCI Certificates service (no Let's Encrypt):**

The `terraform/` stack does this for you when `enable_https = true`: it creates a
private **Root CA** (backed by a free DEFAULT Vault key) and issues the LB's leaf
cert from it. **OCI auto-renews the cert and auto-updates the LB** — no certbot,
no 90-day cron. This is Always Free (5 CAs / 150 certs).

Trade-off: a cert from an OCI private CA is **not publicly trusted**. Clients
must trust the CA bundle once — which is fine here, since the endpoint is
single-user and IP-locked (Phase 9) and you control the client:

```bash
# export the CA chain clients need to trust
oci certificates-management certificate-authority-bundle get \
  --certificate-authority-id <ca-ocid> \
  --query 'data."cert-chain-pem"' --raw-output > ca-bundle.pem

curl --cacert ca-bundle.pem https://freeai.punkadillo.com/api/ping   # 200
```

(Console equivalent: **Identity & Security → Certificates → Certificate
Authorities → Create CA**, then **Certificates → Create Certificate** issued by
it, then select that cert on the LB's HTTPS listener.)

After DNS propagates, `https://freeai.punkadillo.com/v1/models` with your bearer
token (and `--cacert ca-bundle.pem`) should respond.

---

## Phase 6 — Observability (logging + monitoring)

> **Codified in [`terraform/observability.tf`](./terraform/observability.tf).**
> Set `enable_observability = true` + `alert_email` and apply to create the
> Notifications topic + email subscription, VCN flow logs (both subnets), LB
> access/error logs, and the alarms below. You still must **click the email
> confirmation link**. The console steps that follow are the manual equivalent.
> (Docker path note: logs come from the LB/VCN services and `docker compose logs`
> on the instance — no PM2 log files.)

1. **Notifications topic** (shared delivery channel): **Developer Services → Notifications → Create Topic** `free-tier-alerts` → **Create Subscription → Email** → **confirm the link in your inbox** (unconfirmed = silent).
2. **Logging (10 GB/mo free):** **Observability & Management → Logging** → create a log group `freellmapi`; install the **Unified Monitoring Agent** and point it at `~/.pm2/logs/freellmapi-*.log`; enable **Load Balancer access/error logs**; enable **VCN Flow Logs** on both subnets (this is the real security-visibility win — shows who's probing the LB).
3. **Monitoring alarms** → target the topic:
   - LB **unhealthy backend count ≥ 1** (app is down).
   - Instance **CPU > 80%** sustained.

---

## Phase 7 — Alerts before Always Free limits run out

OCI has **no native "85% of free tier" email** like AWS. Assemble it; budget + quota (Phase 0) are the foundation, the rest are early warnings.

> The **egress-rate alarm** (#2 below) is codified in `terraform/observability.tf`.
> The **forgotten-compute** alarm (#1) is omitted there — this instance runs the
> app 24/7, so `CpuUtilization > 0%` would always fire; the CPU-high alarm covers
> it instead. The **usage cron** (#3) stays a small bash script on the instance.

1. **Forgotten/extra compute** (the #1 way people fall off free): alarm on `CpuUtilization > 0%` for 5 min on any should-be-idle instance → topic.
2. **Egress trend (toward 10 TB/mo):** alarm on `VnicToNetworkBytes` above **~3 MB/s for 1 h** (10 TB/mo ≈ 3.86 MB/s average). It's a rate-based early warning, not an exact monthly sum.
3. **Cumulative caps (egress + logging) via a daily cron** using the Usage API, emailing through the topic at ≥ 80%:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   TENANCY="<tenancy-ocid>"; TOPIC="<free-tier-alerts-topic-ocid>"
   START=$(date -u +%Y-%m-01T00:00:00Z); END=$(date -u +%Y-%m-%dT23:59:59Z)
   USAGE=$(oci usage-api usage-summary request-summarized-usages --auth instance_principal \
     --tenant-id "$TENANCY" --time-usage-started "$START" --time-usage-ended "$END" \
     --granularity MONTHLY --query-type USAGE --group-by '["skuName"]' \
     --query 'data.items[].{sku:"sku-name",qty:"computed-quantity"}' 2>/dev/null)
   check () {
     local used; used=$(echo "$USAGE" | grep -i "$2" | grep -oE '[0-9.]+' | head -1 || echo 0)
     awk -v u="$used" -v l="$3" 'BEGIN{exit !(l>0 && (u/l)>=0.80)}' \
       && oci ons message publish --auth instance_principal --topic-id "$TOPIC" \
            --title "OCI free tier: $1 >= 80%" --message-body "$1: $used / $3 (month-to-date)"
   }
   check "Outbound data transfer" "Data Transfer" 10240   # 10 TB in GB
   check "Logging ingestion"      "Logging"       10      # 10 GB
   ```
   Schedule: `0 8 * * * /opt/freetier-check.sh`. **Tune the `grep` matches** to the exact line-item labels in **Cost Analysis** — they vary by region.
4. **Manual spot-check:** **Governance & Administration → Tenancy Management → Limits, Quotas and Usage** before provisioning anything new.

| Layer | Catches | Role |
|---|---|---|
| Budget $1 (Phase 0) | any real charge | foundation |
| Quota policies (Phase 0) | accidental paid compute | foundation (hard block) |
| `CpuUtilization` alarm | forgotten instances | high-value early warning |
| Usage cron | egress + logging caps | needs one-time tuning |

---

## Phase 8 — Backups (so a reclaimed instance costs nothing)

The boot volume survives reboots; the risk is account reclamation. Back up off-box.

```bash
cd ~/freellmapi && find . -iname "*.db" -o -iname "*.sqlite*"   # locate <DB_PATH>
mkdir -p ~/backups
# daily tarball of DB + .env (the ENCRYPTION_KEY is mandatory for restore)
( crontab -l 2>/dev/null; echo '0 3 * * * tar czf ~/backups/freellmapi-$(date +\%F).tar.gz <DB_PATH> ~/freellmapi/.env' ) | crontab -
```
Push `~/backups` to **Object Storage (20 GB free)** with `rclone` for true off-instance safety.

---

## Phase 9 — Harden the public endpoint

The proxy is a single-user, key-bearing service, so lock it down rather than leaving the LB open to the world:

- **Restrict ingress:** scope **nsg-lb** port 443 to Procedure's egress IPs instead of `0.0.0.0/0`, so only known networks can reach the endpoint at all.
- **Keep the instance unreachable:** it stays in the private subnet with `nsg-app` allowing 3001 only from `nsg-lb` — nothing from the internet touches it directly.
- **Watch the traffic:** VCN flow logs (Phase 6) record every accepted/rejected connection, so you can see who's probing the LB.
- **Authenticate every call:** rely on the unified `freellmapi-…` bearer token; never expose the endpoint or token publicly.
- **Optional:** add `fail2ban` on the instance to throttle SSH brute-force via the bastion.

Together these give you a hardened public endpoint without any extra paid services.

---

## Phase 10 — Deploy it all as code (Terraform / Resource Manager)

**Yes — this is Terraform's home turf.** OCI ships a first-class provider (`oracle/oci`), so the workflow is identical to "Terraform for AWS," just a different provider block. Two ways to run it:

- **Local Terraform:** `terraform init / plan / apply` from your laptop.
- **OCI Resource Manager:** Oracle's managed Terraform service (their CloudFormation equivalent) — free to use, runs your config and stores state for you. Upload a zip or point it at a Git repo, then *Plan* and *Apply* in the console.

What's automatable vs. not:

| Automatable in Terraform | Stays manual / semi-manual |
|---|---|
| VCN, subnets, gateways, route tables, NSGs | Confirming the email subscription (click the link) |
| A1 instance + the entire app install via **cloud-init** `user_data` | A1 "Out of capacity" retries |
| Load Balancer, backend set, listener | — |
| **TLS: OCI private CA + auto-renewing cert** (Certificates service) | Distributing the CA bundle to clients (one-time) |
| Notifications topic + subscription, flow/LB logs, Monitoring alarms (`observability.tf`) | First DNS delegation (if moving nameservers) |
| Vault + key + CA for TLS (`certificates.tf`) | Phase 7 usage-cron (bash on the instance, not infra) |
| Budget + alert rule, quota policy | |
| DNS A record (if DNS is on a Terraform-supported provider) | |

> **A working spine now lives in [`terraform/`](./terraform/).** It implements
> the network + A1 instance (with Docker bring-up via `cloud-init.sh`) + load
> balancer described below, with real variables instead of `<…>` placeholders.
> `cp terraform.tfvars.example terraform.tfvars`, fill it in, then
> `terraform init && plan && apply`. See [`terraform/README.md`](./terraform/README.md).
> The scaffold below is kept as the conceptual reference.

**Starter scaffold** (`main.tf` — the infra spine; validate with `terraform plan`, fill in the `<…>` OCIDs):

```hcl
terraform {
  required_providers { oci = { source = "oracle/oci" } }
}
provider "oci" {
  tenancy_ocid = var.tenancy_ocid
  region       = var.region
  # auth via config file or instance principal
}

variable "tenancy_ocid" {}
variable "compartment_ocid" {}
variable "region" { default = "us-ashburn-1" }
variable "ssh_public_key" {}

# --- Network ---
resource "oci_core_vcn" "vcn" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "freellmapi-vcn"
}
resource "oci_core_internet_gateway" "igw" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
}
resource "oci_core_nat_gateway" "nat" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
}
resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.vcn.id
  cidr_block                 = "10.0.1.0/24"
  display_name               = "public"
  prohibit_public_ip_on_vnic = false
}
resource "oci_core_subnet" "private" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.vcn.id
  cidr_block                 = "10.0.2.0/24"
  display_name               = "private"
  prohibit_public_ip_on_vnic = true
}
resource "oci_core_network_security_group" "lb"  { compartment_id = var.compartment_ocid  vcn_id = oci_core_vcn.vcn.id }
resource "oci_core_network_security_group" "app" { compartment_id = var.compartment_ocid  vcn_id = oci_core_vcn.vcn.id }
resource "oci_core_network_security_group_security_rule" "lb_443" {
  network_security_group_id = oci_core_network_security_group.lb.id
  direction = "INGRESS" protocol = "6" source = "0.0.0.0/0"   # tighten to your IPs
  tcp_options { destination_port_range { min = 443 max = 443 } }
}
resource "oci_core_network_security_group_security_rule" "app_3001" {
  network_security_group_id = oci_core_network_security_group.app.id
  direction = "INGRESS" protocol = "6"
  source = oci_core_network_security_group.lb.id source_type = "NETWORK_SECURITY_GROUP"
  tcp_options { destination_port_range { min = 3001 max = 3001 } }
}

# --- Compute (app installed via cloud-init) ---
resource "oci_core_instance" "app" {
  compartment_id      = var.compartment_ocid
  availability_domain = "<AD-name>"
  shape               = "VM.Standard.A1.Flex"
  shape_config { ocpus = 1  memory_in_gbs = 6 }
  source_details { source_type = "image"  source_id = "<ubuntu-22.04-arm-image-ocid>" }
  create_vnic_details {
    subnet_id        = oci_core_subnet.private.id
    assign_public_ip = false
    nsg_ids          = [oci_core_network_security_group.app.id]
  }
  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(file("${path.module}/cloud-init.sh"))  # does apt/node/clone/build/pm2/nginx
  }
}

# --- Load balancer ---
resource "oci_load_balancer_load_balancer" "lb" {
  compartment_id = var.compartment_ocid
  display_name   = "freellmapi-lb"
  shape          = "flexible"
  shape_details { minimum_bandwidth_in_mbps = 10  maximum_bandwidth_in_mbps = 10 }
  subnet_ids     = [oci_core_subnet.public.id]
  network_security_group_ids = [oci_core_network_security_group.lb.id]
  is_private     = false
}
resource "oci_load_balancer_backend_set" "bs" {
  load_balancer_id = oci_load_balancer_load_balancer.lb.id
  name             = "freellmapi-bs"
  policy           = "ROUND_ROBIN"
  health_checker { protocol = "HTTP"  port = 3001  url_path = "/v1/models" }
}
resource "oci_load_balancer_backend" "be" {
  load_balancer_id = oci_load_balancer_load_balancer.lb.id
  backendset_name  = oci_load_balancer_backend_set.bs.name
  ip_address       = oci_core_instance.app.private_ip
  port             = 3001
}
# listener: add oci_load_balancer_listener (HTTPS 443 + imported cert, or TCP 443 passthrough)
```

Then layer on the rest with the same provider:
`oci_kms_vault` / `oci_kms_key` / `oci_vault_secret` (Phase 4), `oci_identity_dynamic_group` + `oci_identity_policy`, `oci_ons_notification_topic` + `oci_ons_subscription` (Phase 6), `oci_monitoring_alarm` (Phase 7), `oci_budget_budget` + `oci_budget_alert_rule` and `oci_limits_quota` (Phase 0), and `oci_dns_*` if your DNS is on OCI. The values for each come from the matching phase above.

> Honest framing: the scaffold is a real starting point, not a tested turnkey config. Run `terraform plan` and reconcile any provider-version syntax before `apply`. The cleanest workflow is to put the whole thing in a Git repo and deploy it as a Resource Manager stack so state lives in OCI, not on your laptop.

---

## Service → Always Free mapping

| Service | Free allowance | Used for |
|---|---|---|
| Ampere A1 compute | 4 OCPU / 24 GB total | the app host |
| Flexible Load Balancer | 1, 10 Mbps | public TLS entry point |
| Vault (default type) | 20 key versions | master key + secrets |
| Logging | 10 GB / month | app, LB, VCN flow logs |
| Monitoring + Notifications | included / 1M msgs | alarms + email |
| VCN | 2 VCNs | the network |
| Object Storage | 20 GB | off-box backups |
| Budgets + Quotas | included | cost + provisioning guardrails |

## Day-2 quick reference

| Task | Command |
|---|---|
| App status / logs (Docker path) | `cd /opt/freellmapi && sudo docker compose ps` · `sudo docker compose logs -f freellmapi` |
| Restart app (Docker path) | `sudo docker compose restart freellmapi` |
| Update app (Docker path) | Automatic via Watchtower on each CI push; manual: `sudo docker compose pull && sudo docker compose up -d` |
| App status / update (bare-metal path) | `pm2 status` · `cd ~/freellmapi && git pull && npm install && npm run build && pm2 restart freellmapi` |
| Cert renewal | Automatic — OCI Certificates service renews the cert and updates the LB; nothing to run |
| Check free-tier headroom | Console → Limits, Quotas and Usage |