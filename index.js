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
    
    // Shopify query
    const query = buildQuery(message);
    console.log('🔍 Query:', query);
    
    // 1. Shopify'dan ürünleri çek
    const shopifyRes = await fetch(`https://laylapet-3.myshopify.com/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_TOKEN
      },
      body: JSON.stringify({
        query: `
          {
            products(first: 20, query: "${escapeQuery(query)}") {
              edges {
                node {
                  id
                  title
                  handle
                  productType
                  tags
                  priceRange {
                    minVariantPrice {
                      amount
                      currencyCode
                    }
                  }
                  description
                  availableForSale
                  featuredImage {
                    url
                  }
                }
              }
            }
          }
        `
      })
    });

    const shopifyData = await shopifyRes.json();
    
    console.log('📦 Shopify status:', shopifyRes.status);
    
    if (shopifyData.errors) {
      console.error('❌ Shopify errors:', shopifyData.errors);
      throw new Error('Shopify hatası: ' + JSON.stringify(shopifyData.errors));
    }
    
    if (!shopifyData.data || !shopifyData.data.products) {
      console.error('❌ No data:', shopifyData);
      throw new Error('Shopify yanıt vermedi');
    }

    const products = shopifyData.data.products.edges
      .map(e => e.node)
      .filter(p => p.availableForSale);

    console.log(`✅ ${products.length} ürün bulundu`);

    if (products.length === 0) {
      return res.json({
        reply: 'Bu kriterlere uygun ürün bulamadım 😔\n\nBaşka bir şey deneyebilir misin?\n\n💡 Öneriler:\n• "Kedi maması"\n• "Köpek ödülü"\n• "Yavru mama"',
        products: []
      });
    }

    // 2. OpenAI'ya gönder
    const systemPrompt = generateSystemPrompt(products, shopDomain);
    
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
    const recommended = extractProducts(reply, products);

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
        <p>Server çalışıyor! ✅</p>
        <p>API Endpoint: <code>POST /api/chat</code></p>
        <hr>
        <p style="color: #666;">
          Environment:<br>
          OPENAI_KEY: ${process.env.OPENAI_KEY ? '✅ Set' : '❌ Missing'}<br>
          SHOPIFY_TOKEN: ${process.env.SHOPIFY_TOKEN ? '✅ Set' : '❌ Missing'}
        </p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// ========== YARDIMCI FONKSİYONLAR ==========

function escapeQuery(str) {
  // GraphQL query için escape
  return str.replace(/"/g, '\\"');
}

function buildQuery(message) {
  const msg = message.toLowerCase();
  const queries = [];

  if (msg.includes('kedi')) {
    queries.push('product_type:Kedi');
  } else if (msg.includes('köpek') || msg.includes('kopek')) {
    queries.push('product_type:Köpek');
  }
  
  if (msg.includes('mama')) {
    queries.push('tag:mama');
  } else if (msg.includes('ödül') || msg.includes('odul') || msg.includes('treat')) {
    queries.push('tag:ödül');
  }
  
  if (msg.includes('yavru') || msg.includes('puppy') || msg.includes('kitten')) {
    queries.push('tag:yavru');
  }
  
  if (msg.includes('tahılsız') || msg.includes('tahilsiz')) {
    queries.push('tag:tahılsız');
  }

  if (queries.length === 0) {
    return 'product_type:Mama';
  }

  return queries.join(' OR ');
}

function generateSystemPrompt(products, domain) {
  return `Sen Laylapet'in AI danışmanısın. Türkçe konuş.

MEVCUT ÜRÜNLER (${products.length} adet):
${products.slice(0, 12).map((p, i) => `
${i + 1}. ${p.title}
   Fiyat: ${parseFloat(p.priceRange.minVariantPrice.amount).toFixed(2)} ${p.priceRange.minVariantPrice.currencyCode}
   Kategori: ${p.productType}
   Link: https://${domain}/products/${p.handle}
`).join('\n')}

KURALLAR:
1. SADECE yukarıdaki ürünlerden öner
2. Max 3 ürün
3. Fiyat belirt
4. Link ver: [Ürün](https://${domain}/products/handle)
5. Emoji kullan 🐾
6. Max 250 kelime

Müşteriye yardım et! 🚀`;
}

function extractProducts(reply, allProducts) {
  const recommended = [];
  
  allProducts.forEach(p => {
    if ((reply.includes(p.title) || reply.includes(p.handle)) && recommended.length < 3) {
      recommended.push({
        title: p.title,
        handle: p.handle,
        price: parseFloat(p.priceRange.minVariantPrice.amount).toFixed(2),
        currency: p.priceRange.minVariantPrice.currencyCode,
        image: p.featuredImage?.url
      });
    }
  });
  
  return recommended;
}