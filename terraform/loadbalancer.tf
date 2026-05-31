# Public Flexible load balancer (fixed 10 Mbps — the Always Free shape).
# Backend = the private instance on 3001. Health check hits /api/ping, which is
# unauthenticated (unlike /v1/models, which needs a bearer token).

resource "oci_load_balancer_load_balancer" "lb" {
  compartment_id             = var.compartment_ocid
  display_name               = "freellmapi-lb"
  shape                      = "flexible"
  subnet_ids                 = [oci_core_subnet.public.id]
  network_security_group_ids = [oci_core_network_security_group.lb.id]
  is_private                 = false

  shape_details {
    minimum_bandwidth_in_mbps = 10
    maximum_bandwidth_in_mbps = 10
  }
}

resource "oci_load_balancer_backend_set" "bs" {
  load_balancer_id = oci_load_balancer_load_balancer.lb.id
  name             = "freellmapi-bs"
  policy           = "ROUND_ROBIN"

  health_checker {
    protocol          = "HTTP"
    port              = 3001
    url_path          = "/api/ping"
    return_code       = 200
    interval_ms       = 10000
    timeout_in_millis = 3000
    retries           = 3
  }
}

resource "oci_load_balancer_backend" "be" {
  load_balancer_id = oci_load_balancer_load_balancer.lb.id
  backendset_name  = oci_load_balancer_backend_set.bs.name
  ip_address       = oci_core_instance.app.private_ip
  port             = 3001
  backup           = false
  drain            = false
  offline          = false
  weight           = 1
}

# HTTPS listener — TLS terminates here using the OCI Certificates-service cert
# from certificates.tf; the instance stays plain HTTP on 3001. OCI auto-renews
# the cert and the LB picks up the new version (only one certificate_ids entry
# is allowed).
resource "oci_load_balancer_listener" "https" {
  count                    = var.enable_https ? 1 : 0
  load_balancer_id         = oci_load_balancer_load_balancer.lb.id
  name                     = "freellmapi-https"
  default_backend_set_name = oci_load_balancer_backend_set.bs.name
  port                     = 443
  protocol                 = "HTTP"

  ssl_configuration {
    certificate_ids         = [oci_certificates_management_certificate.leaf[0].id]
    verify_peer_certificate = false
  }
}

# Plain HTTP listener on 443 for the initial smoke test (before a cert exists).
resource "oci_load_balancer_listener" "http" {
  count                    = var.enable_https ? 0 : 1
  load_balancer_id         = oci_load_balancer_load_balancer.lb.id
  name                     = "freellmapi-http"
  default_backend_set_name = oci_load_balancer_backend_set.bs.name
  port                     = 443
  protocol                 = "HTTP"
}
