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

# HTTPS listener — TLS terminates here; the instance stays plain HTTP on 3001.
# Cert-service model (required for mTLS):
#   - server cert = the Let's Encrypt cert IMPORTED into the Certificates service
#     (var.tls_server_certificate_id). Stable OCID; renewal updates the cert
#     VERSION in place (`oci certs-mgmt certificate update-...-importing-config`),
#     so the listener never changes — no drift, no ignore_changes needed.
#   - mTLS: verify_peer_certificate + trusted_certificate_authority_ids points at
#     a CA bundle (var.tls_client_ca_bundle_id) of our private client CA, so only
#     clients presenting a cert signed by it can connect (IP-independent).
resource "oci_load_balancer_listener" "https" {
  count                    = var.enable_https ? 1 : 0
  load_balancer_id         = oci_load_balancer_load_balancer.lb.id
  name                     = "freellmapi-https"
  default_backend_set_name = oci_load_balancer_backend_set.bs.name
  port                     = 443
  protocol                 = "HTTP"

  ssl_configuration {
    certificate_ids                   = [var.tls_server_certificate_id]
    verify_peer_certificate           = true
    verify_depth                      = 2
    trusted_certificate_authority_ids = [var.tls_client_ca_bundle_id]
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
