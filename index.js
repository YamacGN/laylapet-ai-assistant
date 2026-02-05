const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

console.log('🚀 Server starting...');

// Son önerileri takip et (çeşitlilik için)
const recentRecommendations = new Map();

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
    
    // 1. Shopify Admin API - Ürünleri çek
    const shopifyRes = await fetch(
      `https://${shopDomain}/admin/api/2024-01/products.json?limit=250&status=active`,
      {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    const shopifyData = await shopifyRes.json();
    
    console.log('📦 Shopify status:', shopifyRes.status);
    
    if (shopifyData.errors) {
      console.error('❌ Shopify errors:', shopifyData.errors);
      throw new Error('Shopify hatası: ' + JSON.stringify(shopifyData.errors));
    }
    
    if (!shopifyData.products) {
      console.error('❌ No products:', shopifyData);
      throw new Error('Shopify yanıt vermedi');
    }

    // Admin API formatından normalize et
    const allProducts = shopifyData.products
      .filter(p => p.status === 'active')
      .map(p => ({
        id: p.id.toString(),
        title: p.title,
        handle: p.handle,
        productType: p.product_type || '',
        tags: p.tags ? (typeof p.tags === 'string' ? p.tags.split(', ') : p.tags) : [],
        priceRange: {
          minVariantPrice: {
            amount: p.variants && p.variants[0] ? p.variants[0].price : '0',
            currencyCode: 'TRY'
          }
        },
        description: p.body_html ? p.body_html.replace(/<[^>]*>/g, '').substring(0, 200) : '',
        availableForSale: p.variants && p.variants.some(v => 
          (v.inventory_quantity || 0) > 0 || v.inventory_policy === 'continue'
        ),
        featuredImage: {
          url: p.image?.src || (p.images && p.images[0] ? p.images[0].src : '')
        }
      }));

    console.log(`📊 Toplam ${allProducts.length} aktif ürün`);

    // Akıllı filtreleme
    const filteredProducts = smartFilter(allProducts, searchTerms, message);

    console.log(`✅ ${filteredProducts.length} ürün filtrelendi`);

    if (filteredProducts.length === 0) {
      return res.json({
        reply: 'Bu kriterlere uygun ürün bulamadım 😔\n\nBaşka bir şey deneyebilir misin?\n\n💡 Öneriler:\n• "Kedi maması"\n• "Köpek ödülü"\n• "Kısır kedi için mama"\n• "Royal Canin mama"\n• "Köpek şampuanı"',
        products: []
      });
    }

    // Maksimum 12 ürünü AI'ya gönder (çeşitlilik için)
    const productsForAI = filteredProducts.slice(0, 12);

    // 2. OpenAI'ya gönder
    const systemPrompt = generateSystemPrompt(productsForAI, shopDomain);
    
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
        temperature: 0.8, // Daha fazla çeşitlilik için artırıldı
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
    
    // Session ID (gerçek uygulamada user ID kullanın)
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

app.get('/', (req, res) => {
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
        <p style="font-size: 12px; color: #999;">
          v2.0 - Marka Araması + Çeşitlilik + Gelişmiş Kategoriler
        </p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    api: 'Admin API',
    version: '2.0',
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Using Shopify Admin API`);
  console.log(`🎲 Diversity enabled`);
});

// ========== YARDIMCI FONKSİYONLAR ==========

function buildSearchTerms(message) {
  const msg = message.toLowerCase();
  const terms = {
    animal: null,
    category: null,
    special: [],
    brands: [],
    freeText: []
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

  // Kategoriler (GENİŞLETİLDİ)
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
  } else if (msg.includes('tasma') || msg.includes('gezdirme') || msg.includes('tasma')) {
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

  // Markalar (GENİŞLETİLDİ)
  const brands = [
    'royal canin', 'brit', 'hills', 'purina', 'pedigree', 
    'whiskas', 'friskies', 'proplan', 'pro plan', 'felix', 'sheba',
    'acana', 'orijen', 'taste of the wild', 'carnilove',
    'n&d', 'farmina', 'monge', 'josera', 'bosch',
    'applaws', 'wellness', 'blue buffalo', 'canagan',
    'lily kitchen', 'natures menu', 'almo nature'
  ];
  
  brands.forEach(brand => {
    if (msg.includes(brand)) {
      terms.brands.push(brand);
    }
  });

  // Yaş aralığı tespiti (sayısal)
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
  }
  
  // YAŞLI vs YAŞ MAMA - DİKKAT!
  if (msg.includes('yaşlı') || msg.includes('yasli') || msg.includes('senior') || msg.includes('yaşli')) {
    terms.special.push('yaşlı', 'senior', '7+', 'mature', 'elderly');
  } else if (msg.includes('yaş mama') || msg.includes('yas mama') || msg.includes('wet') || msg.includes('pouch')) {
    terms.special.push('yaş', 'wet', 'pouch', 'konserve');
  }
  
  if (msg.includes('kuru') || msg.includes('dry') || msg.includes('kibble')) {
    terms.special.push('kuru', 'dry', 'kibble');
  }
  
  if (msg.includes('hassas') || msg.includes('sensitive')) {
    terms.special.push('hassas', 'sensitive');
  }
  
  if (msg.includes('yetişkin') || msg.includes('adult')) {
    terms.special.push('yetişkin', 'adult');
  }

  // Sağlık sorunları
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

function smartFilter(products, searchTerms, originalMessage) {
  const msg = originalMessage.toLowerCase();
  
  const filtered = products.filter(p => {
    let score = 0;
    const titleLower = p.title.toLowerCase();
    const descLower = p.description.toLowerCase();
    const allTags = p.tags.map(t => t.toLowerCase()).join(' ');
    const productTypeLower = p.productType.toLowerCase();
    const combined = titleLower + ' ' + allTags + ' ' + productTypeLower + ' ' + descLower;

    // 1. MARKA kontrolü (YÜKSEK ÖNCELİK)
    if (searchTerms.brands.length > 0) {
      let brandMatch = false;
      searchTerms.brands.forEach(brand => {
        if (combined.includes(brand)) {
          score += 30;
          brandMatch = true;
        }
      });
      if (!brandMatch) {
        score -= 10;
      }
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

    // 4. Serbest metin arama
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

    // 6. Genel arama (spesifik kriter yoksa)
    const hasSpecificCriteria = 
      searchTerms.animal || 
      searchTerms.category || 
      searchTerms.special.length > 0 || 
      searchTerms.brands.length > 0 ||
      searchTerms.freeText.length > 0;

    if (!hasSpecificCriteria) {
      const words = msg.split(' ').filter(w => w.length > 2);
      words.forEach(word => {
        if (combined.includes(word)) {
          score += 5;
        }
      });
    }

    // 7. Stokta olmalı
    if (p.availableForSale) {
      score += 3;
    }

    return score > 0;
  })
  .sort((a, b) => {
    const scoreA = calculateScore(a, searchTerms, originalMessage);
    const scoreB = calculateScore(b, searchTerms, originalMessage);
    return scoreB - scoreA;
  });

  // ÇEŞİTLİLİK EKLE
  return diversifyProducts(filtered);
}

function calculateScore(product, searchTerms, originalMessage) {
  let score = 0;
  const titleLower = product.title.toLowerCase();
  const allTags = product.tags.map(t => t.toLowerCase()).join(' ');
  const productTypeLower = product.productType.toLowerCase();
  const combined = titleLower + ' ' + allTags + ' ' + productTypeLower;

  // Marka
  searchTerms.brands.forEach(brand => {
    if (combined.includes(brand)) {
      score += 30;
    }
  });

  // Hayvan
  if (searchTerms.animal && combined.includes(searchTerms.animal)) {
    score += 20;
  }

  // Kategori
  if (searchTerms.category && combined.includes(searchTerms.category)) {
    score += 15;
  }

  // Serbest metin
  searchTerms.freeText.forEach(keyword => {
    if (combined.includes(keyword)) {
      score += 15;
    }
  });

  // Özel
  searchTerms.special.forEach(keyword => {
    if (combined.includes(keyword)) {
      score += 10;
    }
  });

  // Genel kelime eşleşmesi
  const words = originalMessage.toLowerCase().split(' ').filter(w => w.length > 2);
  words.forEach(word => {
    if (combined.includes(word)) {
      score += 3;
    }
  });
  
  return score;
}

function diversifyProducts(products) {
  if (products.length <= 12) return products;

  // Fiyata göre sırala
  const sorted = [...products].sort((a, b) => {
    const priceA = parseFloat(a.priceRange.minVariantPrice.amount);
    const priceB = parseFloat(b.priceRange.minVariantPrice.amount);
    return priceA - priceB;
  });

  // 3 gruba böl: Ucuz, Orta, Pahalı
  const third = Math.floor(sorted.length / 3);
  const cheap = sorted.slice(0, third);
  const mid = sorted.slice(third, third * 2);
  const expensive = sorted.slice(third * 2);

  // Her gruptan rastgele seç
  const diversified = [];
  
  diversified.push(...shuffleArray(cheap).slice(0, 4));
  diversified.push(...shuffleArray(mid).slice(0, 4));
  diversified.push(...shuffleArray(expensive).slice(0, 4));

  // Karıştır ve döndür
  return shuffleArray(diversified);
}

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function generateSystemPrompt(products, domain) {
  return `Sen Laylapet'in AI danışmanısın! 🐾 Türkçe konuş, profesyonel ama samimi ol.

MEVCUT ÜRÜNLER (${products.length} adet - ÇEŞİTLİ FİYAT ARALIKLARINDAN):
${products.map((p, i) => `
${i + 1}. **${p.title}**
   💰 ${parseFloat(p.priceRange.minVariantPrice.amount).toFixed(2)} TL
   📦 ${p.productType}
   🏷️ ${p.tags.slice(0, 3).join(', ')}
   🔗 https://${domain}/products/${p.handle}
`).join('\n')}

KURALLAR:
1. Maksimum 3 ürün öner
2. ÇEŞİTLİLİK SAĞLA: Farklı fiyat aralıklarından seç (ekonomik, orta, premium)
3. Her ürün için kısa açıklama yap (neden uygun?)
4. Fiyatları belirt ve karşılaştır
5. Link ver: [Ürün Adı](URL)
6. Emoji kullan ama abartma (🐱 🐶 ⭐ 💝)
7. Maksimum 200 kelime
8. FARKLI SEÇENEKLER öner - listenin farklı yerlerinden seç!

ÖRNEKLER:
✅ "Bütçene uygun: X (150 TL), Kaliteli seçenek: Y (350 TL), Premium: Z (500 TL)"
✅ "Ekonomik ama kaliteli: A, Orta segment: B, En iyi kalite: C"
❌ "Sadece listedeki ilk 3 ürünü öner"
❌ "Hep en pahalıları öner"

ÖNEMLİ: Sadece yukarıdaki ürünlerden öner! Farklı fiyat noktalarından çeşitlilik sağla!`;
}

function extractProducts(reply, allProducts, sessionId = 'default') {
  const recommended = [];
  
  // Son önerilenleri al
  const recent = recentRecommendations.get(sessionId) || [];
  
  allProducts.forEach(p => {
    const titleMatch = reply.includes(p.title);
    const handleMatch = reply.includes(p.handle);
    
    // Son 5 öneride yoksa ekle (çeşitlilik için)
    if ((titleMatch || handleMatch) && 
        recommended.length < 3 && 
        !recent.includes(p.id)) {
      recommended.push({
        title: p.title,
        handle: p.handle,
        price: parseFloat(p.priceRange.minVariantPrice.amount).toFixed(2),
        currency: p.priceRange.minVariantPrice.currencyCode,
        image: p.featuredImage?.url || ''
      });
    }
  });
  
  // Eğer yeterli ürün bulunamadıysa (recent filtresinden dolayı)
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
            image: p.featuredImage?.url || ''
          });
        }
      }
    });
  }
  
  // Son önerilenleri kaydet (son 15 ürün ID'si)
  const productIds = recommended.map(r => r.handle);
  const updatedRecent = [...recent, ...productIds].slice(-15);
  recentRecommendations.set(sessionId, updatedRecent);
  
  // 1 saatte bir temizle (memory leak önleme)
  if (recentRecommendations.size > 1000) {
    const entries = Array.from(recentRecommendations.entries());
    recentRecommendations.clear();
    entries.slice(-500).forEach(([key, value]) => {
      recentRecommendations.set(key, value);
    });
  }
  
  return recommended;
}