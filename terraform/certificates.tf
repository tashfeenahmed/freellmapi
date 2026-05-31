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

# Software-protected RSA-2048 key (length is in bytes: 256 = 2048-bit). HSM keys
# would require a paid Virtual Private Vault.
resource "oci_kms_key" "ca" {
  count               = var.enable_https ? 1 : 0
  compartment_id      = var.compartment_ocid
  display_name        = "freellmapi-ca-key"
  management_endpoint = oci_kms_vault.cert[0].management_endpoint
  protection_mode     = "SOFTWARE"

  key_shape {
    algorithm = "RSA"
    length    = 256
  }
}

# Let the Certificates service use the signing key (service principal, required
# regardless of your own admin rights).
resource "oci_identity_policy" "cert_service_keys" {
  count          = var.enable_https ? 1 : 0
  compartment_id = var.compartment_ocid
  name           = "freellmapi-cert-service-keys"
  description    = "Allow the OCI Certificates service to use the CA signing key"
  statements = [
    "Allow service certificate-authority to use keys in compartment id ${var.compartment_ocid}",
  ]
}

resource "oci_certificates_management_certificate_authority" "root" {
  count          = var.enable_https ? 1 : 0
  compartment_id = var.compartment_ocid
  name           = "freellmapi-root-ca"
  kms_key_id     = oci_kms_key.ca[0].id

  certificate_authority_config {
    config_type       = "ROOT_CA_GENERATED_INTERNALLY"
    signing_algorithm = "SHA256_WITH_RSA"

    subject {
      common_name = var.ca_common_name
    }

    validity {
      time_of_validity_not_after = var.ca_not_after
    }
  }

  depends_on = [oci_identity_policy.cert_service_keys]
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
