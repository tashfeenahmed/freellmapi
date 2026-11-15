// ─────────────────────────────────────────────────────────────
//  Shopify connection settings
//  1. Shopify admin → Settings → Apps and sales channels → Develop apps
//     (or install the free "Headless" channel) → create a Storefront API token
//     with scopes: unauthenticated_read_product_listings,
//                  unauthenticated_write_checkouts, unauthenticated_read_checkouts
//  2. Paste your store domain + public Storefront token below.
//  Leave them empty to run the site in DEMO mode with sample products.
// ─────────────────────────────────────────────────────────────
window.STORE_CONFIG = {
  shopDomain: "",            // e.g. "my-powerbank-shop.myshopify.com"
  storefrontToken: "",       // public Storefront API access token
  apiVersion: "2026-07",     // any supported Storefront API version
  collectionHandle: "",      // optional: only show products from this collection
  storeName: "VoltPack",
  currency: "USD",
};
