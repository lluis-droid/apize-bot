require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

// storage stuff
const serverConfigs = new Map();
const devModeServers = new Set();
const applications = new Map();
const submissions = new Map();
const votes = new Map();

const DEV_CODE = '112233112233';
const EMBED_COLOR = '#65a2c4';

const DEFAULT_QUESTIONS = [
  { question: "Why do you want to apply for this position?", type: "text" },
  { question: "What experience do you have related to this role?", type: "text" },
  { question: "What would you bring to the team?", type: "text" },
  { question: "How many hours per week can you dedicate?", type: "text" }
];

function createEmbed(title, description, color = EMBED_COLOR) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp()
    .setFooter({ text: 'Application System' });
}

function isServerConfigured(guildId) {
  return serverConfigs.has(guildId);
}

// check if someone can manage apps
function hasPermission(guildId, userId, memberRoles) {
  if (!serverConfigs.has(guildId)) return false;
  const config = serverConfigs.get(guildId);
  
  // admin users always have perms
  if (config.adminUsers.includes(userId)) return true;
  
  // check admin roles
  const memberRoleIds = Array.from(memberRoles.cache.keys());
  return config.adminRoles.some(roleId => memberRoleIds.includes(roleId));
}

// check voting perms
function canVote(guildId, userId, memberRoles) {
  if (!serverConfigs.has(guildId)) return false;
  const config = serverConfigs.get(guildId);
  
  // admin users can vote too
  if (config.adminUsers && config.adminUsers.includes(userId)) return true;
  
  // voter roles
  const memberRoleIds = Array.from(memberRoles.cache.keys());
  if (config.voterRoles && config.voterRoles.length > 0) {
    return config.voterRoles.some(roleId => memberRoleIds.includes(roleId));
  }
  
  return false;
}

// only admin USERS can dismiss, not roles
function canDismiss(guildId, userId) {
  if (!serverConfigs.has(guildId)) return false;
  const config = serverConfigs.get(guildId);
  return config.adminUsers && config.adminUsers.includes(userId);
}

function isSpamOrTroll(answers) {
  const textAnswers = answers.filter(a => a.type === 'text').map(a => a.answer.toLowerCase());
  
  const tooShort = textAnswers.filter(a => a.length < 10).length >= textAnswers.length / 2;
  if (tooShort) return { isSpam: true, reason: "Answers too short" };
  
  const allSame = textAnswers.every(a => a === textAnswers[0]);
  if (allSame && textAnswers.length > 1) return { isSpam: true, reason: "All answers identical" };
  
  const hasSpam = textAnswers.some(a => /(.)\1{5,}/.test(a) || /[^\w\s]{10,}/.test(a));
  if (hasSpam) return { isSpam: true, reason: "Spam detected" };
  
  return { isSpam: false };
}

function getApplicationByName(guildId, name) {
  for (const [id, app] of applications) {
    if (app.guildId === guildId && app.name.toLowerCase() === name.toLowerCase()) {
      return { id, app };
    }
  }
  return null;
}

async function registerCommands() {
  if (!process.env.CLIENT_ID) {
    console.log('CLIENT_ID not found in .env');
    console.log('Use DevMode: 112233112233');
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('conf')
      .setDescription('Configure bot settings')
      .addStringOption(option =>
        option.setName('adminroles')
          .setDescription('Admin roles (mention or IDs, comma separated)')
          .setRequired(false))
      .addStringOption(option =>
        option.setName('adminusers')
          .setDescription('Admin users with full permissions (mention or IDs)')
          .setRequired(false))
      .addStringOption(option =>
        option.setName('voterroles')
          .setDescription('Roles that can vote on applications (mention or IDs)')
          .setRequired(false))
      .addChannelOption(option =>
        option.setName('modchannel')
          .setDescription('Channel for reviewing applications')
          .setRequired(false)),
    
    new SlashCommandBuilder()
      .setName('setupnew')
      .setDescription('Create a new application form'),
    
    new SlashCommandBuilder()
      .setName('edit')
      .setDescription('Edit an existing application')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Application name to edit')
          .setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('remove')
      .setDescription('Remove an application')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Application name to remove')
          .setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('end')
      .setDescription('End an application immediately')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Application name to end')
          .setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('View status of an application')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Application name (leave empty for all)')
          .setRequired(false)),
    
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('View all available commands'),
    
    new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check bot latency')
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('registering commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('commands ready');
  } catch (error) {
    console.error('error:', error);
  }
}

client.once('clientReady', async () => {
  console.log(`bot online: ${client.user.tag}`);
  await registerCommands();
});

async function setupNewApplication(interaction) {
  const isSlash = interaction.isChatInputCommand && interaction.isChatInputCommand();
  const user = interaction.user;
  const channel = interaction.channel;
  
  try {
    const startEmbed = createEmbed(
      '📝 Application Setup',
      'Let\'s create a new application form!\n\nCheck your DMs.'
    );
    await user.send({ embeds: [startEmbed] });
    
    if (isSlash) {
      await interaction.reply({ 
        embeds: [createEmbed('✅ Setup Started', 'Check your DMs!')],
        flags: MessageFlags.Ephemeral 
      });
    } else {
      await channel.send({ content: `<@${user.id}> Check your DMs!` }).then(msg => setTimeout(() => msg.delete(), 5000));
    }
  } catch (error) {
    const errorMsg = 'Can\'t send you DMs. Enable DMs from server members first.';
    if (isSlash) {
      return interaction.reply({ 
        embeds: [createEmbed('❌ Error', errorMsg, '#ff0000')],
        flags: MessageFlags.Ephemeral 
      });
    } else {
      return channel.send({ content: `<@${user.id}> ${errorMsg}` }).then(msg => setTimeout(() => msg.delete(), 10000));
    }
  }

  const filter = m => m.author.id === user.id;
  const dmChannel = user.dmChannel;
  
  try {
    await dmChannel.send({ embeds: [createEmbed('Step 1/7', '📌 Enter a name for this application:\n\n*Example: Staff Application*')] });
    const nameMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const name = nameMsg.first().content;

    await dmChannel.send({ embeds: [createEmbed('Step 2/7', '📄 Enter the description:\n\n*This will be shown to applicants*')] });
    const descMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const description = descMsg.first().content;

    await dmChannel.send({ embeds: [createEmbed('Step 3/7', '📢 Enter the **Channel ID** where application will be posted:\n\n*Right-click channel → Copy Channel ID*')] });
    const channelMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const targetChannel = await channel.guild.channels.fetch(channelMsg.first().content.trim()).catch(() => null);
    if (!targetChannel) {
      await dmChannel.send({ embeds: [createEmbed('❌ Error', 'Invalid channel ID', '#ff0000')] });
      return;
    }

    await dmChannel.send({ embeds: [createEmbed('Step 4/7', '⏰ Duration:\n\n**Examples:**\n• `3 days`\n• `1 week`\n• `24 hours`')] });
    const durationMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const durationText = durationMsg.first().content.toLowerCase();
    
    let durationMs = 0;
    const daysMatch = durationText.match(/(\d+)\s*days?/);
    const weeksMatch = durationText.match(/(\d+)\s*weeks?/);
    const hoursMatch = durationText.match(/(\d+)\s*hours?/);
    
    if (daysMatch) durationMs = parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
    else if (weeksMatch) durationMs = parseInt(weeksMatch[1]) * 7 * 24 * 60 * 60 * 1000;
    else if (hoursMatch) durationMs = parseInt(hoursMatch[1]) * 60 * 60 * 1000;
    else {
      await dmChannel.send({ embeds: [createEmbed('❌ Error', 'Invalid format', '#ff0000')] });
      return;
    }
    
    const deadline = new Date(Date.now() + durationMs);

    await dmChannel.send({ embeds: [createEmbed('Step 5/7', '👥 How many will be **accepted**?\n\n*Type "skip" for no limit*')] });
    const acceptedMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    let acceptedCount = null;
    if (acceptedMsg.first().content.toLowerCase() !== 'skip') {
      acceptedCount = parseInt(acceptedMsg.first().content);
      if (isNaN(acceptedCount)) {
        await dmChannel.send({ embeds: [createEmbed('❌ Error', 'Invalid number', '#ff0000')] });
        return;
      }
    }

    await dmChannel.send({ embeds: [createEmbed('Step 6/7', '🖼️ Image URL (optional):\n\n*Type "skip" to continue without image*')] });
    const imageMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const imageUrl = imageMsg.first().content.toLowerCase() === 'skip' ? null : imageMsg.first().content;

    await dmChannel.send({ embeds: [createEmbed('Step 7/7', '🔢 Max submissions per user:\n\n*Type "skip" for no limit*')] });
    const limitMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const submissionLimit = limitMsg.first().content.toLowerCase() === 'skip' ? null : parseInt(limitMsg.first().content);

    await dmChannel.send({ embeds: [createEmbed('Questions', '❓ Choose:\n\n• Type **"default"** - Use 4 standard questions\n• Type **"custom"** - Make your own')] });
    const qTypeMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const qType = qTypeMsg.first().content.toLowerCase();

    let questions = [];
    if (qType === 'default') {
      questions = DEFAULT_QUESTIONS;
    } else {
      const exampleEmbed = createEmbed(
        'Custom Questions',
        'Format:\n\n```\n1. Question | type\n2. Question | type\n```\n**Types:**\n• `text`\n• `image`\n\n**Example:**\n```\n1. Why join? | text\n2. Upload screenshot | image\n```'
      );
      await dmChannel.send({ embeds: [exampleEmbed] });
      const qListMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 300000 });
      const lines = qListMsg.first().content.split('\n');
      
      for (const line of lines) {
        const match = line.match(/^\d+\.\s*(.+?)\s*\|\s*(text|image)$/i);
        if (match) {
          questions.push({ question: match[1].trim(), type: match[2].toLowerCase() });
        }
      }
      
      if (questions.length === 0) {
        await dmChannel.send({ embeds: [createEmbed('❌ Error', 'No valid questions found', '#ff0000')] });
        return;
      }
    }

    const appId = `${channel.guild.id}-${Date.now()}`;
    applications.set(appId, {
      id: appId,
      guildId: channel.guild.id,
      name,
      description,
      channelId: targetChannel.id,
      deadline,
      acceptedCount,
      imageUrl,
      submissionLimit,
      questions,
      createdAt: Date.now(),
      closed: false
    });

    const msLeft = deadline.getTime() - Date.now();
    const daysLeft = Math.floor(msLeft / (24 * 60 * 60 * 1000));
    const hoursLeft = Math.floor((msLeft % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    
    let timeLeftText = '';
    if (daysLeft > 0) timeLeftText = `${daysLeft} day${daysLeft > 1 ? 's' : ''}`;
    else if (hoursLeft > 0) timeLeftText = `${hoursLeft} hour${hoursLeft > 1 ? 's' : ''}`;
    else timeLeftText = 'Less than 1 hour';

    const appEmbed = createEmbed(`📋 ${name}`, description);
    appEmbed.addFields(
      { name: '⏰ Deadline', value: `<t:${Math.floor(deadline.getTime() / 1000)}:F>\n${timeLeftText} left`, inline: true },
      { name: '👥 Positions', value: acceptedCount ? acceptedCount.toString() : 'Unlimited', inline: true },
      { name: '📝 Questions', value: questions.length.toString(), inline: true }
    );
    if (imageUrl) appEmbed.setImage(imageUrl);

    const applyButton = new ButtonBuilder()
      .setCustomId(`apply-${appId}`)
      .setLabel('📝 Apply Now')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(applyButton);

    await targetChannel.send({ embeds: [appEmbed], components: [row] });
    
    const successEmbed = createEmbed(
      '✅ Done',
      `**${name}** posted in ${targetChannel}\n\nID: \`${appId}\``
    );
    await dmChannel.send({ embeds: [successEmbed] });
    
    if (!isSlash) {
      await channel.send({ embeds: [createEmbed('✅ Success', `Application **${name}** created`)] });
    }

  } catch (error) {
    console.error('setup error:', error);
    await dmChannel.send({ embeds: [createEmbed('❌ Failed', 'Setup cancelled or timed out', '#ff0000')] });
  }
}

async function editApplication(interaction) {
  const isSlash = interaction.isChatInputCommand && interaction.isChatInputCommand();
  const appName = isSlash ? interaction.options.getString('name') : interaction.appName;
  const user = interaction.user;
  const guildId = interaction.guildId;

  const result = getApplicationByName(guildId, appName);
  if (!result) {
    const embed = createEmbed('❌ Not Found', `"${appName}" not found`, '#ff0000');
    if (isSlash) {
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      return interaction.channel.send({ embeds: [embed] });
    }
  }

  const { id: appId, app } = result;

  try {
    const startEmbed = createEmbed('✏️ Edit', `Editing: **${app.name}**\n\nCheck DMs`);
    await user.send({ embeds: [startEmbed] });
    
    if (isSlash) {
      await interaction.reply({ embeds: [createEmbed('✅ Started', 'Check DMs!')], flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    const errorMsg = 'Can\'t DM you. Enable DMs first.';
    if (isSlash) {
      return interaction.reply({ embeds: [createEmbed('❌ Error', errorMsg, '#ff0000')], flags: MessageFlags.Ephemeral });
    }
    return;
  }

  const filter = m => m.author.id === user.id;
  const dmChannel = user.dmChannel;

  try {
    const menuEmbed = createEmbed(
      '✏️ Edit Menu',
      `Current: **${app.name}**\n\nWhat to edit?\n\n\`1\` - Name\n\`2\` - Description\n\`3\` - Deadline\n\`4\` - Positions\n\`5\` - Image\n\`6\` - Questions\n\`cancel\` - Cancel`
    );
    await dmChannel.send({ embeds: [menuEmbed] });

    const choiceMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 60000 });
    const choice = choiceMsg.first().content.toLowerCase();

    if (choice === 'cancel') {
      return dmChannel.send({ embeds: [createEmbed('❌ Cancelled', 'Edit cancelled')] });
    }

    switch (choice) {
      case '1':
        await dmChannel.send({ embeds: [createEmbed('Edit Name', `Current: **${app.name}**\n\nNew name:`)] });
        const nameMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
        app.name = nameMsg.first().content;
        break;

      case '2':
        await dmChannel.send({ embeds: [createEmbed('Edit Description', `Current: **${app.description}**\n\nNew:`)] });
        const descMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
        app.description = descMsg.first().content;
        break;

      case '3':
        await dmChannel.send({ embeds: [createEmbed('Edit Deadline', `Current: <t:${Math.floor(app.deadline.getTime() / 1000)}:F>\n\nNew duration:`)] });
        const durMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
        const durationText = durMsg.first().content.toLowerCase();
        
        let durationMs = 0;
        const daysMatch = durationText.match(/(\d+)\s*days?/);
        const weeksMatch = durationText.match(/(\d+)\s*weeks?/);
        const hoursMatch = durationText.match(/(\d+)\s*hours?/);
        
        if (daysMatch) durationMs = parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
        else if (weeksMatch) durationMs = parseInt(weeksMatch[1]) * 7 * 24 * 60 * 60 * 1000;
        else if (hoursMatch) durationMs = parseInt(hoursMatch[1]) * 60 * 60 * 1000;
        else {
          return dmChannel.send({ embeds: [createEmbed('❌ Error', 'Invalid format', '#ff0000')] });
        }
        
        app.deadline = new Date(Date.now() + durationMs);
        break;

      case '4':
        await dmChannel.send({ embeds: [createEmbed('Edit Positions', `Current: **${app.acceptedCount || 'Unlimited'}**\n\nNew (or "skip"):`)] });
        const posMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
        app.acceptedCount = posMsg.first().content.toLowerCase() === 'skip' ? null : parseInt(posMsg.first().content);
        break;

      case '5':
        await dmChannel.send({ embeds: [createEmbed('Edit Image', `Current: ${app.imageUrl || 'None'}\n\nNew URL (or "skip"):`)] });
        const imgMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
        app.imageUrl = imgMsg.first().content.toLowerCase() === 'skip' ? null : imgMsg.first().content;
        break;

      case '6':
        await dmChannel.send({ embeds: [createEmbed('Edit Questions', 'Type "default" or custom:\n```\n1. Question | type\n```')] });
        const qMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 300000 });
        const qType = qMsg.first().content.toLowerCase();
        
        if (qType === 'default') {
          app.questions = DEFAULT_QUESTIONS;
        } else {
          const questions = [];
          const lines = qType.split('\n');
          for (const line of lines) {
            const match = line.match(/^\d+\.\s*(.+?)\s*\|\s*(text|image)$/i);
            if (match) {
              questions.push({ question: match[1].trim(), type: match[2].toLowerCase() });
            }
          }
          if (questions.length > 0) app.questions = questions;
        }
        break;

      default:
        return dmChannel.send({ embeds: [createEmbed('❌ Invalid', 'Invalid choice', '#ff0000')] });
    }

    applications.set(appId, app);
    await dmChannel.send({ embeds: [createEmbed('✅ Updated', `**${app.name}** updated`)] });

  } catch (error) {
    console.error('edit error:', error);
    await dmChannel.send({ embeds: [createEmbed('❌ Error', 'Edit timed out', '#ff0000')] });
  }
}

async function removeApplication(interaction) {
  const isSlash = interaction.isChatInputCommand && interaction.isChatInputCommand();
  const appName = isSlash ? interaction.options.getString('name') : interaction.appName;
  const guildId = interaction.guildId;

  const result = getApplicationByName(guildId, appName);
  if (!result) {
    const embed = createEmbed('❌ Not Found', `"${appName}" not found`, '#ff0000');
    if (isSlash) {
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      return interaction.channel.send({ embeds: [embed] });
    }
  }

  const { id: appId, app } = result;
  applications.delete(appId);

  const embed = createEmbed('✅ Removed', `**${app.name}** removed`);
  if (isSlash) {
    return interaction.reply({ embeds: [embed] });
  } else {
    return interaction.channel.send({ embeds: [embed] });
  }
}

async function endApplication(interaction) {
  const isSlash = interaction.isChatInputCommand && interaction.isChatInputCommand();
  const appName = isSlash ? interaction.options.getString('name') : interaction.appName;
  const guildId = interaction.guildId;

  const result = getApplicationByName(guildId, appName);
  if (!result) {
    const embed = createEmbed('❌ Not Found', `"${appName}" not found`, '#ff0000');
    if (isSlash) {
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      return interaction.channel.send({ embeds: [embed] });
    }
  }

  const { id: appId, app } = result;
  
  if (app.closed) {
    const embed = createEmbed('⚠️ Already Closed', `**${app.name}** already closed`, '#ffaa00');
    if (isSlash) {
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      return interaction.channel.send({ embeds: [embed] });
    }
  }

  await closeApplication(appId, app);

  const embed = createEmbed('✅ Ended', `**${app.name}** closed`);
  if (isSlash) {
    return interaction.reply({ embeds: [embed] });
  } else {
    return interaction.channel.send({ embeds: [embed] });
  }
}

async function showStatus(interaction) {
  const isSlash = interaction.isChatInputCommand && interaction.isChatInputCommand();
  const appName = isSlash ? interaction.options.getString('name') : interaction.appName;
  const guildId = interaction.guildId;

  if (appName) {
    const result = getApplicationByName(guildId, appName);
    if (!result) {
      const embed = createEmbed('❌ Not Found', `"${appName}" not found`, '#ff0000');
      if (isSlash) {
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } else {
        return interaction.channel.send({ embeds: [embed] });
      }
    }

    const { id: appId, app } = result;
    const appSubmissions = Array.from(submissions.entries())
      .filter(([id, sub]) => sub.appId === appId)
      .map(([id, sub]) => {
        const voteData = votes.get(id) || { accept: [], deny: [] };
        return {
          id,
          userId: sub.userId,
          acceptVotes: voteData.accept.length,
          denyVotes: voteData.deny.length
        };
      })
      .sort((a, b) => b.acceptVotes - a.acceptVotes);

    const statusEmbed = createEmbed(
      `📊 ${app.name}`,
      `**Status:** ${app.closed ? '🔴 Closed' : '🟢 Active'}\n**Deadline:** <t:${Math.floor(app.deadline.getTime() / 1000)}:R>\n**Positions:** ${app.acceptedCount || 'Unlimited'}\n**Submissions:** ${appSubmissions.length}`
    );

    if (appSubmissions.length > 0) {
      const topApplicants = appSubmissions.slice(0, 10).map((sub, i) => 
        `\`${i + 1}.\` <@${sub.userId}> - ✅ ${sub.acceptVotes} | ❌ ${sub.denyVotes}`
      ).join('\n');
      statusEmbed.addFields({ name: '🏆 Top Applicants', value: topApplicants });
    } else {
      statusEmbed.addFields({ name: '📭 No Submissions', value: 'None yet' });
    }

    if (isSlash) {
      return interaction.reply({ embeds: [statusEmbed] });
    } else {
      return interaction.channel.send({ embeds: [statusEmbed] });
    }
  } else {
    const guildApps = Array.from(applications.values()).filter(app => app.guildId === guildId);
    
    if (guildApps.length === 0) {
      const embed = createEmbed('📋 No Applications', 'No apps in this server');
      if (isSlash) {
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } else {
        return interaction.channel.send({ embeds: [embed] });
      }
    }

    const statusEmbed = createEmbed(
      '📋 All Applications',
      guildApps.map(app => {
        const subs = Array.from(submissions.values()).filter(s => s.appId === app.id).length;
        return `**${app.name}**\n${app.closed ? '🔴' : '🟢'} | 📝 ${subs} | ⏰ <t:${Math.floor(app.deadline.getTime() / 1000)}:R>`;
      }).join('\n\n')
    );

    if (isSlash) {
      return interaction.reply({ embeds: [statusEmbed] });
    } else {
      return interaction.channel.send({ embeds: [statusEmbed] });
    }
  }
}

async function showHelp(interaction) {
  const isSlash = interaction.isChatInputCommand && interaction.isChatInputCommand();
  
  const helpEmbed = createEmbed(
    '📚 Commands',
    'Available commands:'
  );
  
  helpEmbed.addFields(
    { 
      name: '⚙️ Config', 
      value: '`/conf` - Setup\n`/ping` - Latency',
      inline: false
    },
    { 
      name: '📝 Management', 
      value: '`/setupnew` - New app\n`/edit <name>` - Edit\n`/remove <name>` - Remove\n`/end <name>` - Close',
      inline: false
    },
    { 
      name: '📊 Info', 
      value: '`/status [name]` - Status\n`/help` - This menu',
      inline: false
    },
    {
      name: '💡 Permissions',
      value: '**Admin Users:** Full control\n**Admin Roles:** Manage apps\n**Voter Roles:** Vote only',
      inline: false
    }
  );

  if (isSlash) {
    return interaction.reply({ embeds: [helpEmbed], flags: MessageFlags.Ephemeral });
  } else {
    return interaction.channel.send({ embeds: [helpEmbed] });
  }
}

async function closeApplication(appId, app) {
  app.closed = true;
  
  const appSubmissions = Array.from(submissions.entries())
    .filter(([id, sub]) => sub.appId === appId)
    .map(([id, sub]) => {
      const voteData = votes.get(id) || { accept: [], deny: [] };
      return {
        id,
        userId: sub.userId,
        acceptVotes: voteData.accept.length,
        denyVotes: voteData.deny.length
      };
    })
    .sort((a, b) => b.acceptVotes - a.acceptVotes);

  const winners = app.acceptedCount ? appSubmissions.slice(0, app.acceptedCount) : appSubmissions.filter(s => s.acceptVotes > s.denyVotes);
  const losers = app.acceptedCount ? appSubmissions.slice(app.acceptedCount) : appSubmissions.filter(s => s.acceptVotes <= s.denyVotes);

  try {
    const channel = await client.channels.fetch(app.channelId);
    const winnerTags = winners.map(w => `<@${w.userId}>`).join(', ');
    
    const resultEmbed = createEmbed(
      '🎉 Application Closed',
      `**${app.name}** closed!\n\n**Accepted:**\n${winnerTags || 'None'}\n\nMods will contact you soon.`
    );
    resultEmbed.addFields(
      { name: '📊 Stats', value: `Total: ${appSubmissions.length}\nAccepted: ${winners.length}`, inline: true }
    );
    
    await channel.send({ embeds: [resultEmbed] });

    for (const winner of winners) {
      try {
        const user = await client.users.fetch(winner.userId);
        const winEmbed = createEmbed(
          '🎉 Congratulations!',
          `You've been **accepted** for:\n**${app.name}**\n\nMods will contact you soon.`
        );
        await user.send({ embeds: [winEmbed] });
      } catch (e) {
        console.log(`couldn't dm ${winner.userId}`);
      }
    }

    for (const loser of losers) {
      try {
        const user = await client.users.fetch(loser.userId);
        const loseEmbed = createEmbed(
          '📋 Update',
          `Thanks for applying to **${app.name}**.\n\nUnfortunately not selected this time. Feel free to apply again!`,
          '#ffaa00'
        );
        await user.send({ embeds: [loseEmbed] });
      } catch (e) {
        console.log(`couldn't dm ${loser.userId}`);
      }
    }
  } catch (error) {
    console.error('error closing app:', error);
  }
}

client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    await handleButton(interaction);
    return;
  }
  
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, user, member } = interaction;

  if (commandName === 'ping') {
    const embed = createEmbed('🏓 Pong!', `**Latency:** ${client.ws.ping}ms\n**Status:** Online`);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'help') {
    return showHelp(interaction);
  }

  if (commandName === 'conf') {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
      const embed = createEmbed('❌ No Permission', 'Admins only', '#ff0000');
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const adminRolesInput = interaction.options.getString('adminroles');
    const adminUsersInput = interaction.options.getString('adminusers');
    const voterRolesInput = interaction.options.getString('voterroles');
    const modChannel = interaction.options.getChannel('modchannel');

    if (!adminRolesInput && !adminUsersInput && !voterRolesInput && !modChannel) {
      const embed = createEmbed('⚠️ Missing Params', 'Provide at least one param', '#ffaa00');
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const config = serverConfigs.get(guildId) || { adminRoles: [], adminUsers: [], voterRoles: [], modChannel: null };

    if (adminRolesInput) {
      const roleIds = adminRolesInput.match(/\d{17,19}/g) || [];
      config.adminRoles = [...new Set([...config.adminRoles, ...roleIds])];
    }

    if (adminUsersInput) {
      const userIds = adminUsersInput.match(/\d{17,19}/g) || [];
      config.adminUsers = [...new Set([...config.adminUsers, ...userIds])];
    }

    if (voterRolesInput) {
      const roleIds = voterRolesInput.match(/\d{17,19}/g) || [];
      config.voterRoles = [...new Set([...config.voterRoles, ...roleIds])];
    }

    if (modChannel) {
      config.modChannel = modChannel.id;
    }

    serverConfigs.set(guildId, config);

    const adminRolesList = config.adminRoles.map(id => `<@&${id}>`).join(', ') || 'None';
    const adminUsersList = config.adminUsers.map(id => `<@${id}>`).join(', ') || 'None';
    const voterRolesList = config.voterRoles.map(id => `<@&${id}>`).join(', ') || 'None';
    const modChannelText = config.modChannel ? `<#${config.modChannel}>` : 'Not set';

    const embed = createEmbed(
      '✅ Config Saved',
      'Settings updated'
    );
    embed.addFields(
      { name: '👥 Admin Roles', value: adminRolesList, inline: false },
      { name: '👤 Admin Users (Full Perms)', value: adminUsersList, inline: false },
      { name: '🗳️ Voter Roles', value: voterRolesList, inline: false },
      { name: '📢 Mod Channel', value: modChannelText, inline: false }
    );

    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'status') {
    if (!isServerConfigured(guildId)) {
      const embed = createEmbed('⚠️ Setup Required', 'Use `/conf` first', '#ffaa00');
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (!hasPermission(guildId, user.id, member.roles)) {
      const embed = createEmbed('❌ No Permission', 'Admins only', '#ff0000');
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    return showStatus(interaction);
  }

  if (!isServerConfigured(guildId)) {
    const embed = createEmbed('⚠️ Setup Required', 'Use `/conf` first', '#ffaa00');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (!hasPermission(guildId, user.id, member.roles)) {
    const embed = createEmbed('❌ No Permission', 'Admins only', '#ff0000');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (commandName === 'setupnew') {
    await setupNewApplication(interaction);
  }

  if (commandName === 'edit') {
    await editApplication(interaction);
  }

  if (commandName === 'remove') {
    await removeApplication(interaction);
  }

  if (commandName === 'end') {
    await endApplication(interaction);
  }
});

async function handleButton(interaction) {
  const customId = interaction.customId;
  
  if (customId.startsWith('apply-')) {
    const appId = customId.replace('apply-', '');
    const app = applications.get(appId);
    
    if (!app) {
      return interaction.reply({ 
        embeds: [createEmbed('❌ Error', 'Application not found', '#ff0000')],
        flags: MessageFlags.Ephemeral 
      });
    }

    if (app.closed) {
      return interaction.reply({ 
        embeds: [createEmbed('❌ Closed', 'No longer accepting submissions', '#ff0000')],
        flags: MessageFlags.Ephemeral 
      });
    }

    if (app.submissionLimit) {
      const userSubmissions = Array.from(submissions.values())
        .filter(s => s.appId === appId && s.userId === interaction.user.id);
      
      if (userSubmissions.length >= app.submissionLimit) {
        return interaction.reply({ 
          embeds: [createEmbed('❌ Limit Reached', `Max ${app.submissionLimit} submissions`, '#ff0000')],
          flags: MessageFlags.Ephemeral 
        });
      }
    }

    await interaction.reply({ 
      embeds: [createEmbed('✅ Starting', 'Check DMs!')],
      flags: MessageFlags.Ephemeral 
    });

    try {
      const user = interaction.user;
      const startEmbed = createEmbed(
        '📝 Application',
        `Applying for: **${app.name}**\n\nAnswer the questions below.`
      );
      await user.send({ embeds: [startEmbed] });

      const answers = [];
      for (let i = 0; i < app.questions.length; i++) {
        const q = app.questions[i];
        const questionEmbed = createEmbed(
          `Question ${i + 1}/${app.questions.length}`,
          `${q.question}\n\n${q.type === 'image' ? '📷 Upload image' : '✍️ Type answer'}`
        );
        await user.send({ embeds: [questionEmbed] });

        const filter = m => m.author.id === user.id;
        const collected = await user.dmChannel.awaitMessages({ filter, max: 1, time: 600000 });
        const response = collected.first();

        if (q.type === 'image') {
          if (response.attachments.size === 0) {
            await user.send({ embeds: [createEmbed('❌ Invalid', 'Image required', '#ff0000')] });
            return;
          }
          answers.push({ question: q.question, answer: response.attachments.first().url, type: 'image' });
        } else {
          answers.push({ question: q.question, answer: response.content, type: 'text' });
        }
      }

      const spamCheck = isSpamOrTroll(answers);
      
      if (spamCheck.isSpam) {
        await user.send({ 
          embeds: [createEmbed(
            '❌ Rejected',
            `Auto-rejected.\n\n**Reason:** ${spamCheck.reason}\n\nSubmit a real application.`,
            '#ff0000'
          )] 
        });
        return;
      }

      await user.send({ 
        embeds: [createEmbed(
          '✅ Submitted',
          `Thanks for applying to **${app.name}**!\n\nYour app was sent to mods. We'll contact you soon.`
        )] 
      });

      const config = serverConfigs.get(app.guildId);
      if (!config || !config.modChannel) return;

      const modChannel = await client.channels.fetch(config.modChannel);
      
      const reviewEmbed = createEmbed(
        `📋 New: ${app.name}`,
        `**Applicant:** ${user.tag} (<@${user.id}>)\n**ID:** ${user.id}\n**Time:** <t:${Math.floor(Date.now() / 1000)}:R>`
      );
      
      for (const ans of answers) {
        if (ans.type === 'text') {
          reviewEmbed.addFields({ name: `❓ ${ans.question}`, value: ans.answer.substring(0, 1024) || 'No answer', inline: false });
        } else {
          reviewEmbed.addFields({ name: `📷 ${ans.question}`, value: `[Image](${ans.answer})`, inline: false });
        }
      }

      if (answers.find(a => a.type === 'image')) {
        reviewEmbed.setImage(answers.find(a => a.type === 'image').answer);
      }

      const submissionId = `${appId}-${user.id}-${Date.now()}`;
      submissions.set(submissionId, {
        appId,
        userId: user.id,
        answers,
        timestamp: Date.now()
      });
      votes.set(submissionId, { accept: [], deny: [] });

      const acceptBtn = new ButtonBuilder()
        .setCustomId(`vote-accept-${submissionId}`)
        .setLabel('✅ Accept')
        .setStyle(ButtonStyle.Success);

      const denyBtn = new ButtonBuilder()
        .setCustomId(`vote-deny-${submissionId}`)
        .setLabel('❌ Deny')
        .setStyle(ButtonStyle.Danger);

      const dismissBtn = new ButtonBuilder()
        .setCustomId(`dismiss-${submissionId}`)
        .setLabel('🗑️ Dismiss')
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder().addComponents(acceptBtn, denyBtn, dismissBtn);

      await modChannel.send({ embeds: [reviewEmbed], components: [row] });

    } catch (error) {
      console.error('app error:', error);
      try {
        await interaction.user.send({ 
          embeds: [createEmbed('❌ Error', 'Something went wrong', '#ff0000')] 
        });
      } catch (e) {}
    }
  }

  if (customId.startsWith('vote-')) {
    const parts = customId.split('-');
    const voteAction = parts[1];
    const submissionId = parts.slice(2).join('-');
    
    const voteData = votes.get(submissionId);
    
    if (!voteData) {
      return interaction.reply({ 
        embeds: [createEmbed('❌ Error', 'Vote data not found', '#ff0000')],
        flags: MessageFlags.Ephemeral 
      });
    }

    if (!canVote(interaction.guildId, interaction.user.id, interaction.member.roles)) {
      return interaction.reply({ 
        embeds: [createEmbed('❌ No Permission', 'Can\'t vote', '#ff0000')],
        flags: MessageFlags.Ephemeral 
      });
    }

    const userId = interaction.user.id;
    
    voteData.accept = voteData.accept.filter(id => id !== userId);
    voteData.deny = voteData.deny.filter(id => id !== userId);
    
    voteData[voteAction].push(userId);
    votes.set(submissionId, voteData);

    const voteEmbed = createEmbed(
      '✅ Voted',
      `Your vote: ${voteAction === 'accept' ? '✅ **Accept**' : '❌ **Deny**'}\n\n**Votes:**\n✅ ${voteData.accept.length}\n❌ ${voteData.deny.length}`
    );

    await interaction.reply({ 
      embeds: [voteEmbed],
      flags: MessageFlags.Ephemeral 
    });

    try {
      const msg = interaction.message;
      const updatedEmbed = EmbedBuilder.from(msg.embeds[0]);
      updatedEmbed.setFooter({ text: `Votes: ✅ ${voteData.accept.length} | ❌ ${voteData.deny.length}` });
      await msg.edit({ embeds: [updatedEmbed] });
    } catch (e) {
      console.error('couldn\'t update votes:', e);
    }
  }

  if (customId.startsWith('dismiss-')) {
    const submissionId = customId.replace('dismiss-', '');
    
    if (!canDismiss(interaction.guildId, interaction.user.id)) {
      return interaction.reply({ 
        embeds: [createEmbed('❌ No Permission', 'Only admin users can dismiss', '#ff0000')],
        flags: MessageFlags.Ephemeral 
      });
    }

    try {
      await interaction.message.delete();
      
      submissions.delete(submissionId);
      votes.delete(submissionId);
      
      await interaction.reply({ 
        embeds: [createEmbed('✅ Dismissed', 'Submission removed')],
        flags: MessageFlags.Ephemeral 
      });
    } catch (error) {
      console.error('error dismissing:', error);
      await interaction.reply({ 
        embeds: [createEmbed('❌ Error', 'Couldn\'t dismiss', '#ff0000')],
        flags: MessageFlags.Ephemeral 
      });
    }
  }
}

// check expired apps
setInterval(async () => {
  for (const [appId, app] of applications) {
    if (Date.now() >= app.deadline.getTime() && !app.closed) {
      await closeApplication(appId, app);
    }
  }
}, 60000);

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const guildId = message.guild.id;

  if (message.content === DEV_CODE) {
    devModeServers.add(guildId);
    const embed = createEmbed('🔧 Dev Mode', 'Prefix commands enabled. Use `!help`');
    return message.reply({ embeds: [embed] });
  }

  if (!devModeServers.has(guildId)) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'ping') {
    const embed = createEmbed('🏓 Pong!', `**Latency:** ${client.ws.ping}ms`);
    return message.reply({ embeds: [embed] });
  }

  if (command === 'help') {
    const mockInteraction = {
      user: message.author,
      channel: message.channel,
      isChatInputCommand: () => false
    };
    return showHelp(mockInteraction);
  }

  if (command === 'conf') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      const embed = createEmbed('❌ No Permission', 'Admins only', '#ff0000');
      return message.reply({ embeds: [embed] });
    }

    const embed = createEmbed(
      '⚙️ Config',
      'Send config in this format:\n\n```\nadminroles: @Role1, @Role2\nadminusers: @User1, @User2\nvoterroles: @VoterRole\nchannel: #modchannel\n```\n\n**Note:** Admin users get full perms'
    );
    await message.reply({ embeds: [embed] });

    const filter = m => m.author.id === message.author.id;
    const collected = await message.channel.awaitMessages({ filter, max: 1, time: 60000 }).catch(() => null);

    if (!collected) {
      return message.reply({ embeds: [createEmbed('⏱️ Timeout', 'Cancelled', '#ff0000')] });
    }

    const response = collected.first().content;
    const config = serverConfigs.get(guildId) || { adminRoles: [], adminUsers: [], voterRoles: [], modChannel: null };

    const adminRoleMatches = response.match(/adminroles?:\s*([^|\n]+)/i);
    if (adminRoleMatches) {
      const roleIds = adminRoleMatches[1].match(/\d{17,19}/g) || [];
      config.adminRoles = [...new Set([...config.adminRoles, ...roleIds])];
    }

    const adminUserMatches = response.match(/adminusers?:\s*([^|\n]+)/i);
    if (adminUserMatches) {
      const userIds = adminUserMatches[1].match(/\d{17,19}/g) || [];
      config.adminUsers = [...new Set([...config.adminUsers, ...userIds])];
    }

    const voterRoleMatches = response.match(/voterroles?:\s*([^|\n]+)/i);
    if (voterRoleMatches) {
      const roleIds = voterRoleMatches[1].match(/\d{17,19}/g) || [];
      config.voterRoles = [...new Set([...config.voterRoles, ...roleIds])];
    }

    const channelMatches = response.match(/channels?:\s*<#(\d+)>/i);
    if (channelMatches) {
      config.modChannel = channelMatches[1];
    }

    serverConfigs.set(guildId, config);

    const adminRolesList = config.adminRoles.map(id => `<@&${id}>`).join(', ') || 'None';
    const adminUsersList = config.adminUsers.map(id => `<@${id}>`).join(', ') || 'None';
    const voterRolesList = config.voterRoles.map(id => `<@&${id}>`).join(', ') || 'None';
    const modChannelText = config.modChannel ? `<#${config.modChannel}>` : 'Not set';

    const successEmbed = createEmbed(
      '✅ Saved',
      'Config updated'
    );
    successEmbed.addFields(
      { name: '👥 Admin Roles', value: adminRolesList, inline: false },
      { name: '👤 Admin Users', value: adminUsersList, inline: false },
      { name: '🗳️ Voter Roles', value: voterRolesList, inline: false },
      { name: '📢 Mod Channel', value: modChannelText, inline: false }
    );

    return message.reply({ embeds: [successEmbed] });
  }

  if (command === 'setupnew') {
    if (!isServerConfigured(guildId)) {
      return message.reply({ embeds: [createEmbed('⚠️ Setup Required', 'Use `!conf` first', '#ffaa00')] });
    }

    if (!hasPermission(guildId, message.author.id, message.member.roles)) {
      return message.reply({ embeds: [createEmbed('❌ No Permission', 'Admins only', '#ff0000')] });
    }

    const mockInteraction = {
      user: message.author,
      guildId: message.guildId,
      channel: message.channel,
      isChatInputCommand: () => false
    };
    await setupNewApplication(mockInteraction);
  }

  if (command === 'edit') {
    if (!isServerConfigured(guildId)) {
      return message.reply({ embeds: [createEmbed('⚠️ Setup Required', 'Use `!conf` first', '#ffaa00')] });
    }

    if (!hasPermission(guildId, message.author.id, message.member.roles)) {
      return message.reply({ embeds: [createEmbed('❌ No Permission', 'Admins only', '#ff0000')] });
    }

    if (args.length === 0) {
      return message.reply({ embeds: [createEmbed('⚠️ Missing Name', 'Usage: `!edit <name>`', '#ffaa00')] });
    }

    const mockInteraction = {
      user: message.author,
      guildId: message.guildId,
      channel: message.channel,
      appName: args.join(' '),
      isChatInputCommand: () => false
    };
    await editApplication(mockInteraction);
  }

  if (command === 'remove') {
    if (!isServerConfigured(guildId)) {
      return message.reply({ embeds: [createEmbed('⚠️ Setup Required', 'Use `!conf` first', '#ffaa00')] });
    }

    if (!hasPermission(guildId, message.author.id, message.member.roles)) {
      return message.reply({ embeds: [createEmbed('❌ No Permission', 'Admins only', '#ff0000')] });
    }

    if (args.length === 0) {
      return message.reply({ embeds: [createEmbed('⚠️ Missing Name', 'Usage: `!remove <name>`', '#ffaa00')] });
    }

    const mockInteraction = {
      user: message.author,
      guildId: message.guildId,
      channel: message.channel,
      appName: args.join(' '),
      isChatInputCommand: () => false
    };
    await removeApplication(mockInteraction);
  }

  if (command === 'end') {
    if (!isServerConfigured(guildId)) {
      return message.reply({ embeds: [createEmbed('⚠️ Setup Required', 'Use `!conf` first', '#ffaa00')] });
    }

    if (!hasPermission(guildId, message.author.id, message.member.roles)) {
      return message.reply({ embeds: [createEmbed('❌ No Permission', 'Admins only', '#ff0000')] });
    }

    if (args.length === 0) {
      return message.reply({ embeds: [createEmbed('⚠️ Missing Name', 'Usage: `!end <name>`', '#ffaa00')] });
    }

    const mockInteraction = {
      user: message.author,
      guildId: message.guildId,
      channel: message.channel,
      appName: args.join(' '),
      isChatInputCommand: () => false
    };
    await endApplication(mockInteraction);
  }

  if (command === 'status') {
    if (!isServerConfigured(guildId)) {
      return message.reply({ embeds: [createEmbed('⚠️ Setup Required', 'Use `!conf` first', '#ffaa00')] });
    }

    if (!hasPermission(guildId, message.author.id, message.member.roles)) {
      return message.reply({ embeds: [createEmbed('❌ No Permission', 'Admins only', '#ff0000')] });
    }

    const mockInteraction = {
      user: message.author,
      guildId: message.guildId,
      channel: message.channel,
      appName: args.length > 0 ? args.join(' ') : null,
      isChatInputCommand: () => false
    };
    await showStatus(mockInteraction);
  }
});

client.login(process.env.DISCORD_TOKEN);
