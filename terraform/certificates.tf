# OCI-native TLS: a private Root CA issues the load balancer's cert, and OCI
# auto-renews it + auto-updates the LB. All Always Free (5 CAs / 150 certs).
# Everything here is gated on enable_https so the plain-HTTP spine still applies
# without it.
#
# Trust model: certs from an OCI private CA are NOT publicly trusted. Clients
# must trust the CA bundle — fine for this single-user, IP-locked API. Export it
# with the command in `terraform output ca_bundle_fetch_cmd`.
#
# Gotchas:
#  - The Vault and CA enter a *scheduled* (7–30 day) deletion on destroy; they
#    are not removed immediately.
#  - The IAM service policy below is eventually consistent. If the CA fails to
#    create with a key-permission error on first apply, just re-run apply.

# DEFAULT (free) vault to hold the CA signing key.
resource "oci_kms_vault" "cert" {
  count          = var.enable_https ? 1 : 0
  compartment_id = var.compartment_ocid
  display_name   = "freellmapi-vault"
  vault_type     = "DEFAULT"
}

# HSM-backed RSA-2048 key (length is in bytes: 256 = 2048-bit). OCI Certificate
# Authorities REQUIRE an HSM key; HSM keys are free in the DEFAULT vault (only a
# dedicated Virtual Private Vault is paid).
resource "oci_kms_key" "ca" {
  count               = var.enable_https ? 1 : 0
  compartment_id      = var.compartment_ocid
  display_name        = "freellmapi-ca-key"
  management_endpoint = oci_kms_vault.cert[0].management_endpoint
  protection_mode     = "HSM"

  key_shape {
    algorithm = "RSA"
    length    = 256
  }
}

# The CA, as a resource principal, must use the Vault key to sign — granted via
# a dynamic group (matching certificate authorities in the compartment) + a
# `use keys` policy. Without it the CA provisions to FAILED. Dynamic groups must
# live in the tenancy (root) compartment.
resource "oci_identity_dynamic_group" "ca" {
  count          = var.enable_https ? 1 : 0
  compartment_id = var.tenancy_ocid
  name           = "freellmapi-ca-dg"
  description    = "FreeLLMAPI certificate authorities (use the Vault signing key)"
  matching_rule  = "ALL {resource.type = 'certificateauthority', resource.compartment.id = '${var.compartment_ocid}'}"
}

resource "oci_identity_policy" "ca_use_key" {
  count          = var.enable_https ? 1 : 0
  compartment_id = var.compartment_ocid
  name           = "freellmapi-ca-use-key"
  description    = "Allow the CA dynamic group to use the Vault signing key"
  statements = [
    "Allow dynamic-group ${oci_identity_dynamic_group.ca[0].name} to use keys in compartment id ${var.compartment_ocid}",
  ]
}

# IAM is eventually consistent — give the dynamic group + policy time to
# propagate before the CA tries to use the key (else it provisions to FAILED).
resource "time_sleep" "iam_propagation" {
  count           = var.enable_https ? 1 : 0
  depends_on      = [oci_identity_policy.ca_use_key, oci_identity_dynamic_group.ca]
  create_duration = "90s"
}

resource "oci_certificates_management_certificate_authority" "root" {
  count          = var.enable_https ? 1 : 0
  compartment_id = var.compartment_ocid
  # Unique name: the previous failed CA holds "freellmapi-root-ca" until its
  # scheduled deletion. Bump the suffix if a future attempt also fails.
  name       = "freellmapi-root-ca-v2"
  kms_key_id = oci_kms_key.ca[0].id

  certificate_authority_config {
    config_type       = "ROOT_CA_GENERATED_INTERNALLY"
    signing_algorithm = "SHA256_WITH_RSA"

    subject {
      common_name = var.ca_common_name
    }
    # Validity omitted — OCI assigns its default root-CA lifetime. Pinning
    # time_of_validity_not_after tripped a 400 "Unable to process JSON input".
  }

  depends_on = [time_sleep.iam_propagation]
}

# Leaf TLS cert for the domain. No explicit validity → OCI's default lifetime
# with automatic renewal; the LB association picks up renewed versions.
resource "oci_certificates_management_certificate" "leaf" {
  count          = var.enable_https ? 1 : 0
  compartment_id = var.compartment_ocid
  name           = "freellmapi-tls"

  certificate_config {
    config_type                     = "ISSUED_BY_INTERNAL_CA"
    issuer_certificate_authority_id = oci_certificates_management_certificate_authority.root[0].id
    certificate_profile_type        = "TLS_SERVER_OR_CLIENT"
    key_algorithm                   = "RSA2048"
    signature_algorithm             = "SHA256_WITH_RSA"

    subject {
      common_name = var.domain_name
    }

    subject_alternative_names {
      type  = "DNS"
      value = var.domain_name
    }
  }
}
