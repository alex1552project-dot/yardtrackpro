// netlify/functions/create-payment.js
// YardTrackPro - Square Payment Processing
// Handles yard sale payments with inventory check and source tagging

const { Client, Environment } = require('square');
const { MongoClient } = require('mongodb');

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === 'production' ? Environment.Production : Environment.Sandbox
});

// MongoDB connection
let cachedDb = null;
async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  const mongoClient = await MongoClient.connect(process.env.MONGODB_URI);
  cachedDb = mongoClient.db('gotrocks');
  return cachedDb;
}

// Generate YTP order number
function generateYTPOrderNumber() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `YTP-${dateStr}-${random}`;
}

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
    const { sourceId, amount, customer, salesperson, items, orderType, delivery } = JSON.parse(event.body);

    // Validate required fields
    if (!sourceId || !amount) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing sourceId or amount' })
      };
    }

    const db = await connectToDatabase();

    // --- INVENTORY CHECK ---
    // Verify stock is available before charging the card
    if (items && items.length > 0) {
      const insufficientItems = [];
      for (const item of items) {
        if (item.productId && item.tons) {
          const inventoryRecord = await db.collection('inventory').findOne({ productId: item.productId });
          const currentStock = inventoryRecord?.currentStock || 0;
          if (currentStock < item.tons) {
            insufficientItems.push({
              product: item.material || item.productId,
              available: Math.round(currentStock * 10) / 10,
              requested: item.tons
            });
          }
        }
      }
      if (insufficientItems.length > 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            success: false,
            error: 'Insufficient inventory',
            items: insufficientItems,
            message: insufficientItems.map(i => 
              `${i.product}: only ${i.available} tons available, need ${i.requested}`
            ).join('; ')
          })
        };
      }
    }

    // --- TRUCK AVAILABILITY CHECK ---
    // If this yard sale includes delivery, verify a truck is available
    if (delivery && delivery.date) {
      const deliveryDate = delivery.date; // Expected format: YYYY-MM-DD
      
      // Get all active trucks
      const trucks = await db.collection('trucks').find({ active: { $ne: false } }).toArray();
      
      // Get all deliveries for the requested date
      const existingDeliveries = await db.collection('delivery_schedule').find({
        date: deliveryDate,
        status: { $ne: 'cancelled' }
      }).toArray();

      // Count deliveries per truck (assuming ~4 slots per truck per day as max capacity)
      const maxSlotsPerTruck = 8; // 8am-4pm in 1-hour blocks
      const truckLoad = {};
      existingDeliveries.forEach(d => {
        truckLoad[d.truckId] = (truckLoad[d.truckId] || 0) + 1;
      });

      const availableTrucks = trucks.filter(t => {
        const used = truckLoad[t._id?.toString()] || truckLoad[t.truckId] || 0;
        return used < maxSlotsPerTruck;
      });

      if (availableTrucks.length === 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            success: false,
            error: 'No trucks available',
            date: deliveryDate,
            message: `No delivery trucks available on ${deliveryDate}. Please select a different date.`
          })
        };
      }
    }

    // --- GENERATE ORDER NUMBER & PROCESS PAYMENT ---
    const orderNumber = generateYTPOrderNumber();

    // Amount should be in cents
    const amountCents = Math.round(amount * 100);

    // Create payment with Square — source tagged as YTP
    const { result } = await client.paymentsApi.createPayment({
      sourceId,
      idempotencyKey: `${orderNumber}-${Date.now()}`,
      amountMoney: {
        amount: BigInt(amountCents),
        currency: 'USD'
      },
      locationId: process.env.SQUARE_LOCATION_ID,
      note: `YTP Yard Sale | ${customer?.name || 'Walk-in'} | ${salesperson || 'Unknown'}`,
      referenceId: orderNumber,
      buyerEmailAddress: customer?.email || undefined
    });

    // --- RECORD ORDER IN MONGODB ---
    const orderDoc = {
      orderNumber,
      orderType: orderType || 'yard_sale',
      customer: {
        name: customer?.name || 'Walk-in',
        email: customer?.email || null,
        phone: customer?.phone || null
      },
      items: (items || []).map(item => ({
        product: item.material || item.product || 'Unknown',
        productId: item.productId || null,
        quantity: item.quantity || 0,
        tons: item.tons || 0,
        total: item.total || 0
      })),
      totals: {
        subtotal: amount / 1.035 / 1.0825, // Reverse out fees/tax for reporting
        total: amount
      },
      delivery: delivery ? {
        scheduledDate: delivery.date,
        status: 'pending'
      } : null,
      payment: {
        method: 'card',
        status: result.payment.status === 'COMPLETED' || result.payment.status === 'APPROVED' ? 'completed' : 'pending',
        squarePaymentId: result.payment.id,
        receiptUrl: result.payment.receiptUrl || null,
        completedAt: new Date()
      },
      salesperson: salesperson || 'Unknown',
      status: 'paid',
      source: 'yardtrackpro',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('yard_sales').insertOne(orderDoc);
    console.log('YTP order saved to MongoDB:', orderNumber);

    // --- DEPLETE INVENTORY ---
    if (items && items.length > 0) {
      for (const item of items) {
        if (item.productId && item.tons) {
          await db.collection('inventory').updateOne(
            { productId: item.productId },
            { 
              $inc: { currentStock: -parseFloat(item.tons) },
              $set: { updatedAt: new Date() }
            }
          );
        }
      }
      console.log('Inventory depleted for YTP order:', orderNumber);
    }

    // Return success with payment details
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        orderNumber,
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
