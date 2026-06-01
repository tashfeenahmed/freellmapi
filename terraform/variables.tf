# ---------------------------------------------------------------------------
# Identity / region
# ---------------------------------------------------------------------------

variable "tenancy_ocid" {
  type        = string
  description = "OCID of your tenancy."
}

variable "compartment_ocid" {
  type        = string
  description = "OCID of the compartment to deploy into (your Phase 0 compartment)."
}

variable "region" {
  type        = string
  description = "Home region with A1 capacity (Ashburn or Phoenix)."
  default     = "us-ashburn-1"
}

variable "availability_domain" {
  type        = string
  description = <<-EOT
    Full AD name to place the A1 instance in, e.g. "Uocm:US-ASHBURN-AD-1".
    List them with: oci iam availability-domain list --compartment-id <tenancy>.
    A1 capacity varies per AD — if you hit "Out of capacity", try another.
  EOT
}

# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------

variable "ssh_public_key" {
  type        = string
  description = "SSH public key (contents, not path) for the opc user on the instance."
}

variable "lb_ingress_cidrs" {
  type        = list(string)
  description = <<-EOT
    CIDRs allowed to hit the load balancer on 443. Defaults to the whole
    internet — tighten to Procedure's egress IPs per ORACLE_CLOUD.md Phase 9.
  EOT
  default     = ["0.0.0.0/0"]
}

# ---------------------------------------------------------------------------
# Compute
# ---------------------------------------------------------------------------

variable "instance_ocpus" {
  type        = number
  description = "A1 OCPUs (Always Free total budget is 4)."
  default     = 1
}

variable "instance_memory_gb" {
  type        = number
  description = "A1 memory in GB (Always Free total budget is 24)."
  default     = 6
}

variable "instance_image_ocid" {
  type        = string
  description = <<-EOT
    OCID of a Canonical Ubuntu 22.04 *aarch64* image in your region (for the A1
    ARM shape). Find it:
    oci compute image list --compartment-id <compartment> \
      --operating-system "Canonical Ubuntu" --operating-system-version "22.04" \
      --shape VM.Standard.A1.Flex --query 'data[0].id' --raw-output
  EOT
}

variable "use_micro_fallback" {
  type        = bool
  description = <<-EOT
    false → A1.Flex ARM instance (instance_ocpus/instance_memory_gb).
    true  → VM.Standard.E2.1.Micro (x86, fixed 1 OCPU / 1 GB) on the AMD
            Always-Free pool — a different capacity pool, usually available when
            A1 is "Out of capacity". The multi-arch image runs its amd64 leg.
            Flip back to A1 later by setting this false and re-applying.
  EOT
  default     = false
}

variable "instance_image_ocid_x86" {
  type        = string
  description = <<-EOT
    OCID of a Canonical Ubuntu 22.04 *x86_64* image (only used when
    use_micro_fallback = true). Find it with --shape VM.Standard.E2.1.Micro.
  EOT
  default     = ""
}

# ---------------------------------------------------------------------------
# App / deployment (consumed by cloud-init.sh)
# ---------------------------------------------------------------------------

variable "app_image" {
  type        = string
  description = "Full GHCR image ref the instance pulls and runs."
  default     = "ghcr.io/tashfeenahmed/freellmapi:latest"
}

variable "encryption_key" {
  type        = string
  sensitive   = true
  description = <<-EOT
    64-char hex ENCRYPTION_KEY for the app (decrypts stored provider keys —
    back it up). Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))".
    For a no-plaintext-on-disk setup, leave blank and fetch from Vault per
    ORACLE_CLOUD.md Phase 4 instead.
  EOT
}

variable "ghcr_username" {
  type        = string
  description = "GitHub username for pulling the image (only needed if the GHCR package is private)."
  default     = ""
}

variable "ghcr_pull_token" {
  type        = string
  sensitive   = true
  description = "GHCR read:packages PAT (only needed if the GHCR package is private)."
  default     = ""
}

variable "proxy_rate_limit_rpm" {
  type        = number
  description = "Max /v1 proxy requests per minute per client IP (0 disables)."
  default     = 120
}

# ---------------------------------------------------------------------------
# Load balancer / TLS — OCI Certificates service (Phase 5, Pattern A)
# ---------------------------------------------------------------------------
# When enabled, Terraform stands up an OCI private Root CA (backed by a free
# DEFAULT Vault key) and issues the LB's TLS cert from it. OCI auto-renews the
# cert and auto-updates the LB — no Let's Encrypt, no renewal cron. The cert is
# private-trust: clients must trust the CA bundle (see terraform/README.md).

variable "enable_https" {
  type        = bool
  description = <<-EOT
    false → LB serves plain HTTP on 443 (initial smoke test).
    true  → Terraform creates the Vault key + Root CA + leaf cert and the LB
            serves HTTPS on 443 with OCI-managed auto-renewal.
  EOT
  default     = false
}

variable "domain_name" {
  type        = string
  description = "FQDN the cert is issued for (CN + SAN)."
  default     = "freeai.punkadillo.com"
}

variable "tls_lb_certificate_name" {
  type        = string
  description = "Legacy: LB-local cert name (pre-mTLS). Unused now that the listener uses the cert-service model; kept for reference."
  default     = "letsencrypt-freeai"
}

variable "tls_server_certificate_id" {
  type        = string
  description = <<-EOT
    OCID of the Certificate-service IMPORTED certificate (the Let's Encrypt
    server cert). Created/renewed out-of-band via
    `oci certs-mgmt certificate (create|update)-...-importing-config`; the OCID
    is stable across renewals (only the version changes).
  EOT
}

variable "tls_client_ca_bundle_id" {
  type        = string
  description = <<-EOT
    OCID of the Certificate-service CA bundle holding the private CLIENT CA.
    Clients must present a cert signed by it (mTLS). Created with
    `oci certs-mgmt ca-bundle create`.
  EOT
}

variable "ca_common_name" {
  type        = string
  description = "Common name shown on the private Root CA."
  default     = "FreeLLMAPI Internal Root CA"
}

variable "ca_not_after" {
  type        = string
  description = <<-EOT
    Root CA expiry (RFC 3339). Must be later than any leaf cert. A static far
    date avoids Terraform perpetual-diff (timestamp() can't be used here).
  EOT
  default     = "2035-01-01T00:00:00Z"
}

# ---------------------------------------------------------------------------
# Observability (Phase 6/7 — Notifications, logs, alarms)
# ---------------------------------------------------------------------------

variable "enable_observability" {
  type        = bool
  description = <<-EOT
    Create the Notifications topic + email subscription, VCN flow logs (both
    subnets), LB access/error logs, and the Monitoring alarms. Requires
    alert_email. All Always Free (Logging 10 GB/mo, Monitoring + 1M notifications).
  EOT
  default     = false
}

variable "alert_email" {
  type        = string
  description = <<-EOT
    Destination for alarm emails. Required when enable_observability = true.
    OCI sends a confirmation link you MUST click — an unconfirmed subscription
    is silent.
  EOT
  default     = ""

  validation {
    # Only constrains the format; the "required when enabled" check lives as a
    # precondition on the subscription resource (a variable can't see other vars).
    condition     = var.alert_email == "" || can(regex("^[^@ ]+@[^@ ]+\\.[^@ ]+$", var.alert_email))
    error_message = "alert_email must be a valid email address."
  }
}

variable "log_retention_days" {
  type        = number
  description = "Retention for flow/LB logs (30–180). Logging free tier is 10 GB/mo ingestion."
  default     = 30
}
