import { useState } from 'react'
import { ArrowDown, ArrowRight, Check, Menu, MessageCircle, Sparkles, Truck, X } from 'lucide-react'

const whatsappNumber = '8801892753543'

const products = [
  {
    name: 'Noor',
    subtitle: 'নরম, উষ্ণ ও মায়াবী',
    category: 'নারীদের',
    price: 1290,
    image: 'photo-1594035910387-fea47794261f',
    tone: 'rose',
    tag: 'বেস্টসেলার',
  },
  {
    name: 'Oud Noir',
    subtitle: 'গভীর কাঠের আভিজাত্য',
    category: 'পুরুষদের',
    price: 1590,
    image: 'photo-1541643600914-78b084683601',
    tone: 'sand',
    tag: 'সিগনেচার',
  },
  {
    name: 'Rose Velvet',
    subtitle: 'ফুলেল, কোমল ও পরিশীলিত',
    category: 'নারীদের',
    price: 1190,
    image: 'photo-1592945403244-b3fbafd7f539',
    tone: 'lilac',
    tag: 'নতুন',
  },
  {
    name: 'Citrus Bloom',
    subtitle: 'সতেজ দিনের অনুষঙ্গ',
    category: 'ইউনিসেক্স',
    price: 1090,
    image: 'photo-1590736969955-71cc94901144',
    tone: 'sage',
    tag: 'দৈনন্দিন',
  },
]

const categories = ['সবগুলো', 'নারীদের', 'পুরুষদের', 'ইউনিসেক্স']
type Product = (typeof products)[number]

function supportLink(message = 'Hello, I need support with a Seez perfume order.') {
  return `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`
}

export default function SeezStore() {
  const [category, setCategory] = useState('সবগুলো')
  const [menuOpen, setMenuOpen] = useState(false)
  const [orderOpen, setOrderOpen] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [orderBusy, setOrderBusy] = useState(false)
  const [orderError, setOrderError] = useState('')
  const [orderSuccess, setOrderSuccess] = useState(false)
  const visibleProducts = category === 'সবগুলো'
    ? products
    : products.filter((product) => product.category === category)

  function openOrder(product: Product | null = null) {
    setSelectedProduct(product)
    setOrderError('')
    setOrderOpen(true)
  }

  return (
    <div className="seez-page">
      <div className="seez-announcement">
        <Sparkles size={13} aria-hidden="true" />
        <span>আপনার প্রতিটি দিনের জন্য, একটুখানি বিশেষ সুবাস</span>
      </div>

      <header className="seez-header">
        <a className="seez-logo" href="#home" aria-label="Seez হোম">
          <span className="seez-logo-word">seez<span>.</span></span>
          <small>PERFUME</small>
        </a>
        <button
          className="seez-menu-toggle"
          type="button"
          aria-label={menuOpen ? 'মেনু বন্ধ করুন' : 'মেনু খুলুন'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X size={21} /> : <Menu size={21} />}
        </button>
        <nav className={menuOpen ? 'seez-nav is-open' : 'seez-nav'} aria-label="প্রধান নেভিগেশন">
          <a href="#collection" onClick={() => setMenuOpen(false)}>কালেকশন</a>
          <a href="#story" onClick={() => setMenuOpen(false)}>আমাদের কথা</a>
          <a href="#contact" onClick={() => setMenuOpen(false)}>সাপোর্ট</a>
          <a className="seez-support-link" href={supportLink()} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>
            <MessageCircle size={14} aria-hidden="true" /> WhatsApp সাপোর্ট
          </a>
          <button className="seez-nav-cta" type="button" onClick={() => openOrder()}>
            অর্ডার করুন <ArrowRight size={15} aria-hidden="true" />
          </button>
        </nav>
      </header>

      <main>
        <section className="seez-hero" id="home">
          <div className="seez-hero-copy">
            <p className="seez-eyebrow"><span /> YOUR SIGNATURE SCENT</p>
            <h1 className="seez-brand-heading">SEEZ<br /><em>PERFUME</em></h1>
            <p className="seez-tagline">A little is enough.</p>
            <p className="seez-hero-description">
              প্রতিটি সুবাসে থাকুক আভিজাত্যের ছোঁয়া—আপনার প্রতিদিনের জন্য,
              আপনার নিজের মতো করে।
            </p>
            <div className="seez-hero-actions">
              <a className="seez-button seez-button-dark" href="#collection">
                কালেকশন দেখুন <ArrowDown size={16} aria-hidden="true" />
              </a>
              <button className="seez-button seez-button-outline" type="button" onClick={() => openOrder()}>
                অর্ডার করুন <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="seez-hero-proof">
              <span className="seez-proof-mark"><Check size={15} /></span>
              <span>সরাসরি অর্ডার <i /> WhatsApp সাপোর্ট: +880 1892-753543</span>
            </div>
          </div>
          <div className="seez-hero-visual">
            <img
              src="https://images.unsplash.com/photo-1594035910387-fea47794261f?auto=format&fit=crop&w=1200&q=85"
              alt="সোনালি আলোয় সুগন্ধির বোতল"
              fetchPriority="high"
            />
            <div className="seez-hero-image-wash" />
            <div className="seez-hero-stamp"><span>THE ART OF</span><strong>SCENT</strong><small>SEEZ · EST. FOR YOU</small></div>
            <div className="seez-image-caption">
              <span className="seez-caption-line" />
              <span>নিজের মতো করে সুন্দর</span>
            </div>
            <div className="seez-floating-note">
              <span className="seez-note-spark">✳</span>
              <span><strong>Find your scent</strong><small>সুগন্ধ হোক আপনার গল্প</small></span>
            </div>
          </div>
          <div className="seez-hero-index">01 <span /> 04</div>
        </section>

        <section className="seez-perks" aria-label="Seez-এর বিশেষত্ব">
          <div className="seez-perk">
            <span className="seez-perk-icon"><Sparkles size={18} /></span>
            <span><strong>বেছে নেওয়া কালেকশন</strong><small>আপনার পছন্দের জন্য নানা সুবাস</small></span>
          </div>
          <div className="seez-perk">
            <span className="seez-perk-icon"><MessageCircle size={18} /></span>
            <span><strong>সহজে অর্ডার</strong><small>ওয়েবসাইট থেকেই অর্ডার দিন</small></span>
          </div>
          <div className="seez-perk">
            <span className="seez-perk-icon"><Truck size={18} /></span>
            <span><strong>ডেলিভারির তথ্য</strong><small>অর্ডারের সময় বিস্তারিত জেনে নিন</small></span>
          </div>
        </section>

        <section className="seez-collection" id="collection">
          <div className="seez-section-heading">
            <div>
              <p className="seez-eyebrow"><span /> THE SELECTION</p>
              <h2>আপনার পরের <em>প্রিয় সুবাস।</em></h2>
            </div>
            <p>মুড, মুহূর্ত আর নিজের সঙ্গে মানিয়ে<br className="seez-desktop-break" /> বেছে নিন আপনার পছন্দ।</p>
          </div>

          <div className="seez-filter-row">
            <div className="seez-filters" role="group" aria-label="পণ্য বাছাই">
              {categories.map((item) => (
                <button
                  type="button"
                  className={category === item ? 'seez-filter is-active' : 'seez-filter'}
                  key={item}
                  aria-pressed={category === item}
                  onClick={() => setCategory(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <span className="seez-result-count">
              {visibleProducts.length.toLocaleString('bn-BD', { minimumIntegerDigits: 2, useGrouping: false })} টি সুবাস
            </span>
          </div>

          <div className="seez-product-grid">
            {visibleProducts.map((product, index) => (
              <article className="seez-product-card" key={product.name}>
                <button className={`seez-product-image tone-${product.tone}`} type="button" onClick={() => openOrder(product)} aria-label={`${product.name} অর্ডার করুন`}>
                  <img
                    src={`https://images.unsplash.com/${product.image}?auto=format&fit=crop&w=800&q=80`}
                    alt={`${product.name} সুগন্ধি`}
                    loading="lazy"
                  />
                  <span className="seez-product-tag">{product.tag}</span>
                  <span className="seez-product-number">0{index + 1}</span>
                  <span className="seez-product-image-cta">বিস্তারিত <ArrowRight size={14} /></span>
                </button>
                <div className="seez-product-info">
                  <div>
                    <p className="seez-product-category">{product.category} · SEEZ COLLECTION</p>
                    <h3>{product.name}</h3>
                    <p className="seez-product-subtitle">{product.subtitle}</p>
                  </div>
                  <span className="seez-product-price">৳{product.price.toLocaleString('en-IN')}</span>
                </div>
                <button className="seez-product-order" type="button" onClick={() => openOrder(product)}>
                  অর্ডার করুন <ArrowRight size={15} aria-hidden="true" />
                </button>
              </article>
            ))}
          </div>
          <p className="seez-price-note">
            পণ্যের নাম ও দাম নমুনা—আপনার আসল তালিকা দিয়ে বদলান। দাম জানতে WhatsApp সাপোর্টে যোগাযোগ করুন।
          </p>
        </section>

        <section className="seez-story" id="story">
          <div className="seez-story-photo">
            <img
              src="https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=1000&q=85"
              alt="সুগন্ধি ও যত্নের পণ্যের সাজানো সংগ্রহ"
              loading="lazy"
            />
            <span>SCENT IS A<br />WAY TO REMEMBER.</span>
          </div>
          <div className="seez-story-copy">
            <p className="seez-eyebrow"><span /> A LITTLE ABOUT US</p>
            <h2>একটি সুবাস।<br /><em>একটি অনুভূতি।</em></h2>
            <p>
              Seez-এ আমরা বিশ্বাস করি, আপনার সুবাস আপনারই মতো আলাদা।
              প্রতিটি কালেকশন তৈরি আপনার প্রতিদিনের মুহূর্তে একটু সৌন্দর্য
              আর নিজের মতো থাকার আনন্দ যোগ করতে।
            </p>
            <a className="seez-text-link" href={supportLink()} target="_blank" rel="noreferrer">
              WhatsApp-এ সাপোর্ট নিন <ArrowRight size={16} />
            </a>
          </div>
        </section>

        <section className="seez-contact" id="contact">
          <div className="seez-contact-orbit seez-orbit-one" />
          <div className="seez-contact-orbit seez-orbit-two" />
          <p className="seez-eyebrow"><span /> LET'S FIND YOUR SCENT</p>
          <h2>আপনার সুবাস<br /><em>খুঁজে নিতে প্রস্তুত?</em></h2>
          <p>পণ্য, দাম বা অর্ডার—যেকোনো বিষয়ে আমাদের WhatsApp-এ লিখুন।</p>
          <a className="seez-button seez-button-light" href={supportLink()} target="_blank" rel="noreferrer">
            <MessageCircle size={17} /> WhatsApp সাপোর্ট <ArrowRight size={16} />
          </a>
          <span className="seez-contact-number">+880 1892-753543</span>
        </section>
      </main>

      <footer className="seez-footer">
        <a className="seez-logo" href="#home">
          <span className="seez-logo-word">seez<span>.</span></span>
          <small>PERFUME</small>
        </a>
        <span>সুগন্ধে আপনার স্বাক্ষর।</span>
        <a href={supportLink()} target="_blank" rel="noreferrer">WhatsApp সাপোর্ট <ArrowRight size={14} /></a>
        <small>© {new Date().getFullYear()} SEEZ. ALL RIGHTS RESERVED.</small>
      </footer>

      {orderSuccess && (
        <div className="seez-order-success" role="status">
          অর্ডার জমা হয়েছে। আমরা অর্ডারটি দেখে আপনার সঙ্গে যোগাযোগ করব।
          <button type="button" aria-label="বার্তা বন্ধ করুন" onClick={() => setOrderSuccess(false)}><X size={16} /></button>
        </div>
      )}

      {orderOpen && (
        <div
          className="seez-order-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOrderOpen(false)
          }}
        >
          <section className="seez-order-dialog" role="dialog" aria-modal="true" aria-labelledby="seez-order-title">
            <button className="seez-order-close" type="button" aria-label="ফর্ম বন্ধ করুন" onClick={() => setOrderOpen(false)}>
              <X size={20} />
            </button>
            <p className="seez-eyebrow"><span /> DIRECT ORDER</p>
            <h2 id="seez-order-title">আপনার অর্ডার <em>তৈরি করুন</em></h2>
            <p className="seez-order-intro">
              {selectedProduct ? `${selectedProduct.name} বেছে নিয়েছেন।` : 'আপনার পছন্দের Seez perfume-এর তথ্য দিন।'}
              {' '}তথ্য জমা দিলে অর্ডার সরাসরি সংরক্ষিত হবে। প্রয়োজনে WhatsApp সাপোর্টে যোগাযোগ করুন।
            </p>
            <form
              className="seez-order-form"
              onSubmit={async (event) => {
                event.preventDefault()
                const formData = new FormData(event.currentTarget)
                const customerName = String(formData.get('customerName')).trim()
                const customerPhone = String(formData.get('customerPhone')).trim()
                const address = String(formData.get('address')).trim()
                const volume = String(formData.get('volume')).trim()
                setOrderBusy(true)
                setOrderError('')
                try {
                  const response = await fetch('/api/seez/orders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      customerName,
                      customerPhone,
                      address,
                      perfume: selectedProduct?.name || 'Seez perfume',
                      volumeMl: Number(volume),
                    }),
                  })
                  if (!response.ok) {
                    const result = await response.json() as { error?: { message?: string } }
                    throw new Error(result.error?.message || 'অর্ডার জমা হয়নি। আবার চেষ্টা করুন।')
                  }
                  setOrderOpen(false)
                  setOrderSuccess(true)
                } catch (error) {
                  setOrderError(error instanceof Error ? error.message : 'অর্ডার জমা হয়নি। আবার চেষ্টা করুন।')
                } finally {
                  setOrderBusy(false)
                }
              }}
            >
              <label>
                আপনার নাম
                <input name="customerName" autoComplete="name" placeholder="নাম লিখুন" required />
              </label>
              <label>
                ফোন নম্বর
                <input name="customerPhone" type="tel" autoComplete="tel" placeholder="যে নম্বরে যোগাযোগ করা যাবে" required />
              </label>
              <label>
                ডেলিভারির ঠিকানা
                <textarea name="address" autoComplete="street-address" rows={3} placeholder="বাসা/রোড, এলাকা, শহর" required />
              </label>
              <label>
                কত ml চান?
                <div className="seez-volume-input">
                  <input name="volume" type="number" min="1" step="1" placeholder="যেমন 50" required />
                  <span>ml</span>
                </div>
              </label>
              {orderError && <p className="seez-order-error" role="alert">{orderError}</p>}
              <button className="seez-submit-order" type="submit" disabled={orderBusy}>
                {orderBusy ? 'অর্ডার জমা হচ্ছে…' : <>সরাসরি অর্ডার দিন <ArrowRight size={16} /></>}
              </button>
              <span className="seez-order-number">সাপোর্ট: WhatsApp +880 1892-753543</span>
            </form>
          </section>
        </div>
      )}

      <a className="seez-whatsapp-float" href={supportLink()} target="_blank" rel="noreferrer" aria-label="WhatsApp সাপোর্টে যোগাযোগ করুন">
        <MessageCircle size={21} />
      </a>
    </div>
  )
}
