# Instance in the private subnet. The app is installed and run entirely by
# cloud-init (Docker + the GHCR image + Watchtower auto-updates) — no SSH-based
# provisioning, so a redeploy is just CI pushing a new image.
#
# Shape is A1.Flex (ARM) by default, or E2.1.Micro (x86, AMD pool) when
# use_micro_fallback = true — a different capacity pool for when A1 is full.
# The multi-arch image runs whichever arch the chosen shape needs.

locals {
  is_micro     = var.use_micro_fallback
  app_shape    = local.is_micro ? "VM.Standard.E2.1.Micro" : "VM.Standard.A1.Flex"
  app_image_id = local.is_micro ? var.instance_image_ocid_x86 : var.instance_image_ocid
}

resource "oci_core_instance" "app" {
  compartment_id      = var.compartment_ocid
  availability_domain = var.availability_domain
  display_name        = "freellmapi-app"
  shape               = local.app_shape

  # E2.1.Micro is a fixed shape (1 OCPU / 1 GB) — no shape_config. Only A1.Flex
  # takes ocpus/memory.
  dynamic "shape_config" {
    for_each = local.is_micro ? [] : [1]
    content {
      ocpus         = var.instance_ocpus
      memory_in_gbs = var.instance_memory_gb
    }
  }

  source_details {
    source_type = "image"
    source_id   = local.app_image_id
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
  # persistently fails, switch `availability_domain`, or set use_micro_fallback
  # to land on the AMD E2.1.Micro pool instead.
  lifecycle {
    precondition {
      condition     = !var.use_micro_fallback || length(var.instance_image_ocid_x86) > 0
      error_message = "Set instance_image_ocid_x86 (an x86_64 Ubuntu image) when use_micro_fallback = true."
    }
  }
}
