require('dotenv').config(); // .env dosyasındaki değişkenleri yükler
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

console.log('🚀 Server başlatılıyor...');

app.post('/api/chat', async (req, res) => {
  try {
    const { message, shopDomain } = req.body;
    
    console.log('📨 Gelen Mesaj:', message);
    console.log('🏪 Mağaza:', shopDomain);
    
    if (!message || !shopDomain) {
      return res.status(400).json({
        reply: 'Mesaj veya shop domain eksik',
        products: []
      });
    }

    // Shopify Sorgusu Oluşturma
    const query = buildQuery(message);
    console.log('🔍 Shopify Sorgusu:', query);

    // 1. Shopify'dan Ürünleri Çek (Admin API Ayarlarıyla)
    const shopifyRes = await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ÖNEMLİ: shpat_ tokenı için doğru header budur:
        'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN 
      },
      body: JSON.stringify({
        query: `
          {
            products(first: 15, query: "${escapeQuery(query)}") {
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
    console.log('📦 Shopify Yanıt Durumu:', shopifyRes.status);

    if (shopifyData.errors) {
      console.error('❌ Shopify Hatası:', shopifyData.errors);
      throw new Error('Shopify API hatası oluştu.');
    }

    const products = (shopifyData.data?.products?.edges || [])
      .map(e => e.node)
      .filter(p => p.availableForSale);

    console.log(`✅ ${products.length} adet uygun ürün bulundu.`);

    if (products.length === 0) {
      return res.json({
        reply: 'Aradığın kriterlere uygun bir ürün bulamadım 😔 Başka bir şey sormak ister misin?',
        products: []
      });
    }

    // 2. OpenAI'ya Gönder
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
        temperature: 0.7
      })
    });

    const aiData = await aiRes.json();
    
    if (aiData.error) {
      throw new Error('OpenAI Hatası: ' + aiData.error.message);
    }

    const reply = aiData.choices[0].message.content;
    const recommended = extractProducts(reply, products);

    console.log('✅ İşlem başarıyla tamamlandı.');

    res.json({
      reply,
      products: recommended
    });

  } catch (error) {
    console.error('❌ Hata Detayı:', error);
    res.status(500).json({
      error: error.message,
      reply: 'Üzgünüm, bir bağlantı hatası oluştu. Lütfen tekrar dene.'
    });
  }
});

// Sunucu Durumu Kontrol Sayfası
app.get('/', (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 50px;">
      <h1>🐾 Laylapet AI API</h1>
      <p>Durum: ${process.env.SHOPIFY_TOKEN ? '✅ Bağlı' : '❌ Token Eksik'}</p>
      <p>Endpoint: <code>POST /api/chat</code></p>
    </div>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Sunucu port ${PORT} üzerinde çalışıyor.`);
});

// ========== YARDIMCI FONKSİYONLAR ==========

function escapeQuery(str) {
  return str.replace(/"/g, '\\"');
}

function buildQuery(message) {
  const msg = message.toLowerCase();
  const queries = [];

  if (msg.includes('kedi')) queries.push('product_type:Kedi');
  if (msg.includes('köpek') || msg.includes('kopek')) queries.push('product_type:Köpek');
  if (msg.includes('mama')) queries.push('tag:mama');
  if (msg.includes('ödül') || msg.includes('odul')) queries.push('tag:ödül');
  
  return queries.length > 0 ? queries.join(' AND ') : 'status:active';
}

function generateSystemPrompt(products, domain) {
  return `Sen Laylapet mağazasının uzman kedi/köpek danışmanısın. 
  Müşteriye samimi bir dille yardımcı ol. 
  Sadece sana verdiğim ürün listesini kullan. 
  Ürün linklerini mutlaka [Ürün Adı](https://${domain}/products/handle) formatında ver.
  Fiyatları TL cinsinden belirt.
  
  ÜRÜN LİSTESİ:
  ${products.map(p => `- ${p.title} (Fiyat: ${p.priceRange.minVariantPrice.amount}, Link: ${p.handle})`).join('\n')}`;
}

function extractProducts(reply, allProducts) {
  const recommended = [];
  allProducts.forEach(p => {
    if (reply.includes(p.title) && recommended.length < 3) {
      recommended.push({
        title: p.title,
        handle: p.handle,
        price: p.priceRange.minVariantPrice.amount,
        image: p.featuredImage?.url
      });
    }
  });
  return recommended;
}