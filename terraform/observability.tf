# Phase 6/7 — Observability, gated on enable_observability (needs alert_email).
# Notifications topic + email, VCN flow logs (both subnets), LB access/error
# logs, and Monitoring alarms. All Always Free.

# --- Notifications ------------------------------------------------------------

resource "oci_ons_notification_topic" "alerts" {
  count          = var.enable_observability ? 1 : 0
  compartment_id = var.compartment_ocid
  name           = "free-tier-alerts"
}

resource "oci_ons_subscription" "email" {
  count          = var.enable_observability ? 1 : 0
  compartment_id = var.compartment_ocid
  topic_id       = oci_ons_notification_topic.alerts[0].id
  protocol       = "EMAIL"
  endpoint       = var.alert_email

  # Can't reference other variables in a variable validation, so enforce the
  # "email required when observability is on" rule here.
  lifecycle {
    precondition {
      condition     = length(var.alert_email) > 0
      error_message = "Set alert_email when enable_observability = true."
    }
  }
}

# --- Logging (flow logs + LB logs) --------------------------------------------

resource "oci_logging_log_group" "main" {
  count          = var.enable_observability ? 1 : 0
  compartment_id = var.compartment_ocid
  display_name   = "freellmapi"
}

# VCN flow logs on both subnets — the real security-visibility win (shows who's
# probing the LB / what's accepted vs rejected).
resource "oci_logging_log" "flow_public" {
  count              = var.enable_observability ? 1 : 0
  display_name       = "vcn-flow-public"
  log_group_id       = oci_logging_log_group.main[0].id
  log_type           = "SERVICE"
  is_enabled         = true
  retention_duration = var.log_retention_days

  configuration {
    compartment_id = var.compartment_ocid
    source {
      category    = "all"
      resource    = oci_core_subnet.public.id
      service     = "flowlogs"
      source_type = "OCISERVICE"
    }
  }
}

resource "oci_logging_log" "flow_private" {
  count              = var.enable_observability ? 1 : 0
  display_name       = "vcn-flow-private"
  log_group_id       = oci_logging_log_group.main[0].id
  log_type           = "SERVICE"
  is_enabled         = true
  retention_duration = var.log_retention_days

  configuration {
    compartment_id = var.compartment_ocid
    source {
      category    = "all"
      resource    = oci_core_subnet.private.id
      service     = "flowlogs"
      source_type = "OCISERVICE"
    }
  }
}

resource "oci_logging_log" "lb_access" {
  count              = var.enable_observability ? 1 : 0
  display_name       = "lb-access"
  log_group_id       = oci_logging_log_group.main[0].id
  log_type           = "SERVICE"
  is_enabled         = true
  retention_duration = var.log_retention_days

  configuration {
    compartment_id = var.compartment_ocid
    source {
      category    = "access"
      resource    = oci_load_balancer_load_balancer.lb.id
      service     = "loadbalancer"
      source_type = "OCISERVICE"
    }
  }
}

resource "oci_logging_log" "lb_error" {
  count              = var.enable_observability ? 1 : 0
  display_name       = "lb-error"
  log_group_id       = oci_logging_log_group.main[0].id
  log_type           = "SERVICE"
  is_enabled         = true
  retention_duration = var.log_retention_days

  configuration {
    compartment_id = var.compartment_ocid
    source {
      category    = "error"
      resource    = oci_load_balancer_load_balancer.lb.id
      service     = "loadbalancer"
      source_type = "OCISERVICE"
    }
  }
}

# --- Monitoring alarms --------------------------------------------------------

# App is down: LB sees an unhealthy backend.
resource "oci_monitoring_alarm" "lb_unhealthy" {
  count                 = var.enable_observability ? 1 : 0
  compartment_id        = var.compartment_ocid
  metric_compartment_id = var.compartment_ocid
  display_name          = "freellmapi-lb-unhealthy-backend"
  namespace             = "oci_lbaas"
  query                 = "UnHealthyBackendServers[1m].mean() >= 1"
  severity              = "CRITICAL"
  pending_duration      = "PT1M"
  destinations          = [oci_ons_notification_topic.alerts[0].id]
  is_enabled            = true
  message_format        = "ONS_OPTIMIZED"
  body                  = "FreeLLMAPI: load balancer reports an unhealthy backend — the app may be down."
}

# Sustained high CPU. Needs the Compute Instance Monitoring plugin (Oracle Cloud
# Agent) enabled on the instance, which the Ubuntu image ships with.
resource "oci_monitoring_alarm" "instance_cpu" {
  count                 = var.enable_observability ? 1 : 0
  compartment_id        = var.compartment_ocid
  metric_compartment_id = var.compartment_ocid
  display_name          = "freellmapi-instance-cpu-high"
  namespace             = "oci_computeagent"
  query                 = "CpuUtilization[5m].mean() > 80"
  severity              = "WARNING"
  pending_duration      = "PT5M"
  destinations          = [oci_ons_notification_topic.alerts[0].id]
  is_enabled            = true
  message_format        = "ONS_OPTIMIZED"
  body                  = "FreeLLMAPI: instance CPU sustained above 80%."
}

# Phase 7: egress-rate early warning toward the 10 TB/mo cap (~3.86 MB/s avg).
# Rate-based, not an exact monthly sum — tune the threshold to your traffic.
resource "oci_monitoring_alarm" "egress_rate" {
  count                 = var.enable_observability ? 1 : 0
  compartment_id        = var.compartment_ocid
  metric_compartment_id = var.compartment_ocid
  display_name          = "freellmapi-egress-rate-high"
  namespace             = "oci_vcn"
  query                 = "VnicToNetworkBytes[5m].rate() > 3000000"
  severity              = "WARNING"
  pending_duration      = "PT1H"
  destinations          = [oci_ons_notification_topic.alerts[0].id]
  is_enabled            = true
  message_format        = "ONS_OPTIMIZED"
  body                  = "FreeLLMAPI: outbound traffic above ~3 MB/s for 1h — trending toward the 10 TB/mo free cap."
}
