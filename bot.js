const { Client, GatewayIntentBits } = require('discord.js');
const EasyPost = require('@easypost/api');
const fs = require('fs');
require('dotenv').config();

const STATS_FILE = 'stats.json';

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch {
    return { totalPackages: 0, byService: {}, byRecipient: {} };
  }
}

function saveStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Initialize EasyPost
const easypost = new EasyPost(process.env.EASYPOST_API_KEY);

// Initialize Shippo
const shippo = require('shippo')(process.env.SHIPPO_API_KEY);

// Store active label creation sessions
const sessions = new Map();

// Label creation steps
const STEPS = {
  NAME: 'name',
  STREET: 'street',
  CITY: 'city',
  STATE: 'state',
  ZIP: 'zip',
  WEIGHT: 'weight',
  LENGTH: 'length',
  WIDTH: 'width',
  HEIGHT: 'height',
  SELECT_RATE: 'select_rate',
  CONFIRM: 'confirm',
};

// Bot ready event
client.once('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log('Ready to create labels!');
});

// Message handler
client.on('messageCreate', async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  const userId = message.author.id;
  const content = message.content.trim();

  // Start new label creation
  if (content.toLowerCase() === '!label') {
    sessions.set(userId, {
      step: STEPS.NAME,
      data: {},
    });
    message.reply('📦 Let\'s create a shipping label!\n\n**What is the recipient\'s name?**');
    return;
  }

  // Stats command
  if (content.toLowerCase() === '!stats') {
    const stats = loadStats();

    if (stats.totalPackages === 0) {
      message.reply('📦 No labels have been created yet.');
      return;
    }

    const byService = Object.entries(stats.byService)
      .sort((a, b) => b[1] - a[1])
      .map(([service, count]) => `  ${service}: **${count}**`)
      .join('\n');

    const byRecipient = Object.entries(stats.byRecipient)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `  ${name}: **${count}**`)
      .join('\n');

    message.reply(
      `📊 **Shipping Stats**\n\n` +
      `**Total Labels:** ${stats.totalPackages}\n\n` +
      `**By Service:**\n${byService}\n\n` +
      `**By Recipient:**\n${byRecipient}`
    );
    return;
  }

  // Cancel command
  if (content.toLowerCase() === '!cancel') {
    if (sessions.has(userId)) {
      sessions.delete(userId);
      message.reply('❌ Label creation cancelled.');
    }
    return;
  }

  // Handle active session
  const session = sessions.get(userId);
  if (!session) return;

  try {
    await handleStep(message, session, content);
  } catch (error) {
    console.error('Error handling step:', error);
    message.reply(`❌ Error: ${error.message}\n\nType \`!cancel\` to start over.`);
  }
});

async function handleStep(message, session, content) {
  const { step, data } = session;
  const userId = message.author.id;

  switch (step) {
    case STEPS.NAME:
      data.name = content;
      session.step = STEPS.STREET;
      message.reply('**What is the street address?**\n(e.g., 123 Main St, Apt 4)');
      break;

    case STEPS.STREET:
      data.street = content;
      session.step = STEPS.CITY;
      message.reply('**What is the city?**');
      break;

    case STEPS.CITY:
      data.city = content;
      session.step = STEPS.STATE;
      message.reply('**What is the state?**\n(e.g., CA, NY, TX)');
      break;

    case STEPS.STATE:
      data.state = content.toUpperCase();
      session.step = STEPS.ZIP;
      message.reply('**What is the ZIP code?**');
      break;

    case STEPS.ZIP:
      data.zip = content;
      session.step = STEPS.WEIGHT;
      message.reply('**What is the weight in pounds?**\n(e.g., 1.5 for 1.5 lbs, or 0.5 for 8 oz)\nJust enter the number.');
      break;

    case STEPS.WEIGHT:
      const weight = parseFloat(content);
      if (isNaN(weight) || weight <= 0) {
        message.reply('❌ Invalid weight. Please enter a number (e.g., 1.5 for 1.5 lbs)');
        return;
      }
      data.weight = weight;
      session.step = STEPS.LENGTH;
      message.reply('**What is the package length in inches?**\n(Just the number)');
      break;

    case STEPS.LENGTH:
      const length = parseFloat(content);
      if (isNaN(length) || length <= 0) {
        message.reply('❌ Invalid length. Please enter a number.');
        return;
      }
      data.length = length;
      session.step = STEPS.WIDTH;
      message.reply('**What is the package width in inches?**');
      break;

    case STEPS.WIDTH:
      const width = parseFloat(content);
      if (isNaN(width) || width <= 0) {
        message.reply('❌ Invalid width. Please enter a number.');
        return;
      }
      data.width = width;
      session.step = STEPS.HEIGHT;
      message.reply('**What is the package height in inches?**');
      break;

    case STEPS.HEIGHT:
      const height = parseFloat(content);
      if (isNaN(height) || height <= 0) {
        message.reply('❌ Invalid height. Please enter a number.');
        return;
      }
      data.height = height;
      
      // Now get available rates
      await message.reply('⏳ Getting available shipping rates... Please wait.');
      await getRatesAndPrompt(message, session);
      break;

    case STEPS.SELECT_RATE:
      const selection = parseInt(content);
      if (isNaN(selection) || selection < 1 || selection > data.rates.length) {
        message.reply(`❌ Invalid selection. Please enter a number between 1 and ${data.rates.length}`);
        return;
      }

      const selectedRate = data.rates[selection - 1];
      data.selectedRate = selectedRate;
      
      // Show confirmation summary
      session.step = STEPS.CONFIRM;
      const summary = buildSummary(data);
      message.reply(summary + '\n\n**Type `yes` to confirm and create the label, or `cancel` to abort.**');
      break;

    case STEPS.CONFIRM:
      const answer = content.toLowerCase();
      if (answer === 'yes' || answer === 'y') {
        await message.reply('⏳ Creating your label... Please wait.');
        await createLabel(message, data, data.selectedRate);
        sessions.delete(userId);
      } else if (answer === 'no' || answer === 'n' || answer === 'cancel') {
        sessions.delete(userId);
        message.reply('❌ Label creation cancelled. Type `!label` to start over.');
      } else {
        message.reply('Please type `yes` to confirm or `cancel` to abort.');
      }
      break;
  }
}

function buildSummary(data) {
  const deliveryDays = data.selectedRate._days ? ` (${data.selectedRate._days} days)` : '';

  return `📋 **SHIPPING LABEL SUMMARY**\n\n` +
    `**📍 Ship To:**\n` +
    `${data.name}\n` +
    `${data.street}\n` +
    `${data.city}, ${data.state} ${data.zip}\n\n` +
    `**📦 Package Details:**\n` +
    `Weight: ${data.weight} lbs\n` +
    `Dimensions: ${data.length}" × ${data.width}" × ${data.height}"\n\n` +
    `**🚚 Shipping Service:**\n` +
    `${data.selectedRate._service}${deliveryDays}\n\n` +
    `**💰 Total Cost: $${data.selectedRate._displayPrice}**`;
}

async function getRatesAndPrompt(message, session) {
  const { data } = session;

  try {
    // Fetch from both APIs in parallel; don't let one failure kill the other
    const [epResult, spResult] = await Promise.allSettled([
      easypost.Shipment.create({
        from_address: {
          name:    process.env.FROM_NAME,
          street1: process.env.FROM_STREET,
          city:    process.env.FROM_CITY,
          state:   process.env.FROM_STATE,
          zip:     process.env.FROM_ZIP,
          phone:   process.env.FROM_PHONE || '',
        },
        to_address: {
          name:    data.name,
          street1: data.street,
          city:    data.city,
          state:   data.state,
          zip:     data.zip,
        },
        parcel: {
          length: data.length,
          width:  data.width,
          height: data.height,
          weight: data.weight,
        },
      }),
      shippo.shipment.create({
        address_from: {
          name:    process.env.FROM_NAME,
          street1: process.env.FROM_STREET,
          city:    process.env.FROM_CITY,
          state:   process.env.FROM_STATE,
          zip:     process.env.FROM_ZIP,
          country: 'US',
          phone:   process.env.FROM_PHONE || '',
        },
        address_to: {
          name:    data.name,
          street1: data.street,
          city:    data.city,
          state:   data.state,
          zip:     data.zip,
          country: 'US',
        },
        parcels: [{
          length:        String(data.length),
          width:         String(data.width),
          height:        String(data.height),
          distance_unit: 'in',
          weight:        String(data.weight),
          mass_unit:     'lb',
        }],
        async: false,
      }),
    ]);

    // Normalize EasyPost rates
    const epRates = epResult.status === 'fulfilled'
      ? epResult.value.rates
          .filter(r => r.carrier === 'USPS')
          .map(r => ({
            _source:       'easypost',
            _rawRate:      r,
            _displayPrice: r.rate,
            _service:      r.service,
            _days:         r.delivery_days,
          }))
      : [];

    // Normalize Shippo rates
    const spRates = spResult.status === 'fulfilled'
      ? spResult.value.rates
          .filter(r => r.provider === 'USPS')
          .map(r => ({
            _source:       'shippo',
            _rawRate:      r,
            _displayPrice: r.amount,
            _service:      r.servicelevel.name,
            _days:         r.estimated_days,
          }))
      : [];

    // Sort by price, then deduplicate by service name keeping the cheapest
    const seen = new Set();
    const allRates = [...epRates, ...spRates]
      .sort((a, b) => parseFloat(a._displayPrice) - parseFloat(b._displayPrice))
      .filter(r => {
        if (seen.has(r._service)) return false;
        seen.add(r._service);
        return true;
      });

    if (allRates.length === 0) {
      throw new Error('No USPS rates available from either provider.');
    }

    // Store shipment refs for purchase routing later
    if (epResult.status === 'fulfilled') data.easypostShipment = epResult.value;
    if (spResult.status === 'fulfilled') data.shippoShipment   = spResult.value;
    data.rates = allRates;
    session.step = STEPS.SELECT_RATE;

    // Build rate selection message
    let rateMessage = '📋 **Available USPS shipping options:**\n\n';
    allRates.forEach((rate, index) => {
      const days = rate._days ? ` (${rate._days} days)` : '';
      rateMessage += `**${index + 1}.** ${rate._service} - **$${rate._displayPrice}**${days}\n`;
    });
    rateMessage += '\n**Reply with the number of your choice**';

    message.reply(rateMessage);

  } catch (error) {
    console.error('Error getting rates:', error);
    message.reply(`❌ Failed to get shipping rates: ${error.message}\n\nType \`!cancel\` to start over.`);
    sessions.delete(message.author.id);
  }
}

async function createLabel(message, data, selectedRate) {
  try {
    let labelUrl, trackingCode;

    if (selectedRate._source === 'easypost') {
      const raw = selectedRate._rawRate;
      const bought = await easypost.Shipment.buy(data.easypostShipment.id, raw.id);
      labelUrl     = bought.postage_label.label_url;
      trackingCode = bought.tracking_code;

    } else {
      const raw = selectedRate._rawRate;
      const tx  = await shippo.transaction.create({
        rate:            raw.object_id,
        label_file_type: 'PDF',
        async:           false,
      });
      if (tx.status !== 'SUCCESS') {
        throw new Error(`Label generation failed: ${JSON.stringify(tx.messages)}`);
      }
      labelUrl     = tx.label_url;
      trackingCode = tx.tracking_number;
    }

    const stats = loadStats();
    stats.totalPackages++;
    stats.byService[selectedRate._service] = (stats.byService[selectedRate._service] || 0) + 1;
    stats.byRecipient[data.name] = (stats.byRecipient[data.name] || 0) + 1;
    saveStats(stats);

    await message.reply(
      `✅ **Label created successfully!**\n\n` +
      `📍 To: ${data.name}, ${data.city}, ${data.state}\n` +
      `📦 Service: ${selectedRate._service}\n` +
      `🔢 Tracking: ${trackingCode}\n` +
      `💰 Cost: $${selectedRate._displayPrice}\n\n` +
      `**Label PDF:** ${labelUrl}\n\n` +
      `Download and print the label from the link above.`
    );

  } catch (error) {
    console.error('Error creating label:', error);
    message.reply(`❌ Failed to create label: ${error.message}\n\nTry again with \`!label\``);
  }
}

// Login to Discord
client.login(process.env.DISCORD_TOKEN);