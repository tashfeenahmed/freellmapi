# A1 instance in the private subnet. The app is installed and run entirely by
# cloud-init (Docker + the GHCR image + Watchtower auto-updates) — no SSH-based
# provisioning, so a redeploy is just CI pushing a new image.

resource "oci_core_instance" "app" {
  compartment_id      = var.compartment_ocid
  availability_domain = var.availability_domain
  display_name        = "freellmapi-app"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gb
  }

  source_details {
    source_type = "image"
    source_id   = var.instance_image_ocid
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.private.id
    assign_public_ip = false
    nsg_ids          = [oci_core_network_security_group.app.id]
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/cloud-init.sh", {
      app_image            = var.app_image
      encryption_key       = var.encryption_key
      ghcr_username        = var.ghcr_username
      ghcr_pull_token      = var.ghcr_pull_token
      proxy_rate_limit_rpm = var.proxy_rate_limit_rpm
    }))
  }

  # A1 capacity is frequently "Out of capacity". Re-running apply retries; if it
  # persistently fails, switch `availability_domain` or region per Phase 2.
}
