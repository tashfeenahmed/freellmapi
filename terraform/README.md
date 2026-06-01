# Terraform — FreeLLMAPI on OCI Always Free (infra spine)

Provisions the network + A1 instance + load balancer for the deployment in
[`../ORACLE_CLOUD.md`](../ORACLE_CLOUD.md). The app runs as a **Docker container
pulled from GHCR**; [`cloud-init.sh`](./cloud-init.sh) installs Docker and starts
it alongside **Watchtower**, which auto-redeploys when CI publishes a new image.
No SSH-based deploy step — shipping a release = CI building the image.

## What this manages vs. what stays manual

| Managed here (spine) | Stays manual |
|---|---|
| VCN, subnets, gateways, route tables, NSGs | Phase 0 budget / quota / compartment (you did this) |
| A1 instance + full app bring-up via cloud-init | A1 "Out of capacity" retries (re-run `apply`) |
| Flexible LB, backend set, listener (HTTP now / HTTPS when `enable_https`) | DNS A record (unless your DNS is on OCI) |
| **TLS via OCI Certificates** — private Root CA + auto-renewing cert (no Let's Encrypt) | Distributing the CA bundle to clients (one-time) |
| **Observability** (`enable_observability`) — Notifications topic, VCN flow logs, LB logs, alarms | Clicking the email subscription-confirmation link |
| | App-secret Vault for instance-principal key fetch (Phase 4 — not in this spine) |

## Prerequisites

- OCI CLI configured: run `oci setup config` once (creates `~/.oci/config` +
  an API key). **Or** run this as a Resource Manager stack (no local CLI needed).
- A `VM.Standard.A1.Flex` capacity slot in your chosen AD/region.
- The GHCR image built & pushed by `.github/workflows/docker.yml`. That build
  pulls `dhi.io/node:24` base images, so the repo needs `DOCKERHUB_USERNAME` /
  `DOCKERHUB_TOKEN` secrets (a Docker Hardened Images subscription). The
  `DOCKERHUB_TOKEN` is your `dckr_pat_…` Docker Hub token — it belongs in GitHub
  repo secrets, **not** in `terraform.tfvars`.

## Generate tfvars from the CLI

Once `oci setup config` is done, auto-populate most variables (tenancy, region,
AD, Ubuntu A1 image OCID, your SSH key, a fresh encryption key):

```bash
./gen-tfvars.sh                       # writes terraform.tfvars
./gen-tfvars.sh --compartment <ocid>  # use a dedicated compartment (default: tenancy root)
```

Review the result (especially `availability_domain` — switch if you hit A1
"Out of capacity") and back up `encryption_key`.

## Run

```bash
cd terraform
# either ./gen-tfvars.sh  or  cp terraform.tfvars.example terraform.tfvars (then fill in)
terraform init
terraform plan
terraform apply
```

Then:

1. `terraform output load_balancer_public_ip` → add DNS A record
   `freeai.punkadillo.com → <ip>` (TTL 300).
2. Smoke test: `curl http://<lb-ip>/api/ping` should return `200`.
3. **Enable TLS (OCI-native, no Let's Encrypt):** set `enable_https = true` and
   `terraform apply`. Terraform creates a private Root CA + an auto-renewing leaf
   cert and the LB serves HTTPS on 443 — OCI handles renewal and updates the LB.
4. **Trust the cert on clients** (it's from a private CA, not publicly trusted):
   ```bash
   eval "$(terraform output -raw ca_bundle_fetch_cmd)"      # writes ca-bundle.pem
   curl --cacert ca-bundle.pem https://freeai.punkadillo.com/api/ping
   ```
   Or add `ca-bundle.pem` to the client's OS/trust store once.

## Enable observability (Phases 6/7)

Set in `terraform.tfvars`:

```hcl
enable_observability = true
alert_email          = "you@example.com"
```

`terraform apply` then creates: a `free-tier-alerts` Notifications topic + email
subscription, VCN **flow logs** on both subnets, LB **access/error** logs, and
three alarms — **LB unhealthy backend** (app down), **instance CPU > 80%**, and
**egress rate** trending toward the 10 TB/mo cap.

**You must click the confirmation link** OCI emails you, or the subscription
stays silent (`terraform output observability_reminder`). Tune the alarm
thresholds/queries in `observability.tf` to your traffic. The Phase 7 cumulative
**usage-cron** (Usage API) stays a small bash script on the instance — it's not
infra, so it's not codified here.

## Debugging the instance

It's in a private subnet — reach it via **OCI Bastion** (Identity & Security →
Bastion → managed SSH session to the instance OCID from `terraform output`):

```bash
sudo cat /var/log/freellmapi-init.log     # cloud-init progress
cd /opt/freellmapi && sudo docker compose ps
sudo docker compose logs -f freellmapi
```

## Recommended: deploy as a Resource Manager stack

Per ORACLE_CLOUD.md Phase 10, point OCI Resource Manager at this repo (or a zip
of `terraform/`) so state lives in OCI, not your laptop.

## Notes & gotchas

- **A1 "Out of capacity"**: if the ARM pool is persistently full, set
  `use_micro_fallback = true` + `instance_image_ocid_x86` to deploy on the AMD
  Always-Free **E2.1.Micro** (a different pool). Note that pool's shape may only
  be offered in *some* ADs (in this tenancy, only AD-3). Moving micro→A1 later
  replaces the instance (fresh boot volume) — back up `/app/server/data` first.
- **`enable_https` cert chain** (`certificates.tf`), learned the hard way:
  - The CA key **must be HSM-protected** (`protection_mode = "HSM"`) — software
    keys are rejected. HSM keys are still free in the DEFAULT vault.
  - The CA signs via a **dynamic group + `use keys` policy**; without it the CA
    provisions to `FAILED`. A `time_sleep` covers IAM propagation. (There is no
    `certificate-authority` service principal — don't grant one.)
  - Don't pin CA `validity` — it trips a 400 "Unable to process JSON input".
  - A FAILED CA reserves its name until scheduled deletion completes; bump the
    CA `name` suffix to retry sooner.
- **Scheduled deletion**: the Vault, key, and CA don't delete immediately on
  `destroy` / disabling `enable_https` — they enter OCI's mandatory 7–30 day
  *scheduled deletion*. Expected, not an error.
- **CA bundle**: clients trust the private CA via the cert from
  `terraform output ca_bundle_fetch_cmd` (uses `oci certificates ...`, the data
  plane — not `certificates-management`).

## Not yet codified (layer on with the same provider)

- **Phase 4 app-secret flow** — `oci_vault_secret` for the `ENCRYPTION_KEY` plus
  an `oci_identity_dynamic_group` + policy so the instance fetches it at boot via
  instance principal (instead of cloud-init writing it to `.env`).
- **Phase 0 as code** — `oci_budget_budget` + `oci_budget_alert_rule` and
  `oci_limits_quota` (you set these up manually).
- **Phase 7 usage-cron** — the daily Usage-API check is a bash script on the
  instance, not infrastructure.
