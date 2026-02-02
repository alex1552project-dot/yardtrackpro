const { Client, Environment } = require('square');

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === 'production' ? Environment.Production : Environment.Sandbox
});

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { sourceId, amount, customer, salesperson, items, orderType } = JSON.parse(event.body);

    // Validate required fields
    if (!sourceId || !amount) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing sourceId or amount' })
      };
    }

    // Amount should be in cents
    const amountCents = Math.round(amount * 100);

    // Create payment with Square
    const { result } = await client.paymentsApi.createPayment({
      sourceId,
      idempotencyKey: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      amountMoney: {
        amount: BigInt(amountCents),
        currency: 'USD'
      },
      locationId: process.env.SQUARE_LOCATION_ID,
      note: `Yard Sale - ${customer?.name || 'Walk-in'} - ${salesperson}`,
      referenceId: `YS-${Date.now()}`
    });

    // Return success with payment details
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        paymentId: result.payment.id,
        status: result.payment.status,
        receiptUrl: result.payment.receiptUrl,
        createdAt: result.payment.createdAt
      })
    };

  } catch (error) {
    console.error('Payment error:', error);
    
    // Handle Square API errors
    if (error.errors) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: error.errors[0]?.detail || 'Payment failed',
          code: error.errors[0]?.code
        })
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
