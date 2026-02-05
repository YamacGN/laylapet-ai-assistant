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
    
    // 1. Shopify Admin API - Ürünleri çek (REST API)
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

    // Admin API formatından GraphQL formatına çevir
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
        description: p.body_html ? p.body_html.replace(/<[^>]*>/g, '').substring(0, 300) : '',
        availableForSale: p.variants && p.variants.some(v => 
          (v.inventory_quantity || 0) > 0 || v.inventory_policy === 'continue'
        ),
        featuredImage: {
          url: p.image?.src || (p.images && p.images[0] ? p.images[0].src : '')
        }
      }));

    console.log(`📊 Toplam ${allProducts.length} aktif ürün`);

    // Kullanıcı sorgusuna göre filtrele
    const filteredProducts = filterProducts(allProducts, searchTerms);

    console.log(`✅ ${filteredProducts.length} ürün filtrelendi`);

    if (filteredProducts.length === 0) {
      return res.json({
        reply: 'Bu kriterlere uygun ürün bulamadım 😔\n\nBaşka bir şey deneyebilir misin?\n\n💡 Öneriler:\n• "Kedi maması"\n• "Köpek ödülü"\n• "Yavru mama"',
        products: []
      });
    }

    // En fazla 15 ürünü AI'ya gönder
    const productsForAI = filteredProducts.slice(0, 15);

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
        max_tokens: 600
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
        <p style="font-size: 12px; color: #999;">
          Using Shopify Admin API (REST)
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
    tags: []
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
    terms.tags.push('mama');
  } else if (msg.includes('ödül') || msg.includes('odul') || msg.includes('treat')) {
    terms.category = 'ödül';
    terms.tags.push('ödül', 'treat');
  } else if (msg.includes('oyuncak')) {
    terms.category = 'oyuncak';
    terms.tags.push('oyuncak');
  }

  // Özel özellikler
  if (msg.includes('yavru') || msg.includes('puppy') || msg.includes('kitten')) {
    terms.tags.push('yavru', 'puppy', 'kitten');
  }
  if (msg.includes('tahılsız') || msg.includes('tahilsiz') || msg.includes('grain free')) {
    terms.tags.push('tahılsız', 'grain free');
  }
  if (msg.includes('yaş') || msg.includes('wet')) {
    terms.tags.push('yaş', 'wet');
  }
  if (msg.includes('kuru') || msg.includes('dry')) {
    terms.tags.push('kuru', 'dry');
  }

  return terms;
}

function filterProducts(products, searchTerms) {
  return products.filter(p => {
    let score = 0;

    // Hayvan türü kontrolü (product_type veya tags)
    if (searchTerms.animal) {
      const typeMatch = p.productType.toLowerCase().includes(searchTerms.animal);
      const tagMatch = p.tags.some(tag => tag.toLowerCase().includes(searchTerms.animal));
      const titleMatch = p.title.toLowerCase().includes(searchTerms.animal);
      
      if (typeMatch || tagMatch || titleMatch) {
        score += 10;
      } else {
        return false; // Hayvan türü eşleşmezse direkt eleme
      }
    }

    // Kategori kontrolü
    if (searchTerms.category) {
      const catMatch = p.tags.some(tag => tag.toLowerCase().includes(searchTerms.category));
      const titleMatch = p.title.toLowerCase().includes(searchTerms.category);
      const typeMatch = p.productType.toLowerCase().includes(searchTerms.category);
      
      if (catMatch || titleMatch || typeMatch) {
        score += 5;
      }
    }

    // Tag kontrolü
    searchTerms.tags.forEach(searchTag => {
      const tagMatch = p.tags.some(tag => tag.toLowerCase().includes(searchTag.toLowerCase()));
      const titleMatch = p.title.toLowerCase().includes(searchTag.toLowerCase());
      
      if (tagMatch || titleMatch) {
        score += 3;
      }
    });

    // Stokta olmalı
    if (p.availableForSale) {
      score += 1;
    }

    return score > 0;
  }).sort((a, b) => {
    // Fiyat karşılaştırması için score hesapla
    return parseFloat(a.priceRange.minVariantPrice.amount) - parseFloat(b.priceRange.minVariantPrice.amount);
  });
}

function generateSystemPrompt(products, domain) {
  return `Sen Laylapet'in AI pet shop danışmanısın! 🐾

Türkçe konuş, samimi ve yardımsever ol.

MEVCUT ÜRÜNLER (${products.length} adet):
${products.map((p, i) => `
${i + 1}. ${p.title}
   💰 Fiyat: ${parseFloat(p.priceRange.minVariantPrice.amount).toFixed(2)} ${p.priceRange.minVariantPrice.currencyCode}
   📦 Kategori: ${p.productType}
   🏷️ Etiketler: ${p.tags.slice(0, 5).join(', ')}
   🔗 Link: https://${domain}/products/${p.handle}
`).join('\n')}

KURALLAR:
1. ✅ SADECE yukarıdaki ürünlerden öner
2. ✅ Maksimum 3 ürün öner
3. ✅ Her ürün için fiyat belirt
4. ✅ Link formatı: [Ürün Adı](https://${domain}/products/handle)
5. ✅ Emoji kullan (🐱 🐶 🐾 💝 ⭐)
6. ✅ Kısa ve öz yaz (maksimum 250 kelime)
7. ✅ Ürün özelliklerini vurgula (tahılsız, yavru, vs)

Müşteriye en uygun ürünleri öner! 🚀`;
}

function extractProducts(reply, allProducts) {
  const recommended = [];
  
  allProducts.forEach(p => {
    // Başlık veya handle eşleşmesi
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