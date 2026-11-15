(() => {
  "use strict";
  const CFG = window.STORE_CONFIG || {};
  const LIVE = Boolean(CFG.shopDomain && CFG.storefrontToken);
  const CART_KEY = "powerbank_cart_v1";
  const $ = (s) => document.querySelector(s);

  // ───────── Sample products (used only in demo mode) ─────────
  const DEMO_PRODUCTS = [
    { id: "demo-1", title: "VoltPack Mini 10K", type: "Compact", color: "#0f172a", tag: "Bestseller",
      description: "10,000 mAh · 20 W USB-C PD · fits any pocket",
      variants: [ { id: "demo-1-black", title: "Midnight Black", price: 29.99, compareAt: 39.99, available: true },
                  { id: "demo-1-white", title: "Arctic White", price: 29.99, compareAt: 39.99, available: true } ] },
    { id: "demo-2", title: "VoltPack MagGo 5K", type: "Magnetic", color: "#7c3aed", tag: "New",
      description: "5,000 mAh · magnetic wireless · iPhone 12–17",
      variants: [ { id: "demo-2-purple", title: "Lavender", price: 34.99, available: true },
                  { id: "demo-2-black", title: "Graphite", price: 34.99, available: true } ] },
    { id: "demo-3", title: "VoltPack Pro 20K", type: "High capacity", color: "#16a34a",
      description: "20,000 mAh · 65 W · charges laptops & phones",
      variants: [ { id: "demo-3-green", title: "Forest Green", price: 59.99, compareAt: 74.99, available: true } ] },
    { id: "demo-4", title: "VoltPack Max 27K", type: "High capacity", color: "#b91c1c", tag: "Flight-safe",
      description: "27,000 mAh · 140 W · 99 Wh carry-on approved",
      variants: [ { id: "demo-4-red", title: "Crimson", price: 99.99, available: true } ] },
    { id: "demo-5", title: "VoltPack Slim 10K", type: "Compact", color: "#0369a1",
      description: "10,000 mAh · 12 mm thin · built-in USB-C cable",
      variants: [ { id: "demo-5-blue", title: "Ocean Blue", price: 39.99, available: true } ] },
    { id: "demo-6", title: "VoltPack Solar 25K", type: "Outdoor", color: "#ca8a04",
      description: "25,000 mAh · solar panel · IP67 waterproof · torch",
      variants: [ { id: "demo-6-yellow", title: "Sun Yellow", price: 69.99, compareAt: 84.99, available: true } ] },
  ];

  // ───────── Shopify Storefront API ─────────
  async function shopify(query, variables = {}) {
    const res = await fetch(`https://${CFG.shopDomain}/api/${CFG.apiVersion || "2026-07"}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": CFG.storefrontToken },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Shopify API error ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
    return json.data;
  }

  const PRODUCT_FIELDS = `
    id title handle description productType tags
    featuredImage { url altText }
    variants(first: 25) { nodes {
      id title availableForSale
      price { amount currencyCode }
      compareAtPrice { amount currencyCode }
      image { url altText }
    } }`;

  async function loadShopifyProducts() {
    let nodes;
    if (CFG.collectionHandle) {
      const d = await shopify(`query($h:String!){ collection(handle:$h){ products(first:50){ nodes { ${PRODUCT_FIELDS} } } } }`,
        { h: CFG.collectionHandle });
      nodes = d.collection ? d.collection.products.nodes : [];
    } else {
      const d = await shopify(`query{ products(first:50, sortKey:BEST_SELLING){ nodes { ${PRODUCT_FIELDS} } } }`);
      nodes = d.products.nodes;
    }
    return nodes.map((p) => ({
      id: p.id,
      title: p.title,
      type: p.productType || "",
      description: p.description ? p.description.slice(0, 110) : "",
      image: p.featuredImage && p.featuredImage.url,
      tag: (p.tags || []).find((t) => /^badge:/i.test(t))?.slice(6),
      variants: p.variants.nodes.map((v) => ({
        id: v.id,
        title: v.title === "Default Title" ? "" : v.title,
        price: Number(v.price.amount),
        compareAt: v.compareAtPrice ? Number(v.compareAtPrice.amount) : null,
        currency: v.price.currencyCode,
        available: v.availableForSale,
        image: v.image && v.image.url,
      })),
    }));
  }

  async function createCheckout(lines) {
    const d = await shopify(
      `mutation($input: CartInput!){ cartCreate(input:$input){ cart { id checkoutUrl } userErrors { field message } } }`,
      { input: { lines: lines.map((l) => ({ merchandiseId: l.variantId, quantity: l.qty })) } }
    );
    const errs = d.cartCreate.userErrors;
    if (errs && errs.length) throw new Error(errs.map((e) => e.message).join("; "));
    return d.cartCreate.cart.checkoutUrl;
  }

  // ───────── State ─────────
  let products = [];
  let filter = "All";
  let cart = readCart();

  function readCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
  }
  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* storage unavailable */ }
  }

  const money = (n, cur) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: cur || CFG.currency || "USD" }).format(n);

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function art(p, v) {
    const img = (v && v.image) || p.image;
    return img ? `<img src="${esc(img)}" alt="${esc(p.title)}" loading="lazy">`
               : `<div class="pb" style="--c:${esc(p.color || "#111")}">⚡</div>`;
  }

  // ───────── Rendering ─────────
  function renderFilters() {
    const types = ["All", ...new Set(products.map((p) => p.type).filter(Boolean))];
    if (types.length <= 2) { $("#filters").innerHTML = ""; return; }
    $("#filters").innerHTML = types.map((t) =>
      `<button class="chip ${t === filter ? "active" : ""}" data-filter="${esc(t)}">${esc(t)}</button>`).join("");
  }

  function renderProducts() {
    const list = products.filter((p) => filter === "All" || p.type === filter);
    if (!list.length) { $("#products").innerHTML = `<div class="empty">No products found.</div>`; return; }
    $("#products").innerHTML = list.map((p) => {
      const v = p.variants.find((x) => x.available) || p.variants[0];
      const many = p.variants.length > 1;
      return `
      <article class="card" data-product="${esc(p.id)}">
        <div class="media">${p.tag ? `<span class="tag">${esc(p.tag)}</span>` : ""}${art(p, v)}</div>
        <div class="body">
          <h3>${esc(p.title)}</h3>
          <p class="specs">${esc(p.description)}</p>
          ${many ? `<select aria-label="Choose option">${p.variants.map((x) =>
            `<option value="${esc(x.id)}" ${x.id === v.id ? "selected" : ""} ${x.available ? "" : "disabled"}>${esc(x.title)}${x.available ? "" : " — sold out"}</option>`).join("")}</select>` : ""}
          <div class="price-row">
            <span class="price">${money(v.price, v.currency)}${v.compareAt && v.compareAt > v.price ? `<s>${money(v.compareAt, v.currency)}</s>` : ""}</span>
            <button class="btn primary add" ${v.available ? "" : "disabled"}>${v.available ? "Add to cart" : "Sold out"}</button>
          </div>
        </div>
      </article>`;
    }).join("");
  }

  function renderCart() {
    const count = cart.reduce((n, l) => n + l.qty, 0);
    const subtotal = cart.reduce((n, l) => n + l.qty * l.price, 0);
    $("#cartCount").textContent = count;
    $("#subtotal").textContent = money(subtotal, cart[0] && cart[0].currency);
    $("#checkoutBtn").disabled = $("#applePayBtn").disabled = !count;
    $("#cartItems").innerHTML = count ? cart.map((l, i) => `
      <div class="line">
        <div class="thumb">${l.image ? `<img src="${esc(l.image)}" alt="">` : `<div class="pb" style="--c:${esc(l.color || "#111")}">⚡</div>`}</div>
        <div>
          <div class="title">${esc(l.title)}</div>
          ${l.variantTitle ? `<div class="variant">${esc(l.variantTitle)}</div>` : ""}
          <div class="qty"><button data-dec="${i}" aria-label="Decrease">−</button><span>${l.qty}</span><button data-inc="${i}" aria-label="Increase">+</button></div>
        </div>
        <div class="lp">${money(l.price * l.qty, l.currency)}<button class="rm" data-rm="${i}">Remove</button></div>
      </div>`).join("")
      : `<div class="cart-empty">Your cart is empty.<br>Add a power bank to get started ⚡</div>`;
  }

  // ───────── Cart actions ─────────
  function addToCart(p, v) {
    const existing = cart.find((l) => l.variantId === v.id);
    if (existing) existing.qty += 1;
    else cart.push({ variantId: v.id, title: p.title, variantTitle: v.title, price: v.price, currency: v.currency,
                     qty: 1, image: v.image || p.image || null, color: p.color || null });
    saveCart(); renderCart();
    toast(`Added ${p.title} to cart`);
  }

  function openCart() {
    $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false");
    $("#overlay").hidden = false;
  }
  function closeCart() {
    $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true");
    $("#overlay").hidden = true;
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  async function checkout(e) {
    if (!cart.length) return;
    const btn = e.currentTarget; const label = btn.innerHTML;
    if (!LIVE) { toast("Demo mode: add your Shopify store in config.js to accept Apple Pay & Visa."); return; }
    btn.disabled = true; btn.textContent = "Redirecting to secure checkout…";
    try {
      const url = await createCheckout(cart);
      window.location.href = url; // Shopify checkout: Apple Pay, Visa, Mastercard, Shop Pay, Google Pay…
    } catch (err) {
      console.error(err);
      toast("Checkout failed: " + err.message);
      btn.disabled = false; btn.innerHTML = label;
    }
  }

  // ───────── Events ─────────
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (chip) { filter = chip.dataset.filter; renderFilters(); renderProducts(); return; }

    const add = e.target.closest(".add");
    if (add) {
      const card = add.closest(".card");
      const p = products.find((x) => x.id === card.dataset.product);
      const sel = card.querySelector("select");
      const v = sel ? p.variants.find((x) => x.id === sel.value) : p.variants.find((x) => x.available) || p.variants[0];
      if (v && v.available) addToCart(p, v);
      return;
    }
    const inc = e.target.closest("[data-inc]"), dec = e.target.closest("[data-dec]"), rm = e.target.closest("[data-rm]");
    if (inc) cart[+inc.dataset.inc].qty++;
    else if (dec) { const l = cart[+dec.dataset.dec]; l.qty--; if (l.qty < 1) cart.splice(+dec.dataset.dec, 1); }
    else if (rm) cart.splice(+rm.dataset.rm, 1);
    else return;
    saveCart(); renderCart();
  });

  document.addEventListener("change", (e) => {
    if (e.target.matches(".card select")) {
      const card = e.target.closest(".card");
      const p = products.find((x) => x.id === card.dataset.product);
      const v = p.variants.find((x) => x.id === e.target.value);
      card.querySelector(".price").innerHTML = money(v.price, v.currency) +
        (v.compareAt && v.compareAt > v.price ? `<s>${money(v.compareAt, v.currency)}</s>` : "");
      if (v.image) card.querySelector(".media img")?.setAttribute("src", v.image);
    }
  });

  $("#openCart").addEventListener("click", openCart);
  $("#closeCart").addEventListener("click", closeCart);
  $("#overlay").addEventListener("click", closeCart);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCart(); });
  $("#checkoutBtn").addEventListener("click", checkout);
  $("#applePayBtn").addEventListener("click", checkout);

  // Show the Apple Pay button only on devices that support it (Safari / iOS / macOS).
  // Shopify checkout itself also shows Apple Pay automatically on those devices.
  const applePayOK = window.ApplePaySession && (() => { try { return ApplePaySession.canMakePayments(); } catch { return false; } })();
  if (!applePayOK && !/[?&]applepay=1/.test(location.search)) $("#applePayBtn").hidden = true;

  // ───────── Boot ─────────
  async function init() {
    const name = CFG.storeName || "VoltPack";
    $("#brandName").textContent = name;
    document.querySelectorAll(".store-name").forEach((n) => (n.textContent = name));
    $("#year").textContent = new Date().getFullYear();
    $("#demoBanner").hidden = LIVE;
    renderCart();
    try {
      products = LIVE ? await loadShopifyProducts()
                      : DEMO_PRODUCTS.map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, currency: CFG.currency || "USD" })) }));
    } catch (err) {
      console.error(err);
      $("#products").innerHTML = `<div class="empty">Could not load products from Shopify: ${esc(err.message)}</div>`;
      return;
    }
    renderFilters(); renderProducts();
  }
  init();
})();
