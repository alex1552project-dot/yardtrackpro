// netlify/functions/extract-ticket.js
// YardTrackPro - Real OCR using Claude Vision API
// Includes AI matching to Texas Got Rocks productIds

// Valid product IDs from Texas Got Rocks inventory
const VALID_PRODUCTS = {
  // Rock & Gravel
  'decomposed-granite': ['decomposed granite', 'dg', '1/4 minus', 'quarter minus', 'qm', 'crushed granite'],
  'granite-base': ['granite base', 'base granite', 'road base granite'],
  'limestone-1': ['1 limestone', '1" limestone', '1 inch limestone', 'one inch limestone'],
  'limestone-3/4': ['3/4 limestone', '3/4" limestone', 'three quarter limestone'],
  'limestone-3/8': ['3/8 limestone', '3/8" limestone', 'three eighth limestone'],
  'limestone-base': ['limestone base', 'base limestone', 'road base'],
  'bull-rock-3x5': ['bull rock', '3x5 bull', '3x5 rock', 'bull rock 3x5', 'oversize', '3x6', '3x5', 'rip rap', 'riprap', 'oversize - 3x6', 'oversize - 3x5'],
  'gravel-2x3': ['2x3 gravel', '2x3', 'two by three'],
  'gravel-1.5-minus': ['1.5 minus', '1-1/2 minus', 'inch and half minus'],
  'pea-gravel': ['pea gravel', 'pea rock', '3/8 pea'],
  'rainbow-gravel': ['rainbow gravel', 'rainbow rock', 'colored gravel'],
  'blackstar': ['black star', 'blackstar', '5/8 black'],
  'colorado-bull-rock': ['colorado bull', '1x3 colorado', 'colorado rock'],
  'fairland-pink': ['fairland pink', 'fairland', 'pink rock', '1x2 fairland'],
  // Soil & Sand
  'bank-sand': ['bank sand', 'fill sand', 'common sand'],
  'select-fill': ['select fill', 'select', 'fill dirt'],
  'topsoil': ['topsoil', 'top soil', 'garden soil', 'black dirt'],
  'torpedo-sand': ['torpedo sand', 'torpedo', 'concrete sand'],
  'mason-sand': ['mason sand', 'masonry sand', 'mortar sand', 'plaster sand'],
  // Mulch
  'mulch-black': ['black mulch', 'dyed black', 'black hardwood'],
  'mulch-brown': ['brown mulch', 'hardwood mulch', 'brown hardwood', 'natural mulch']
};

// Find best matching productId
function matchProductId(materialName) {
  if (!materialName) return { productId: null, confidence: 0 };
  
  const normalizedName = materialName.toLowerCase().trim();
  
  // Direct match check
  if (VALID_PRODUCTS[normalizedName]) {
    return { productId: normalizedName, confidence: 1.0 };
  }
  
  // Check aliases
  let bestMatch = null;
  let bestScore = 0;
  
  for (const [productId, aliases] of Object.entries(VALID_PRODUCTS)) {
    for (const alias of aliases) {
      // Check if alias is contained in material name or vice versa
      if (normalizedName.includes(alias) || alias.includes(normalizedName)) {
        const score = alias.length / Math.max(normalizedName.length, alias.length);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = productId;
        }
      }
      
      // Word-by-word matching
      const aliasWords = alias.split(' ');
      const nameWords = normalizedName.split(' ');
      let matchedWords = 0;
      for (const word of aliasWords) {
        if (nameWords.some(w => w.includes(word) || word.includes(w))) {
          matchedWords++;
        }
      }
      const wordScore = matchedWords / aliasWords.length;
      if (wordScore > bestScore) {
        bestScore = wordScore;
        bestMatch = productId;
      }
    }
  }
  
  return {
    productId: bestMatch,
    confidence: bestScore
  };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { image } = JSON.parse(event.body);

    if (!image) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No image provided' })
      };
    }

    // Remove data URL prefix if present
    const base64Image = image.replace(/^data:image\/\w+;base64,/, '');

    // Call Claude Vision API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: base64Image
                }
              },
              {
                type: 'text',
                text: `You are analyzing a material delivery ticket/scale ticket image for a Texas landscaping materials company.

Extract the following information and return ONLY a valid JSON object:

{
  "vendor": "Company name from the ticket header (e.g., Vulcan Materials, Liberty Materials Inc., Collier Materials, Martin Marietta, etc.)",
  "material": "Product/material type exactly as written on ticket (e.g., BASE A-2, Masonry Sand #2, QM-1/4 Minus, 3x5 Bull Rock, Decomposed Granite, etc.)",
  "ticketNumber": "The ticket number/ID",
  "weight": "NET weight in US SHORT TONS - IMPORTANT: Many tickets show BOTH metric (MG/MT) and US columns. ALWAYS use the US column, NOT the metric column. Look for 'NET' row and 'US' or 'SH TN' column. Typical loads are 10-25 US tons.",
  "truck": "Truck ID or number (look for fields like Truck, Vehicle, Unit #, or codes like TC003)",
  "date": "Date in YYYY-MM-DD format"
}

CRITICAL for weight:
- Find the NET row (Gross minus Tare)
- Use the US TONS column, NOT metric (MG/MT) column
- US tons column often labeled 'US', 'SH TN', 'SHORT TONS'
- Metric column often labeled 'MG', 'MT', 'METRIC'
- If only one weight shown and in pounds, divide by 2000
- Return ONLY the JSON object, no other text
- If a field cannot be determined, use empty string ""`
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', errorText);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to analyze image', details: errorText })
      };
    }

    const result = await response.json();
    const content = result.content[0].text;

    // Parse the JSON from Claude's response
    let extractedData;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[0]);
      } else {
        extractedData = JSON.parse(content);
      }
    } catch (parseError) {
      console.error('Failed to parse Claude response:', content);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to parse extracted data', raw: content })
      };
    }

    // Match the material to a productId
    const materialMatch = matchProductId(extractedData.material);

    // Clean and return the data
    const cleanedData = {
      vendor: extractedData.vendor || '',
      material: extractedData.material || '',
      ticketNumber: extractedData.ticketNumber || '',
      weight: parseFloat(extractedData.weight) || 0,
      truck: extractedData.truck || '',
      date: extractedData.date || new Date().toISOString().split('T')[0],
      // Product matching
      productId: materialMatch.productId,
      matchConfidence: materialMatch.confidence,
      needsReview: materialMatch.confidence < 0.6
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: cleanedData
      })
    };

  } catch (error) {
    console.error('Extract ticket error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error', message: error.message })
    };
  }
};
