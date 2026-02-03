// netlify/functions/extract-ticket.js
// YardTrackPro - Real OCR using Claude Vision API

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
                text: `You are analyzing a material delivery ticket/scale ticket image. Extract the following information and return ONLY a valid JSON object with these exact fields:

{
  "vendor": "Company name from the ticket header (e.g., Liberty Materials Inc., Collier Materials, etc.)",
  "material": "Product/material type (e.g., Masonry Sand #2, QM-1/4 Minus, Limestone, etc.)",
  "ticketNumber": "The ticket number/ID",
  "weight": "NET weight in tons as a number (not gross, not tare - the NET weight)",
  "truck": "Truck ID or number",
  "date": "Date in YYYY-MM-DD format"
}

Important notes:
- For weight, always use the NET weight (Gross minus Tare), converted to tons if given in pounds (divide by 2000)
- If the weight is already in tons, use that number directly
- Look for fields labeled "Net", "Net Weight", "Net Tons", etc.
- Return ONLY the JSON object, no other text or explanation
- If a field cannot be determined, use an empty string ""`
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
      // Try to extract JSON from the response (in case there's extra text)
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

    // Validate and clean the data
    const cleanedData = {
      vendor: extractedData.vendor || '',
      material: extractedData.material || '',
      ticketNumber: extractedData.ticketNumber || '',
      weight: parseFloat(extractedData.weight) || 0,
      truck: extractedData.truck || '',
      date: extractedData.date || new Date().toISOString().split('T')[0]
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
