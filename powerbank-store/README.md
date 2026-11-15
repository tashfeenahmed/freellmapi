# VoltPack — Power Bank Store (Shopify + Apple Pay + Visa)

A fast, single-page storefront for selling power banks. Products and checkout come from **your Shopify store**
through the Shopify Storefront API, so customers pay on Shopify's secure checkout with
**Apple Pay, Visa, Mastercard, Amex, Google Pay and Shop Pay**. No server needed; it's plain HTML/CSS/JS.

## How it works
1. The site loads your products from Shopify (`config.js` → Storefront API).
2. Customers add power banks to the cart (stored in the browser).
3. On **Checkout** / **Apple Pay**, the site creates a Shopify cart and redirects to Shopify's `checkoutUrl`.
4. Shopify takes the payment (Apple Pay / Visa / …), creates the order, and sends the confirmation email.

Card data never touches this site, so you don't need PCI compliance work of your own.

## Setup (≈10 minutes)

### 1. Turn on Apple Pay + Visa in Shopify
- Shopify admin → **Settings → Payments** → activate **Shopify Payments**.
  This enables Visa, Mastercard, Amex, etc.
- In the same page, under **Wallets**, turn on **Apple Pay** (and Google Pay / Shop Pay if you want).

### 2. Add your power banks as products
- **Products → Add product**. Set title, price, images, variants (colors), stock.
- Optional: set **Product type** (e.g. `Compact`, `Magnetic`, `High capacity`). These become filter chips.
- Optional: add a tag like `badge:Bestseller` to show a badge on the card.
- Make sure the products are available to the **Headless** sales channel (see step 3).

### 3. Get a Storefront API token
- Install the free **Headless** channel from the Shopify App Store (or Settings → Apps and sales channels → Develop apps).
- Create a storefront and copy the **public Storefront API access token**.
- Permissions needed: read product listings, write/read checkouts (carts).

### 4. Fill in `config.js`
```js
window.STORE_CONFIG = {
  shopDomain: "your-store.myshopify.com",
  storefrontToken: "your-public-storefront-token",
  apiVersion: "2026-07",
  collectionHandle: "",   // e.g. "power-banks" to show only that collection
  storeName: "VoltPack",
  currency: "USD",
};
```
The public Storefront token is designed to be used in the browser; it is safe to publish. Never put an **Admin** API token here.

### 5. Run / deploy
Local preview:
```bash
npx serve .
```
Deploy for free: drag the folder onto Netlify Drop, or use Vercel, Cloudflare Pages or GitHub Pages.
Apple Pay works automatically on the Shopify checkout page on Safari, iPhone and Mac.

## Demo mode
With `shopDomain`/`storefrontToken` empty, the site shows sample products so you can preview the design.
Checkout is disabled in demo mode.

## Files
| File | Purpose |
|------|---------|
| `index.html` | Page layout: hero, product grid, FAQ, cart drawer |
| `styles.css` | Styling (responsive, mobile-friendly) |
| `app.js` | Product loading, cart, Shopify checkout |
| `config.js` | Your Shopify store settings |
