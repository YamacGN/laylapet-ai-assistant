const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

console.log('🚀 Server starting...');

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
        reply: 'Bu kriterlere uygun ürün bulamadım 😔\n\nBaşka bir şey deneyebilir misin?\n\n💡 Öneriler:\n• "Kedi maması"\n• "Köpek ödülü"\n• "Kısır kedi için mama"\n• "Yavru köpek maması"',
        products: []
      });
    }

    // Maksimum 10 ürünü AI'ya gönder (hız için)
    const productsForAI = filteredProducts.slice(0, 10);

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
        temperature: 0.7,
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
    const recommended = extractProducts(reply, productsForAI);

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
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    api: 'Admin API',
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Using Shopify Admin API`);
});

// ========== YARDIMCI FONKSİYONLAR ==========

function buildSearchTerms(message) {
  const msg = message.toLowerCase();
  const terms = {
    animal: null,
    category: null,
    special: [],
    keywords: []
  };

  // Hayvan türü
  if (msg.includes('kedi')) {
    terms.animal = 'kedi';
  } else if (msg.includes('köpek') || msg.includes('kopek')) {
    terms.animal = 'köpek';
  }

  // Kategori
  if (msg.includes('mama')) {
    terms.category = 'mama';
  } else if (msg.includes('ödül') || msg.includes('odul') || msg.includes('treat')) {
    terms.category = 'ödül';
  } else if (msg.includes('oyuncak')) {
    terms.category = 'oyuncak';
  }

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

  return terms;
}

function smartFilter(products, searchTerms, originalMessage) {
  const msg = originalMessage.toLowerCase();
  
  return products.filter(p => {
    let score = 0;
    const titleLower = p.title.toLowerCase();
    const descLower = p.description.toLowerCase();
    const allTags = p.tags.map(t => t.toLowerCase()).join(' ');
    const productTypeLower = p.productType.toLowerCase();

    // 1. Hayvan türü (zorunlu)
    if (searchTerms.animal) {
      const animalMatch = 
        productTypeLower.includes(searchTerms.animal) ||
        allTags.includes(searchTerms.animal) ||
        titleLower.includes(searchTerms.animal);
      
      if (!animalMatch) return false; // Hayvan türü eşleşmezse eleme
      score += 20;
    }

    // 2. Kategori
    if (searchTerms.category) {
      const catMatch = 
        allTags.includes(searchTerms.category) ||
        titleLower.includes(searchTerms.category) ||
        productTypeLower.includes(searchTerms.category);
      
      if (catMatch) score += 15;
    }

    // 3. Özel durumlar (kısır, yavru, vs) - ÇOK ÖNEMLİ
    if (searchTerms.special.length > 0) {
      let specialMatches = 0;
      searchTerms.special.forEach(keyword => {
        if (titleLower.includes(keyword) || 
            allTags.includes(keyword) || 
            descLower.includes(keyword)) {
          specialMatches++;
        }
      });
      
      if (specialMatches > 0) {
        score += specialMatches * 10; // Her eşleşme +10 puan
      }
    }

    // 4. Stokta olmalı
    if (p.availableForSale) {
      score += 5;
    }

    return score > 0;
  })
  .sort((a, b) => {
    // Skora göre sırala (en yüksek skor önce)
    const scoreA = calculateScore(a, searchTerms);
    const scoreB = calculateScore(b, searchTerms);
    return scoreB - scoreA;
  });
}

function calculateScore(product, searchTerms) {
  let score = 0;
  const titleLower = product.title.toLowerCase();
  const allTags = product.tags.map(t => t.toLowerCase()).join(' ');

  if (searchTerms.animal && (titleLower.includes(searchTerms.animal) || allTags.includes(searchTerms.animal))) {
    score += 20;
  }
  if (searchTerms.category && (titleLower.includes(searchTerms.category) || allTags.includes(searchTerms.category))) {
    score += 15;
  }
  searchTerms.special.forEach(keyword => {
    if (titleLower.includes(keyword) || allTags.includes(keyword)) {
      score += 10;
    }
  });
  
  return score;
}

function generateSystemPrompt(products, domain) {
  return `Sen Laylapet'in AI danışmanısın! 🐾 Türkçe konuş, profesyonel ama samimi ol.

MEVCUT ÜRÜNLER (${products.length} adet - EN UYGUN OLANLAR):
${products.map((p, i) => `
${i + 1}. **${p.title}**
   💰 ${parseFloat(p.priceRange.minVariantPrice.amount).toFixed(2)} TL
   📦 ${p.productType}
   🏷️ ${p.tags.slice(0, 3).join(', ')}
   🔗 https://${domain}/products/${p.handle}
`).join('\n')}

KURALLAR:
1. Maksimum 3 ürün öner
2. Fiyatları belirt
3. Her ürün için kısa açıklama yap (neden uygun?)
4. Link ver: [Ürün Adı](URL)
5. Emoji kullan ama abartma (🐱 🐶 ⭐ 💝)
6. Maksimum 200 kelime
7. Müşterinin tam ihtiyacına göre sırala

ÖNEMLİ: Sadece yukarıdaki ürünlerden öner!`;
}

function extractProducts(reply, allProducts) {
  const recommended = [];
  
  allProducts.forEach(p => {
    const titleMatch = reply.includes(p.title);
    const handleMatch = reply.includes(p.handle);
    
    if ((titleMatch || handleMatch) && recommended.length < 3) {
      recommended.push({
        title: p.title,
        handle: p.handle,
        price: parseFloat(p.priceRange.minVariantPrice.amount).toFixed(2),
        currency: p.priceRange.minVariantPrice.currencyCode,
        image: p.featuredImage?.url || ''
      });
    }
  });
  
  return recommended;
}