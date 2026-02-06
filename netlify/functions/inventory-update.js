// netlify/functions/inventory-update.js
// YardTrackPro - Inventory Management
// Handles: Yard sale depletion & inbound ticket additions

const { MongoClient } = require('mongodb');

let cachedDb = null;
async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  cachedDb = client.db('gotrocks');
  return cachedDb;
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
    const { action, productId, tons, ticketData, saleData } = JSON.parse(event.body);

    if (!action || !productId || tons === undefined) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields: action, productId, tons' })
      };
    }

    const db = await connectToDatabase();

    if (action === 'increase') {
      // INBOUND TICKET - Add to inventory
      const result = await db.collection('inventory').updateOne(
        { productId },
        { 
          $inc: { currentStock: parseFloat(tons) },
          $set: { updatedAt: new Date() }
        },
        { upsert: true }
      );

      // Log the inbound ticket
      await db.collection('inbound_tickets').insertOne({
        productId,
        tons: parseFloat(tons),
        vendor: ticketData?.vendor || 'Unknown',
        material: ticketData?.material || productId,
        ticketNumber: ticketData?.ticketNumber || '',
        truck: ticketData?.truck || '',
        date: ticketData?.date || new Date().toISOString().split('T')[0],
        capturedBy: ticketData?.capturedBy || 'Unknown',
        capturedAt: new Date(),
        source: 'yardtrackpro'
      });

      console.log(`Inventory INCREASED: ${productId} +${tons} tons`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          action: 'increase',
          productId,
          tons,
          message: `Added ${tons} tons to ${productId}`
        })
      };

    } else if (action === 'decrease') {
      // YARD SALE - Deplete inventory

      // NEW: Check stock availability before depleting
      const inventoryRecord = await db.collection('inventory').findOne({ productId });
      const currentStock = inventoryRecord?.currentStock || 0;
      const requestedTons = parseFloat(tons);

      if (currentStock < requestedTons) {
        console.log(`Insufficient stock: ${productId} has ${currentStock} tons, requested ${requestedTons}`);
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            success: false,
            error: 'Insufficient inventory',
            available: Math.round(currentStock * 10) / 10,
            requested: requestedTons,
            message: `Only ${Math.round(currentStock * 10) / 10} tons of ${productId} available. Cannot sell ${requestedTons} tons.`
          })
        };
      }

      const result = await db.collection('inventory').updateOne(
        { productId },
        { 
          $inc: { currentStock: -requestedTons },
          $set: { updatedAt: new Date() }
        }
      );

      // Log the yard sale
      await db.collection('yard_sales').insertOne({
        productId,
        tons: requestedTons,
        material: saleData?.material || productId,
        quantity: saleData?.quantity || 0,
        subtotal: saleData?.subtotal || 0,
        serviceFee: saleData?.serviceFee || 0,
        salesTax: saleData?.salesTax || 0,
        total: saleData?.total || 0,
        customer: saleData?.customer || {},
        salesperson: saleData?.salesperson || 'Unknown',
        paymentMethod: saleData?.paymentMethod || 'card',
        paymentId: saleData?.paymentId || null,
        createdAt: new Date(),
        source: 'yardtrackpro'
      });

      console.log(`Inventory DECREASED: ${productId} -${requestedTons} tons (was ${currentStock}, now ${currentStock - requestedTons})`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          action: 'decrease',
          productId,
          tons: requestedTons,
          previousStock: currentStock,
          newStock: Math.round((currentStock - requestedTons) * 10) / 10,
          message: `Removed ${requestedTons} tons from ${productId}`
        })
      };

    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid action. Use "increase" or "decrease"' })
      };
    }

  } catch (error) {
    console.error('Inventory update error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error', message: error.message })
    };
  }
};
