terraform {
  required_version = ">= 1.5.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 5.0.0"
    }
  }
}

provider "oci" {
  tenancy_ocid = var.tenancy_ocid
  region       = var.region
  # Auth resolves from the standard OCI config file (~/.oci/config) or, when run
  # inside OCI Resource Manager / on an instance, from the instance principal.
  # No keys are committed here.
}
