const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  try {
    const { message, shopDomain } = req.body;
    
    console.log('📨 Message:', message);
    
    // Shopify query oluştur
    const query = buildQuery(message);
    
    // 1. Shopify'dan ürünleri çek
    const shopifyRes = await fetch(`https://${shopDomain}/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_TOKEN
      },
      body: JSON.stringify({
        query: `
          query {
            products(first: 20, query: "${query}") {
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
    
    if (!shopifyData.data) {
      throw new Error('Shopify yanıt vermedi');
    }

    const products = shopifyData.data.products.edges
      .map(e => e.node)
      .filter(p => p.availableForSale);

    console.log(`✅ ${products.length} ürün bulundu`);

    if (products.length === 0) {
      return res.json({
        reply: 'Bu kriterlere uygun ürün bulamadım 😔\n\nBaşka bir şey deneyebilir misin?\n• "Kedi maması"\n• "Köpek ödülü"\n• "Yavru mama"',
        products: []
      });
    }

    // 2. OpenAI'ya gönder
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4-turbo-preview',
        messages: [
          {
            role: 'system',
            content: generateSystemPrompt(products, shopDomain)
          },
          {
            role: 'user',
            content: message
          }
        ],
        temperature: 0.7,
        max_tokens: 500
      })
    });

    const aiData = await aiRes.json();
    
    if (!aiData.choices) {
      throw new Error('OpenAI yanıt vermedi');
    }

    const reply = aiData.choices[0].message.content;
    const recommended = extractProducts(reply, products);

    console.log('✅ Yanıt gönderildi');

    res.json({
      reply,
      products: recommended
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      error: error.message,
      reply: 'Bir hata oluştu, lütfen tekrar dene 🙏'
    });
  }
});

app.get('/', (req, res) => {
  res.send('🐾 Avada AI Assistant is running!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// Yardımcı fonksiyonlar
function buildQuery(message) {
  const msg = message.toLowerCase();
  const queries = [];

  if (msg.includes('kedi')) queries.push('product_type:Kedi');
  if (msg.includes('köpek') || msg.includes('kopek')) queries.push('product_type:Köpek');
  if (msg.includes('mama')) queries.push('tag:mama');
  if (msg.includes('ödül') || msg.includes('odul') || msg.includes('treat')) queries.push('tag:ödül OR tag:treats');
  if (msg.includes('yavru') || msg.includes('puppy')) queries.push('tag:yavru OR tag:puppy');
  if (msg.includes('tahılsız') || msg.includes('grain')) queries.push('tag:tahılsız OR tag:grain-free');

  return queries.length > 0 ? queries.join(' OR ') : 'product_type:Mama OR tag:mama';
}

function generateSystemPrompt(products, domain) {
  return `Sen Avada Pet Shop'un AI danışmanısın. Türkçe konuş.

MEVCUT ÜRÜNLER (${products.length} adet):
${products.slice(0, 12).map((p, i) => `
${i + 1}. ${p.title}
   Fiyat: ${parseFloat(p.priceRange.minVariantPrice.amount).toFixed(2)} ${p.priceRange.minVariantPrice.currencyCode}
   Kategori: ${p.productType}
   Etiketler: ${p.tags.join(', ')}
   Link: https://${domain}/products/${p.handle}
`).join('\n')}

KURALLAR:
1. SADECE yukarıdaki ürünlerden öner
2. Max 3 ürün
3. Fiyatları belirt
4. Linkleri ver: [Ürün Adı](https://${domain}/products/handle)
5. Emoji kullan 🐾🐶🐱
6. Max 250 kelime
7. Veteriner tavsiyesi değil, sadece ürün önerisi

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