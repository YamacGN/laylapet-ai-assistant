const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

console.log('🚀 Server starting...');

// Son önerileri takip et (çeşitlilik için)
const recentRecommendations = new Map();

// Ürün cache (performans için)
let productCache = null;
let cacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 dakika

app.post('/api/chat', async (req, res) => {
  try {
    const { message, shopDomain } = req.body;
    
    console.log('📨 Message:', message);
    console.log('🏪 Shop:', shopDomain);
    
    if (!message || !shopDomain) {
      return res.status(400).json({
        reply: 'Mesaj veya shop domain eksik',
        products: []
      });
    }
    
    // Query oluştur
    const searchTerms = buildSearchTerms(message);
    console.log('🔍 Search terms:', searchTerms);
    
    // 1. Shopify Admin API - TÜM ÜRÜNLERİ ÇEK (Cache veya Pagination ile)
    let allProducts;
    
    if (productCache && cacheTime && (Date.now() - cacheTime < CACHE_DURATION)) {
      console.log('⚡ Cache kullanılıyor (son güncelleme: ' + Math.floor((Date.now() - cacheTime) / 1000) + ' saniye önce)');
      allProducts = productCache;
    } else {
      console.log('🔄 Tüm ürünler Shopify\'dan çekiliyor...');
      
      let allShopifyProducts = [];
      let nextPageUrl = `https://${shopDomain}/admin/api/2024-01/products.json?limit=250&status=active`;
      let pageCount = 0;
      const maxPages = 20; // Max 5000 ürün (250 x 20)
      
      while (nextPageUrl && pageCount < maxPages) {
        pageCount++;
        console.log(`📄 Sayfa ${pageCount}/${maxPages} çekiliyor...`);
        
        const shopifyRes = await fetch(nextPageUrl, {
          method: 'GET',
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
            'Content-Type': 'application/json'
          }
        });

        const shopifyData = await shopifyRes.json();
        
        console.log(`📦 Shopify status: ${shopifyRes.status}`);
        
        if (shopifyData.errors) {
          console.error('❌ Shopify errors:', shopifyData.errors);
          throw new Error('Shopify hatası: ' + JSON.stringify(shopifyData.errors));
        }
        
        if (!shopifyData.products || shopifyData.products.length === 0) {
          console.log('ℹ️ Daha fazla ürün yok');
          break;
        }

        allShopifyProducts = allShopifyProducts.concat(shopifyData.products);
        console.log(`✓ ${shopifyData.products.length} ürün eklendi (toplam: ${allShopifyProducts.length})`);
        
        // Pagination: Link header'dan sonraki sayfayı al
        const linkHeader = shopifyRes.headers.get('Link');
        nextPageUrl = null;
        
        if (linkHeader) {
          const links = linkHeader.split(',');
          const nextLink = links.find(link => link.includes('rel="next"'));
          
          if (nextLink) {
            const match = nextLink.match(/<([^>]+)>/);
            if (match) {
              nextPageUrl = match[1];
              console.log('➡️ Sonraki sayfa bulundu');
            }
          }
        }
        
        // Rate limiting: Shopify API limit (2 req/sec)
        if (nextPageUrl) {
          await new Promise(resolve => setTimeout(resolve, 550)); // 550ms bekle
        }
      }
      
      console.log(`🎉 Toplam ${allShopifyProducts.length} ürün çekildi (${pageCount} sayfa)`);

      // Admin API formatından normalize et
      allProducts = allShopifyProducts
        .filter(p => p.status === 'active')
        .map(p => {
          // HTML tag'lerini temizle ve TAM AÇIKLAMAYI al
          const fullDesc = p.body_html 
            ? p.body_html
                .replace(/<[^>]*>/g, '') // HTML tag'leri sil
                .replace(/&nbsp;/g, ' ') // &nbsp; → boşluk
                .replace(/&amp;/g, '&')  // &amp; → &
                .replace(/&quot;/g, '"') // &quot; → "
                .replace(/&#39;/g, "'")  // &#39; → '
                .replace(/&lt;/g, '<')   // &lt; → <
                .replace(/&gt;/g, '>')   // &gt; → >
                .replace(/\s+/g, ' ')    // Çoklu boşlukları tek yap
                .trim()
            : '';
          
          return {
            id: p.id.toString(),
            title: p.title,
            handle: p.handle,
            vendor: p.vendor || '',
            productType: p.product_type || '',
            tags: p.tags ? (typeof p.tags === 'string' ? p.tags.split(', ') : p.tags) : [],
            priceRange: {
              minVariantPrice: {
                amount: p.variants && p.variants[0] ? p.variants[0].price : '0',
                currencyCode: 'TRY'
              }
            },
            description: fullDesc, // TAM AÇIKLAMA (filtreleme için)
            descriptionShort: fullDesc.substring(0, 150), // Kısa özet (AI için)
            availableForSale: p.variants && p.variants.some(v => 
              (v.inventory_quantity || 0) > 0 || v.inventory_policy === 'continue'
            ),
            featuredImage: {
              url: p.image?.src || (p.images && p.images[0] ? p.images[0].src : '')
            }
          };
        });

      // Cache'e kaydet
      productCache = allProducts;
      cacheTime = Date.now();
      
      console.log(`📊 Toplam ${allProducts.length} aktif ürün`);

      // Mevcut markaları logla
      const uniqueVendors = [...new Set(allProducts.map(p => p.vendor).filter(v => v))];
      console.log(`🏷️ Mevcut markalar (${uniqueVendors.length}):`, uniqueVendors.slice(0, 15).join(', ') + '...');
      
      // Vendor boş olanları logla
      const emptyVendorCount = allProducts.filter(p => !p.vendor).length;
      if (emptyVendorCount > 0) {
        console.log(`⚠️ ${emptyVendorCount} ürünün vendor alanı boş`);
      }
    }

    // Akıllı filtreleme
    const filteredProducts = smartFilter(allProducts, searchTerms, message);

    console.log(`✅ ${filteredProducts.length} ürün filtrelendi`);

    if (filteredProducts.length === 0) {
      return res.json({
        reply: 'Bu kriterlere uygun ürün bulamadım 😔\n\nBaşka bir şey deneyebilir misin?\n\n💡 Öneriler:\n• "Kedi maması"\n• "Tavuksuz kedi maması"\n• "Tahılsız köpek maması"\n• "Az balık içerikli mama"',
        products: []
      });
    }

    // Maksimum 12 ürünü AI'ya gönder (çeşitlilik için)
    const productsForAI = filteredProducts.slice(0, 12);

    // 2. OpenAI'ya gönder
    const systemPrompt = generateSystemPrompt(productsForAI, shopDomain, searchTerms);
    
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4-turbo-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        temperature: 0.8,
        max_tokens: 500
      })
    });

    const aiData = await aiRes.json();
    
    console.log('🤖 OpenAI status:', aiRes.status);
    
    if (aiData.error) {
      console.error('❌ OpenAI error:', aiData.error);
      throw new Error('OpenAI hatası: ' + aiData.error.message);
    }
    
    if (!aiData.choices || !aiData.choices[0]) {
      console.error('❌ No choices:', aiData);
      throw new Error('OpenAI yanıt vermedi');
    }

    const reply = aiData.choices[0].message.content;
    
    // Session ID
    const sessionId = req.headers['x-session-id'] || shopDomain;
    
    const recommended = extractProducts(reply, productsForAI, sessionId);

    console.log('✅ Başarılı!');

    res.json({
      reply,
      products: recommended
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      error: error.message,
      reply: 'Bir hata oluştu: ' + error.message
    });
  }
});

// Cache temizleme endpoint (manuel)
app.post('/api/clear-cache', (req, res) => {
  productCache = null;
  cacheTime = null;
  console.log('🗑️ Cache temizlendi');
  res.json({ success: true, message: 'Cache temizlendi' });
});

// Vendor listesi (debug)
app.get('/api/vendors', (req, res) => {
  if (!productCache || productCache.length === 0) {
    return res.json({ 
      error: 'Cache boş, önce bir arama yapın',
      vendors: []
    });
  }

  const vendorList = productCache
    .map(p => ({
      vendor: p.vendor || '(BOŞ)',
      title: p.title.substring(0, 60)
    }))
    .slice(0, 100); // İlk 100 ürün

  const uniqueVendors = [...new Set(productCache.map(p => p.vendor || '(BOŞ)'))].sort();
  
  const emptyVendorProducts = productCache
    .filter(p => !p.vendor)
    .slice(0, 20)
    .map(p => p.title.substring(0, 60));

  res.json({
    totalProducts: productCache.length,
    uniqueVendors: uniqueVendors,
    vendorCount: uniqueVendors.length,
    emptyVendorCount: productCache.filter(p => !p.vendor).length,
    sampleProducts: vendorList,
    emptyVendorSamples: emptyVendorProducts
  });
});

app.get('/', (req, res) => {
  const cacheAge = cacheTime ? Math.floor((Date.now() - cacheTime) / 1000) : null;
  const cacheStatus = cacheAge ? `${cacheAge}s önce güncellendi` : 'Hen��z yüklenmedi';
  
  res.send(`
    <html>
      <body style="font-family: Arial; padding: 40px; text-align: center;">
        <h1>🐾 Laylapet AI Assistant</h1>
        <p><strong>Server çalışıyor!</strong> ✅</p>
        <p>API: <code>POST /api/chat</code></p>
        <hr style="margin: 30px 0;">
        <p style="color: #666;">
          <strong>Environment:</strong><br>
          OPENAI_KEY: ${process.env.OPENAI_KEY ? '✅ Set' : '❌ Missing'}<br>
          SHOPIFY_TOKEN: ${process.env.SHOPIFY_TOKEN ? '✅ Set (Admin API)' : '❌ Missing'}
        </p>
        <p style="color: #666;">
          <strong>Cache:</strong><br>
          Ürünler: ${productCache ? productCache.length : 0}<br>
          Durum: ${cacheStatus}<br>
          Geçerlilik: ${CACHE_DURATION / 60000} dakika
        </p>
        <p style="font-size: 12px; color: #999;">
          v5.0 - Dynamic Negative Filter + Full Description + Title Search
        </p>
        <p>
          <a href="/api/vendors" style="color: #4CAF50;">Vendor Listesi</a>
        </p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    api: 'Admin API',
    version: '5.0',
    features: [
      'pagination', 
      'cache', 
      'dynamic-negative-filter',
      'full-description',
      'title-brand-search', 
      'vendor-search'
    ],
    cache: {
      products: productCache ? productCache.length : 0,
      ageSeconds: cacheTime ? Math.floor((Date.now() - cacheTime) / 1000) : null,
      validFor: CACHE_DURATION / 1000
    },
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Using Shopify Admin API with Pagination`);
  console.log(`💾 Cache enabled (${CACHE_DURATION / 60000} minutes)`);
  console.log(`🚫 Dynamic negative filtering enabled`);
  console.log(`📝 Full product descriptions enabled`);
  console.log(`🏷️ Title + Vendor based brand search enabled`);
});

// ========== YARDIMCI FONKSİYONLAR ==========

function buildSearchTerms(message) {
  const msg = message.toLowerCase();
  const terms = {
    animal: null,
    category: null,
    special: [],
    brandKeywords: [],
    freeText: [],
    exclude: [] // Hariç tutulacak HERHANGI BİR içerik
  };

  // Hayvan türü
  if (msg.includes('kedi')) {
    terms.animal = 'kedi';
  } else if (msg.includes('köpek') || msg.includes('kopek')) {
    terms.animal = 'köpek';
  } else if (msg.includes('kuş') || msg.includes('kus')) {
    terms.animal = 'kuş';
  } else if (msg.includes('balık') || msg.includes('balik')) {
    terms.animal = 'balık';
  }

  // Kategoriler
  if (msg.includes('mama')) {
    terms.category = 'mama';
  } else if (msg.includes('ödül') || msg.includes('odul') || msg.includes('treat')) {
    terms.category = 'ödül';
  } else if (msg.includes('oyuncak')) {
    terms.category = 'oyuncak';
  } else if (msg.includes('krem') || msg.includes('şampuan') || msg.includes('sampuan')) {
    terms.category = 'bakım';
    if (msg.includes('krem')) terms.freeText.push('krem', 'cream');
    if (msg.includes('şampuan') || msg.includes('sampuan')) terms.freeText.push('şampuan', 'shampoo');
  } else if (msg.includes('tasma') || msg.includes('gezdirme')) {
    terms.category = 'aksesuar';
    terms.freeText.push('tasma', 'gezdirme', 'leash', 'collar');
  } else if (msg.includes('kum') || msg.includes('tuvalet')) {
    terms.category = 'hijyen';
    terms.freeText.push('kum', 'litter', 'tuvalet');
  } else if (msg.includes('tırnak') || msg.includes('tirnak')) {
    terms.freeText.push('tırnak', 'nail', 'clipper', 'makas');
  } else if (msg.includes('diş') || msg.includes('dis')) {
    terms.freeText.push('diş', 'dental', 'tooth');
  } else if (msg.includes('kulak')) {
    terms.freeText.push('kulak', 'ear');
  } else if (msg.includes('taşıma') || msg.includes('tasima') || msg.includes('çanta')) {
    terms.freeText.push('taşıma', 'carrier', 'çanta');
  }

  // ========== DİNAMİK NEGATİF ALGILAMA ==========
  
  // NEGATİF KELİMELER
  const negativeWords = ['yok', 'olmadan', 'içermesin', 'icermesin', 'hariç', 'haric', 'istemiyorum', 'istemem', 'değil', 'degil'];
  
  // 1. "-sız/-siz/-suz/-süz" ekleri: "tavuksuz", "tahılsız"
  const suffixPattern = /([\wğüşıöçĞÜŞİÖÇ]{3,})(sız|siz|suz|süz)/gi;
  let match;
  
  while ((match = suffixPattern.exec(msg)) !== null) {
    const ingredient = match[1].toLowerCase();
    if (ingredient.length > 2) {
      terms.exclude.push(ingredient);
      const translations = getTranslations(ingredient);
      terms.exclude.push(...translations);
    }
  }
  
  // 2. NEGATİF CÜMLE: "tavuk içermesin", "patates yok"
  const negativeRegex = new RegExp(
    `([\\wğüşıöçĞÜŞİÖÇ]{3,})\\s*(${negativeWords.join('|')})`,
    'gi'
  );
  
  while ((match = negativeRegex.exec(msg)) !== null) {
    const ingredient = match[1].toLowerCase();
    const stopWords = ['bir', 'bu', 'şu', 'ne', 'var', 'mi', 'mı', 'için', 'ürün', 'urun'];
    
    if (ingredient.length > 2 && !stopWords.includes(ingredient)) {
      terms.exclude.push(ingredient);
      const translations = getTranslations(ingredient);
      terms.exclude.push(...translations);
    }
  }
  
  // 3. "X-FREE": "grain-free", "gluten-free"
  if (msg.includes('grain-free') || msg.includes('grain free') || msg.includes('tahılsız')) {
    terms.exclude.push('tahıl', 'grain', 'buğday', 'wheat', 'mısır', 'corn', 'arpa', 'barley');
  }
  if (msg.includes('gluten-free') || msg.includes('gluten free') || msg.includes('glutensiz')) {
    terms.exclude.push('gluten', 'glüten', 'buğday', 'wheat');
  }
  if (msg.includes('dairy-free') || msg.includes('dairy free')) {
    terms.exclude.push('süt', 'dairy', 'milk', 'peynir', 'cheese', 'yoğurt', 'yogurt');
  }
  
  // 4. "AZ X": "az tavuk", "düşük tavuk"
  const lowContentRegex = /(az|düşük|dusuk|low|minimum)\s+([\\wğüşıöçĞÜŞİÖÇ]{3,})/gi;
  while ((match = lowContentRegex.exec(msg)) !== null) {
    const ingredient = match[2].toLowerCase();
    if (ingredient.length > 2 && ingredient !== 'içerik' && ingredient !== 'icerik') {
      terms.exclude.push(ingredient);
      const translations = getTranslations(ingredient);
      terms.exclude.push(...translations);
    }
  }
  
  // Tekrarları temizle
  terms.exclude = [...new Set(terms.exclude)];
  
  // Log
  if (terms.exclude.length > 0) {
    console.log(`🚫 Hariç tutulanlar: ${terms.exclude.join(', ')}`);
  }

  // MARKA TESPİTİ
  const stopWords = [
    'var', 'mi', 'mı', 'için', 'lazim', 'lazım', 'ne', 'nedir', 
    'varmı', 'var mi', 'bir', 'bu', 'şu', 'o', 've', 'ile',
    'çok', 'az', 'iyi', 'güzel', 'ucuz', 'pahalı', 'mnama'
  ];
  
  const categoryWords = [
    'kedi', 'köpek', 'kopek', 'mama', 'ödül', 'odul', 'oyuncak', 
    'yaş', 'yas', 'kuş', 'kus', 'treat', 'food', 'kuru'
  ];
  
  const words = msg.split(' ').filter(w => 
    w.length > 2 && 
    !stopWords.includes(w) && 
    !categoryWords.includes(w) &&
    !negativeWords.includes(w)
  );
  
  terms.brandKeywords = words.filter(w => !terms.exclude.includes(w));

  // Yaş aralığı
  const ageMatch = msg.match(/(\d+)\s*(yaş|yas|yaşında|yasinda|aylık|aylik)/);
  if (ageMatch) {
    const age = parseInt(ageMatch[1]);
    
    if (age < 1 || msg.includes('aylık') || msg.includes('aylik')) {
      terms.special.push('yavru', 'kitten', 'puppy', 'junior');
    } else if (age >= 7) {
      terms.special.push('yaşlı', 'senior', '7+', 'mature');
    } else {
      terms.special.push('yetişkin', 'adult');
    }
  }

  // Özel durumlar
  if (msg.includes('kısır') || msg.includes('kisir') || msg.includes('steril') || msg.includes('neutered')) {
    terms.special.push('kısır', 'sterilised', 'neutered', 'steril');
  }
  
  if (msg.includes('yavru') || msg.includes('puppy') || msg.includes('kitten')) {
    terms.special.push('yavru', 'puppy', 'kitten', 'junior');
  }
  
  if (msg.includes('tahılsız') || msg.includes('tahilsiz') || msg.includes('grain free')) {
    terms.special.push('tahılsız', 'grain free', 'grainfree');
    // Tahılsız = tahıl içermesin
    if (!terms.exclude.includes('tahıl')) {
      terms.exclude.push('tahıl', 'grain', 'buğday', 'wheat', 'mısır', 'corn');
    }
  }
  
  // YAŞLI vs YAŞ MAMA
  if (msg.includes('yaşlı') || msg.includes('yasli') || msg.includes('senior')) {
    terms.special.push('yaşlı', 'senior', '7+', 'mature', 'elderly');
  } else if (msg.includes('yaş mama') || msg.includes('yas mama') || msg.includes('wet') || msg.includes('pouch')) {
    terms.special.push('yaş', 'wet', 'pouch', 'konserve');
  }
  
  if (msg.includes('kuru') || msg.includes('dry') || msg.includes('kibble')) {
    terms.special.push('dry', 'kibble');
  }
  
  if (msg.includes('hassas') || msg.includes('sensitive')) {
    terms.special.push('hassas', 'sensitive');
  }
  
  if (msg.includes('yetişkin') || msg.includes('adult')) {
    terms.special.push('yetişkin', 'adult');
  }

  // Sağlık
  if (msg.includes('böbrek') || msg.includes('bobrek') || msg.includes('renal')) {
    terms.special.push('böbrek', 'renal', 'kidney');
  }
  if (msg.includes('idrar') || msg.includes('urinary')) {
    terms.special.push('idrar', 'urinary');
  }
  if (msg.includes('kilo') || msg.includes('obez') || msg.includes('light')) {
    terms.special.push('light', 'kilo', 'weight', 'obez');
  }
  if (msg.includes('deri') || msg.includes('skin') || msg.includes('tüy') || msg.includes('tuy')) {
    terms.special.push('deri', 'skin', 'coat', 'tüy');
  }

  return terms;
}

// İçerik çevirileri
function getTranslations(ingredient) {
  const translations = {
    // Et türleri
    'tavuk': ['chicken', 'tavuklu', 'poultry'],
    'chicken': ['tavuk', 'tavuklu'],
    'balık': ['fish', 'balıklı', 'salmon', 'somon', 'tuna', 'ton'],
    'fish': ['balık', 'balıklı'],
    'sığır': ['beef', 'dana', 'sığırlı'],
    'beef': ['sığır', 'dana'],
    'kuzu': ['lamb', 'kuzulu'],
    'lamb': ['kuzu', 'kuzulu'],
    'hindi': ['turkey', 'hindili'],
    'turkey': ['hindi', 'hindili'],
    'ördek': ['duck', 'ördekli'],
    'domuz': ['pork', 'domuzlu'],
    
    // Tahıl ve karbonhidratlar
    'tahıl': ['grain', 'tahıllı', 'cereal'],
    'grain': ['tahıl', 'tahıllı'],
    'buğday': ['wheat', 'buğdaylı'],
    'wheat': ['buğday', 'buğdaylı'],
    'mısır': ['corn', 'mısırlı', 'maize'],
    'corn': ['mısır', 'mısırlı'],
    'pirinç': ['rice', 'pirinçli'],
    'rice': ['pirinç', 'pirinçli'],
    'patates': ['potato', 'patatesli'],
    'potato': ['patates', 'patatesli'],
    'soya': ['soy', 'soyalı', 'soybean'],
    'soy': ['soya', 'soyalı'],
    'arpa': ['barley', 'arpalı'],
    'yulaf': ['oat', 'yulaflı'],
    
    // Süt ürünleri
    'süt': ['milk', 'dairy', 'sütlü'],
    'milk': ['süt', 'sütlü'],
    'dairy': ['süt', 'süt ürünü'],
    'peynir': ['cheese', 'peynirli'],
    'yoğurt': ['yogurt', 'yoğurtlu'],
    
    // Diğer
    'gluten': ['glüten'],
    'glüten': ['gluten'],
    'yumurta': ['egg', 'yumurtalı'],
    'egg': ['yumurta', 'yumurtalı']
  };
  
  return translations[ingredient.toLowerCase()] || [];
}

function smartFilter(products, searchTerms, originalMessage) {
  const msg = originalMessage.toLowerCase();
  
  const filtered = products.filter(p => {
    let score = 0;
    const titleLower = p.title.toLowerCase();
    const descLower = p.description.toLowerCase(); // TAM AÇIKLAMA!
    const vendorLower = p.vendor.toLowerCase();
    const allTags = p.tags.map(t => t.toLowerCase()).join(' ');
    const productTypeLower = p.productType.toLowerCase();
    const combined = titleLower + ' ' + allTags + ' ' + productTypeLower + ' ' + descLower;

    // 0. NEGATİF FİLTRELEME - EN ÖNCELİKLİ!
    if (searchTerms.exclude.length > 0) {
      let excludeMatches = 0;
      let foundExcludes = [];
      
      searchTerms.exclude.forEach(excludeWord => {
        if (combined.includes(excludeWord)) {
          excludeMatches++;
          foundExcludes.push(excludeWord);
        }
      });
      
      if (excludeMatches > 0) {
        score -= 100; // Yüksek ceza
        console.log(`⛔ "${p.title.substring(0, 40)}" - İçeriyor: ${foundExcludes.join(', ')}`);
      }
    }

    // 1. MARKA KONTROLÜ (VENDOR + TITLE)
    if (searchTerms.brandKeywords.length > 0) {
      searchTerms.brandKeywords.forEach(keyword => {
        if (vendorLower && vendorLower === keyword) {
          score += 50;
        } else if (vendorLower && (vendorLower.includes(keyword) || keyword.includes(vendorLower))) {
          score += 45;
        } else if (titleLower.includes(keyword)) {
          score += 48;
        } else if (allTags.includes(keyword)) {
          score += 15;
        } else if (descLower.includes(keyword)) {
          score += 10;
        }
      });
    }

    // 2. Hayvan türü
    if (searchTerms.animal) {
      const animalMatch = 
        productTypeLower.includes(searchTerms.animal) ||
        allTags.includes(searchTerms.animal) ||
        titleLower.includes(searchTerms.animal);
      
      if (animalMatch) {
        score += 20;
      } else {
        score -= 5;
      }
    }

    // 3. Kategori
    if (searchTerms.category) {
      const catMatch = 
        allTags.includes(searchTerms.category) ||
        titleLower.includes(searchTerms.category) ||
        productTypeLower.includes(searchTerms.category);
      
      if (catMatch) score += 15;
    }

    // 4. Serbest metin
    if (searchTerms.freeText.length > 0) {
      let freeTextMatches = 0;
      searchTerms.freeText.forEach(keyword => {
        if (combined.includes(keyword)) {
          freeTextMatches++;
        }
      });
      
      if (freeTextMatches > 0) {
        score += freeTextMatches * 15;
      }
    }

    // 5. Özel durumlar
    if (searchTerms.special.length > 0) {
      let specialMatches = 0;
      searchTerms.special.forEach(keyword => {
        if (combined.includes(keyword)) {
          specialMatches++;
        }
      });
      
      if (specialMatches > 0) {
        score += specialMatches * 10;
      }
    }

    // 6. Stokta olmalı
    if (p.availableForSale) {
      score += 3;
    }

    return score > 0; // Sadece pozitif skorlu ürünler
  })
  .sort((a, b) => {
    const scoreA = calculateScore(a, searchTerms, originalMessage);
    const scoreB = calculateScore(b, searchTerms, originalMessage);
    return scoreB - scoreA;
  });

  // Debug logging
  console.log(`🎯 İlk 5 ürün skorları:`);
  filtered.slice(0, 5).forEach((p, i) => {
    const score = calculateScore(p, searchTerms, originalMessage);
    console.log(`  ${i + 1}. ${p.title.substring(0, 50)} - Skor: ${score} - Vendor: ${p.vendor || '(BOŞ)'}`);
  });

  return filtered;
}

function calculateScore(product, searchTerms, originalMessage) {
  let score = 0;
  const titleLower = product.title.toLowerCase();
  const vendorLower = product.vendor.toLowerCase();
  const descLower = product.description.toLowerCase();
  const allTags = product.tags.map(t => t.toLowerCase()).join(' ');
  const productTypeLower = product.productType.toLowerCase();
  const combined = titleLower + ' ' + allTags + ' ' + productTypeLower + ' ' + descLower;

  // 0. NEGATİF FİLTRELEME
  if (searchTerms.exclude.length > 0) {
    searchTerms.exclude.forEach(excludeWord => {
      if (combined.includes(excludeWord)) {
        score -= 100;
      }
    });
  }

  // 1. Vendor + Title
  searchTerms.brandKeywords.forEach(keyword => {
    if (vendorLower && vendorLower === keyword) {
      score += 50;
    } else if (vendorLower && (vendorLower.includes(keyword) || keyword.includes(vendorLower))) {
      score += 45;
    } else if (titleLower.includes(keyword)) {
      score += 48;
    }
  });

  // 2. Hayvan
  if (searchTerms.animal && combined.includes(searchTerms.animal)) {
    score += 20;
  }

  // 3. Kategori
  if (searchTerms.category && combined.includes(searchTerms.category)) {
    score += 15;
  }

  // 4. Serbest metin
  searchTerms.freeText.forEach(keyword => {
    if (combined.includes(keyword)) {
      score += 15;
    }
  });

  // 5. Özel
  searchTerms.special.forEach(keyword => {
    if (combined.includes(keyword)) {
      score += 10;
    }
  });
  
  return score;
}

function generateSystemPrompt(products, domain, searchTerms) {
  // Hariç tutulan içerikleri AI'ya bildir
  const excludeWarning = searchTerms.exclude.length > 0 
    ? `\n⚠️ KULLANICI ŞU İÇERİKLERİ İSTEMİYOR: ${searchTerms.exclude.join(', ')}\nBu içerikleri içeren ürünleri ASLA önerme!\n`
    : '';

  return `Sen Laylapet'in AI danışmanısın! 🐾 Türkçe konuş, profesyonel ama samimi ol.
${excludeWarning}
MEVCUT ÜRÜNLER (${products.length} adet - ÇEŞİTLİ FİYAT VE MARKA SEÇENEKLERDEN):
${products.map((p, i) => `
${i + 1}. **${p.title}**
   🏷️ Marka: ${p.vendor || 'Belirtilmemiş'}
   💰 ${parseFloat(p.priceRange.minVariantPrice.amount).toFixed(2)} TL
   📦 ${p.productType}
   📝 ${p.descriptionShort}${p.description.length > 150 ? '...' : ''}
   🔗 https://${domain}/products/${p.handle}
`).join('\n')}

KURALLAR:
1. Maksimum 3 ürün öner
2. Ürün açıklamalarını dikkate al (içerik, yüzde oranları)
3. ${excludeWarning ? '⚠️ HARİÇ TUTULAN İÇERİKLERİ ASLA ÖNERME!' : ''}
4. Kullanıcı "X içermesin/yok/olmadan" dediyse, o içeriği içeren ürünleri ASLA önerme
5. Marka bilgilerini vurgula
6. ÇEŞİTLİLİK SAĞLA: Farklı fiyat ve içerik seçenekleri sun
7. Her ürün için kısa açıklama yap (neden uygun, içeriği ne)
8. Fiyatları belirt ve karşılaştır
9. Link ver: [Ürün Adı](URL)
10. Emoji kullan (🐱 🐶 ⭐ 💝 ✅)
11. Maksimum 200 kelime

ÖNEMLİ: 
- Sadece yukarıdaki ürünlerden öner!
- Kullanıcının istediği içeriklere sahip ürünleri öner!
- İçerik bilgilerini açıklamadan oku ve belirt!`;
}

function extractProducts(reply, allProducts, sessionId = 'default') {
  const recommended = [];
  
  const recent = recentRecommendations.get(sessionId) || [];
  
  allProducts.forEach(p => {
    const titleMatch = reply.includes(p.title);
    const handleMatch = reply.includes(p.handle);
    
    if ((titleMatch || handleMatch) && 
        recommended.length < 3 && 
        !recent.includes(p.id)) {
      recommended.push({
        title: p.title,
        handle: p.handle,
        price: parseFloat(p.priceRange.minVariantPrice.amount).toFixed(2),
        currency: p.priceRange.minVariantPrice.currencyCode,
        image: p.featuredImage?.url || '',
        vendor: p.vendor || ''
      });
    }
  });
  
  if (recommended.length < 3) {
    allProducts.forEach(p => {
      const titleMatch = reply.includes(p.title);
      const handleMatch = reply.includes(p.handle);
      
      if ((titleMatch || handleMatch) && recommended.length < 3) {
        const alreadyAdded = recommended.some(r => r.handle === p.handle);
        if (!alreadyAdded) {
          recommended.push({
            title: p.title,
            handle: p.handle,
            price: parseFloat(p.priceRange.minVariantPrice.amount).toFixed(2),
            currency: p.priceRange.minVariantPrice.currencyCode,
            image: p.featuredImage?.url || '',
            vendor: p.vendor || ''
          });
        }
      }
    });
  }
  
  const productIds = recommended.map(r => r.handle);
  const updatedRecent = [...recent, ...productIds].slice(-15);
  recentRecommendations.set(sessionId, updatedRecent);
  
  if (recentRecommendations.size > 1000) {
    const entries = Array.from(recentRecommendations.entries());
    recentRecommendations.clear();
    entries.slice(-500).forEach(([key, value]) => {
      recentRecommendations.set(key, value);
    });
  }
  
  return recommended;
}