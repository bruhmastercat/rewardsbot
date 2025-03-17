const StellarSdk = require('@stellar/stellar-sdk');
require('dotenv').config();
const cron = require('node-cron');

// Configuration
const server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
const distributor = StellarSdk.Keypair.fromSecret(process.env.SECRET_KEY);
const asset = new StellarSdk.Asset(process.env.ASSET_CODE, process.env.ASSET_ISSUER);
const REWARD_RATE = parseFloat(process.env.REWARD_RATE);
const MIN_PAYMENT = 0.0000001; // Adjust as needed

console.log('=== Bot Configuration ===');
console.log(`Asset: ${asset.code}:${asset.issuer}`);
console.log(`Distributor: ${distributor.publicKey()}`);
console.log(`Reward Rate: ${REWARD_RATE * 100}% per distribution`);
console.log('=========================');

async function fetchHolders() {
  let holders = [];
  let records = await server.accounts()
    .forAsset(asset)
    .limit(200)
    .call();

  console.log(`Initial fetch: ${records.records.length} holders`);
  
  while (records.records.length > 0) {
    holders = holders.concat(records.records);
    records = await records.next();
    console.log(`Fetched additional ${records.records.length} holders`);
  }
  
  console.log(`✅ Total holders found: ${holders.length}`);
  return holders;
}

async function calculateRewards(holders) {
  console.log('\n🔍 Processing holders:');
  return holders.map(holder => {
    // Skip distributor account
    if (holder.id === distributor.publicKey()) {
      console.log(`⏩ Skipping distributor account`);
      return null;
    }

    console.log(`\nChecking holder: ${holder.id}`);
    
    const balanceEntry = holder.balances.find(b => {
      const isAsset = (b.asset_type === 'credit_alphanum12' || b.asset_type === 'credit_alphanum4') &&
                      b.asset_code === asset.code && 
                      b.asset_issuer === asset.issuer;
      
      if (isAsset) console.log(`💰 Balance: ${b.balance} ${asset.code}`);
      return isAsset;
    });

    if (!balanceEntry) {
      console.log('❌ No matching asset balance');
      return null;
    }

    const balance = parseFloat(balanceEntry.balance);
    const reward = balance * REWARD_RATE;
    console.log(`🎯 Calculated reward: ${reward.toFixed(7)} XLM`);

    if (reward < MIN_PAYMENT) {
      console.log(`🚫 Below minimum payment (${MIN_PAYMENT} XLM)`);
      return null;
    }

    return {
      address: holder.id,
      amount: reward.toFixed(7)
    };
  }).filter(Boolean);
}

async function distributeRewards() {
  try {
    console.log('\n🚀 Starting distribution cycle');
    const holders = await fetchHolders();
    
    if (holders.length === 0) {
      console.log('⚠️ No holders found');
      return;
    }

    const payments = await calculateRewards(holders);
    console.log(`\n📝 Valid payments: ${payments.length}`);
    
    if (payments.length === 0) {
      console.log('⏩ No eligible payments');
      return;
    }

    // Verify distributor isn't in payments
    if (payments.some(p => p.address === distributor.publicKey())) {
      console.log('❌ Critical Error: Distributor in payment list!');
      return;
    }

    const account = await server.loadAccount(distributor.publicKey());
    console.log(`\n🔢 Distributor sequence: ${account.sequenceNumber}`);

    // Process in batches of 100
    for (let i = 0; i < payments.length; i += 100) {
      const batch = payments.slice(i, i + 100);
      console.log(`\n📦 Processing batch ${i/100 + 1} (${batch.length} payments)`);
      
      let transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET
      });

      batch.forEach(payment => {
        transaction.addOperation(StellarSdk.Operation.payment({
          destination: payment.address,
          asset: StellarSdk.Asset.native(),
          amount: payment.amount
        }));
      });

      const tx = transaction.setTimeout(30).build();
      tx.sign(distributor);
      
      try {
        const result = await server.submitTransaction(tx);
        console.log(`✅ Batch ${i/100 + 1} success: ${result.hash}`);
      } catch (error) {
        console.error('❌ Batch failed:', error.response.data);
      }
    }
  } catch (error) {
    console.error('⚠️ Critical error:', error);
  }
}

// Schedule every 15 minutes
cron.schedule('*/1 * * * *', () => {
  console.log('\n\n⏰ === Triggering scheduled payout ===');
  distributeRewards();
});

console.log('\n🚀 Reward bot started (v1.1)');