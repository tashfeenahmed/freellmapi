output "load_balancer_public_ip" {
  description = "Public IP of the LB. Point freeai.punkadillo.com (A record) at this."
  value       = try(oci_load_balancer_load_balancer.lb.ip_address_details[0].ip_address, null)
}

output "instance_private_ip" {
  description = "Private IP of the A1 instance (reachable only via Bastion / the LB)."
  value       = oci_core_instance.app.private_ip
}

output "instance_ocid" {
  description = "OCID of the A1 instance — use it for the Bastion session and the Phase 4 dynamic group."
  value       = oci_core_instance.app.id
}

output "vcn_ocid" {
  value = oci_core_vcn.vcn.id
}

output "ca_ocid" {
  description = "Private Root CA OCID (null until enable_https = true)."
  value       = try(oci_certificates_management_certificate_authority.root[0].id, null)
}

output "certificate_ocid" {
  description = "Leaf TLS certificate OCID (null until enable_https = true)."
  value       = try(oci_certificates_management_certificate.leaf[0].id, null)
}

# Clients must trust the private CA. This pulls the CA chain to ca-bundle.pem,
# which you then use as `curl --cacert ca-bundle.pem https://freeai.punkadillo.com/...`
# or add to the OS/client trust store.
output "ca_bundle_fetch_cmd" {
  description = "Command to export the CA bundle clients need to trust the cert."
  value = try(
    "oci certificates certificate-authority-bundle get --certificate-authority-id ${oci_certificates_management_certificate_authority.root[0].id} --query 'data.\"certificate-pem\"' --raw-output > ca-bundle.pem",
    "(set enable_https = true and apply to create the CA first)"
  )
}

output "notifications_topic_ocid" {
  description = "ONS topic for alarms (null unless enable_observability = true)."
  value       = try(oci_ons_notification_topic.alerts[0].id, null)
}

output "observability_reminder" {
  description = "Manual step Terraform can't do for you."
  value       = var.enable_observability ? "Check ${var.alert_email} and CLICK the OCI subscription-confirmation link — an unconfirmed email subscription receives nothing." : "(observability disabled)"
}

output "next_steps" {
  value = <<-EOT
    1. Point DNS:  A record  ${var.domain_name} -> ${try(oci_load_balancer_load_balancer.lb.ip_address_details[0].ip_address, "<lb-ip>")}
    2. Smoke test (HTTP): curl http://<lb-ip>/api/ping   (expect 200)
    3. For TLS: set enable_https = true and re-apply. Terraform creates the OCI
       private CA + cert and the LB serves HTTPS on 443 (auto-renewed by OCI).
    4. Export the CA bundle (see `terraform output ca_bundle_fetch_cmd`) and have
       clients trust it: curl --cacert ca-bundle.pem https://${var.domain_name}/api/ping
    5. SSH for debugging via OCI Bastion -> instance OCID ${oci_core_instance.app.id}.
  EOT
}
