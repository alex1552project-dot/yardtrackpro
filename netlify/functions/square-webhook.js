const crypto = require('crypto');
const { MongoClient } = require('mongodb');

// Verify Square webhook signature
function verifySignature(body, signature, webhookSignatureKey) {
  const hmac = crypto.createHmac('sha256', webhookSignatureKey);
  hmac.update(body);
  const hash = hmac.digest('base64');
  return hash === signature;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // Verify webhook signature (optional but recommended for production)
    const signature = event.headers['x-square-hmacsha256-signature'];
    if (process.env.SQUARE_WEBHOOK_SIGNATURE_KEY && signature) {
      const isValid = verifySignature(
        event.body,
        signature,
        process.env.SQUARE_WEBHOOK_SIGNATURE_KEY
      );
      if (!isValid) {
        console.error('Invalid webhook signature');
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
      }
    }

    const payload = JSON.parse(event.body);
    const { type, data } = payload;

    console.log('Webhook received:', type);

    // Handle payment completed events
    if (type === 'payment.completed') {
      const payment = data.object.payment;
      
      // Extract yard sale info from reference ID or note
      const isYardSale = payment.note?.includes('Yard Sale') || 
                         payment.referenceId?.startsWith('YS-');

      if (isYardSale) {
        // Connect to MongoDB
        const mongoClient = new MongoClient(process.env.MONGODB_URI);
        await mongoClient.connect();
        const db = mongoClient.db('texasgotrocks');
        
        // Parse salesperson from note: "Yard Sale - Customer Name - Salesperson"
        const noteParts = payment.note?.split(' - ') || [];
        const salesperson = noteParts[2] || 'Unknown';
        const customerName = noteParts[1] || 'Walk-in';

        // Calculate commission (3% of subtotal before fees/tax)
        // Total includes 3.5% service fee + 8.25% tax
        // Reverse: subtotal = total / 1.035 / 1.0825
        const totalAmount = Number(payment.amountMoney.amount) / 100;
        const subtotal = totalAmount / 1.035 / 1.0825;
        const commission = subtotal * 0.03;

        // Record the sale
        const saleRecord = {
          paymentId: payment.id,
          squarePaymentId: payment.id,
          orderType: 'yard_sale',
          status: payment.status,
          totalAmount,
          subtotal: Math.round(subtotal * 100) / 100,
          commission: Math.round(commission * 100) / 100,
          salesperson,
          customerName,
          receiptUrl: payment.receiptUrl,
          locationId: payment.locationId,
          createdAt: new Date(payment.createdAt),
          recordedAt: new Date(),
          source: 'square_webhook'
        };

        await db.collection('yard_sales').insertOne(saleRecord);
        
        // Also update commission tracking
        await db.collection('commissions').insertOne({
          salesperson,
          amount: saleRecord.commission,
          saleId: payment.id,
          saleType: 'yard_sale',
          saleTotal: totalAmount,
          date: new Date(payment.createdAt),
          recordedAt: new Date()
        });

        await mongoClient.close();

        console.log(`Recorded yard sale: $${totalAmount} by ${salesperson}, commission: $${saleRecord.commission}`);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ received: true })
    };

  } catch (error) {
    console.error('Webhook error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Webhook processing failed' })
    };
  }
};
