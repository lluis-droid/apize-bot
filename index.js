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

function hasPermission(guildId, userId, memberRoles) {
  if (!serverConfigs.has(guildId)) return false;
  const config = serverConfigs.get(guildId);
  if (config.adminUsers.includes(userId)) return true;
  const memberRoleIds = Array.from(memberRoles.cache.keys());
  return config.adminRoles.some(roleId => memberRoleIds.includes(roleId));
}

function isSpamOrTroll(answers) {
  const textAnswers = answers.filter(a => a.type === 'text').map(a => a.answer.toLowerCase());
  
  const tooShort = textAnswers.filter(a => a.length < 10).length >= textAnswers.length / 2;
  if (tooShort) return { isSpam: true, reason: "Answers too short (less than 10 characters)" };
  
  const allSame = textAnswers.every(a => a === textAnswers[0]);
  if (allSame && textAnswers.length > 1) return { isSpam: true, reason: "All answers are identical" };
  
  const hasSpam = textAnswers.some(a => /(.)\1{5,}/.test(a) || /[^\w\s]{10,}/.test(a));
  if (hasSpam) return { isSpam: true, reason: "Spam or excessive special characters detected" };
  
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
    console.log('⚠️  CLIENT_ID not found');
    console.log('⚠️  Use DevMode: 112233112233');
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('conf')
      .setDescription('Configure bot settings - admin roles, users and mod channel')
      .addStringOption(option =>
        option.setName('roles')
          .setDescription('Admin roles (mention or IDs, comma separated)')
          .setRequired(false))
      .addStringOption(option =>
        option.setName('users')
          .setDescription('Admin users (mention or IDs, comma separated)')
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
    console.log('🔄 Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered!');
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

client.once('clientReady', async () => {
  console.log(`✅ ${client.user.tag} connected`);
  await registerCommands();
});

async function setupNewApplication(interaction) {
  const isSlash = interaction.isChatInputCommand && interaction.isChatInputCommand();
  const user = interaction.user;
  const channel = interaction.channel;
  
  try {
    const startEmbed = createEmbed(
      '📝 Application Setup',
      'Let\'s create a new application form!\n\nI\'ll guide you through the setup process. Please check your DMs.'
    );
    await user.send({ embeds: [startEmbed] });
    
    if (isSlash) {
      await interaction.reply({ 
        embeds: [createEmbed('✅ Setup Started', 'Check your DMs to continue!')],
        flags: MessageFlags.Ephemeral 
      });
    } else {
      await channel.send({ content: `<@${user.id}> Check your DMs!` }).then(msg => setTimeout(() => msg.delete(), 5000));
    }
  } catch (error) {
    const errorMsg = 'I can\'t send you DMs. Please enable DMs from server members in your privacy settings.';
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
    await dmChannel.send({ embeds: [createEmbed('Step 1/7 - Application Name', '📌 Enter a unique name for this application:\n\n*Example: Staff Application, Moderator Recruitment*')] });
    const nameMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const name = nameMsg.first().content;

    await dmChannel.send({ embeds: [createEmbed('Step 2/7 - Description', '📄 Enter the application description:\n\n*This will be shown to applicants*')] });
    const descMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const description = descMsg.first().content;

    await dmChannel.send({ embeds: [createEmbed('Step 3/7 - Channel', '📢 Enter the **Channel ID** where the application will be posted:\n\n*Right-click a channel → Copy Channel ID*')] });
    const channelMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const targetChannel = await channel.guild.channels.fetch(channelMsg.first().content.trim()).catch(() => null);
    if (!targetChannel) {
      await dmChannel.send({ embeds: [createEmbed('❌ Error', 'Invalid channel ID. Setup cancelled.', '#ff0000')] });
      return;
    }

    await dmChannel.send({ embeds: [createEmbed('Step 4/7 - Duration', '⏰ Enter the application duration:\n\n**Examples:**\n• `3 days`\n• `1 week`\n• `24 hours`')] });
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
      await dmChannel.send({ embeds: [createEmbed('❌ Error', 'Invalid duration format. Please use: "X days", "X weeks", or "X hours"', '#ff0000')] });
      return;
    }
    
    const deadline = new Date(Date.now() + durationMs);

    await dmChannel.send({ embeds: [createEmbed('Step 5/7 - Positions', '👥 How many applicants will be **accepted**?\n\n*Type "skip" for no limit*')] });
    const acceptedMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    let acceptedCount = null;
    if (acceptedMsg.first().content.toLowerCase() !== 'skip') {
      acceptedCount = parseInt(acceptedMsg.first().content);
      if (isNaN(acceptedCount)) {
        await dmChannel.send({ embeds: [createEmbed('❌ Error', 'Invalid number. Setup cancelled.', '#ff0000')] });
        return;
      }
    }

    await dmChannel.send({ embeds: [createEmbed('Step 6/7 - Image (Optional)', '🖼️ Enter an image URL for the application:\n\n*Type "skip" to continue without an image*')] });
    const imageMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const imageUrl = imageMsg.first().content.toLowerCase() === 'skip' ? null : imageMsg.first().content;

    await dmChannel.send({ embeds: [createEmbed('Step 7/7 - Submission Limit', '🔢 Maximum submissions per user:\n\n*Type "skip" for no limit*')] });
    const limitMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const submissionLimit = limitMsg.first().content.toLowerCase() === 'skip' ? null : parseInt(limitMsg.first().content);

    await dmChannel.send({ embeds: [createEmbed('Questions Setup', '❓ Choose question type:\n\n• Type **"default"** - Use 4 standard questions\n• Type **"custom"** - Create your own questions')] });
    const qTypeMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
    const qType = qTypeMsg.first().content.toLowerCase();

    let questions = [];
    if (qType === 'default') {
      questions = DEFAULT_QUESTIONS;
    } else {
      const exampleEmbed = createEmbed(
        'Custom Questions Format',
        'List your questions in this format:\n\n```\n1. Question text | type\n2. Question text | type\n3. Question text | type\n```\n**Available types:**\n• `text` - Text response\n• `image` - Image upload\n\n**Example:**\n```\n1. Why do you want to join? | text\n2. Upload a screenshot | image\n```'
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
        await dmChannel.send({ embeds: [createEmbed('❌ Error', 'No valid questions found. Setup cancelled.', '#ff0000')] });
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
    if (daysLeft > 0) timeLeftText = `${daysLeft} day${daysLeft > 1 ? 's' : ''} remaining`;
    else if (hoursLeft > 0) timeLeftText = `${hoursLeft} hour${hoursLeft > 1 ? 's' : ''} remaining`;
    else timeLeftText = 'Less than 1 hour remaining';

    const appEmbed = createEmbed(`📋 ${name}`, description);
    appEmbed.addFields(
      { name: '⏰ Deadline', value: `<t:${Math.floor(deadline.getTime() / 1000)}:F>\n${timeLeftText}`, inline: true },
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
      '✅ Application Created Successfully',
      `**${name}** has been posted in ${targetChannel}\n\n**Application ID:** \`${appId}\``
    );
    await dmChannel.send({ embeds: [successEmbed] });
    
    if (!isSlash) {
      await channel.send({ embeds: [createEmbed('✅ Success', `Application **${name}** has been created and posted!`)] });
    }

  } catch (error) {
    console.error('Setup error:', error);
    await dmChannel.send({ embeds: [createEmbed('❌ Setup Failed', 'Setup was cancelled or timed out. Please try again.', '#ff0000')] });
  }
}

async function editApplication(interaction) {
  const isSlash = interaction.isChatInputCommand && interaction.isChatInputCommand();
  const appName = isSlash ? interaction.options.getString('name') : interaction.appName;
  const user = interaction.user;
  const guildId = interaction.guildId;

  const result = getApplicationByName(guildId, appName);
  if (!result) {
    const embed = createEmbed('❌ Not Found', `Application "${appName}" not found.`, '#ff0000');
    if (isSlash) {
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      return interaction.channel.send({ embeds: [embed] });
    }
  }

  const { id: appId, app } = result;

  try {
    const startEmbed = createEmbed('✏️ Edit Application', `Editing: **${app.name}**\n\nCheck your DMs to continue.`);
    await user.send({ embeds: [startEmbed] });
    
    if (isSlash) {
      await interaction.reply({ embeds: [createEmbed('✅ Edit Started', 'Check your DMs!')], flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    const errorMsg = 'I can\'t send you DMs. Please enable DMs from server members.';
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
      `Current application: **${app.name}**\n\nWhat would you like to edit?\n\n\`1\` - Name\n\`2\` - Description\n\`3\` - Deadline\n\`4\` - Positions\n\`5\` - Image\n\`6\` - Questions\n\`cancel\` - Cancel editing`
    );
    await dmChannel.send({ embeds: [menuEmbed] });

    const choiceMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 60000 });
    const choice = choiceMsg.first().content.toLowerCase();

    if (choice === 'cancel') {
      return dmChannel.send({ embeds: [createEmbed('❌ Cancelled', 'Edit cancelled.')] });
    }

    switch (choice) {
      case '1':
        await dmChannel.send({ embeds: [createEmbed('Edit Name', `Current: **${app.name}**\n\nEnter new name:`)] });
        const nameMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
        app.name = nameMsg.first().content;
        break;

      case '2':
        await dmChannel.send({ embeds: [createEmbed('Edit Description', `Current: **${app.description}**\n\nEnter new description:`)] });
        const descMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
        app.description = descMsg.first().content;
        break;

      case '3':
        await dmChannel.send({ embeds: [createEmbed('Edit Deadline', `Current: <t:${Math.floor(app.deadline.getTime() / 1000)}:F>\n\nEnter new duration (e.g., "3 days", "1 week"):`)] });
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
        await dmChannel.send({ embeds: [createEmbed('Edit Positions', `Current: **${app.acceptedCount || 'Unlimited'}**\n\nEnter new number (or "skip" for unlimited):`)] });
        const posMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
        app.acceptedCount = posMsg.first().content.toLowerCase() === 'skip' ? null : parseInt(posMsg.first().content);
        break;

      case '5':
        await dmChannel.send({ embeds: [createEmbed('Edit Image', `Current: ${app.imageUrl || 'None'}\n\nEnter new image URL (or "skip" to remove):`)] });
        const imgMsg = await dmChannel.awaitMessages({ filter, max: 1, time: 120000 });
        app.imageUrl = imgMsg.first().content.toLowerCase() === 'skip' ? null : imgMsg.first().content;
        break;

      case '6':
        await dmChannel.send({ embeds: [createEmbed('Edit Questions', 'Type "default" or provide custom questions:\n```\n1. Question | type\n2. Question | type\n```')] });
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
    await dmChannel.send({ embeds: [createEmbed('✅ Updated', `**${app.name}** has been updated successfully!`)] });

  } catch (error) {
    console.error('Edit error:', error);
    await dmChannel.send({ embeds: [createEmbed('❌ Error', 'Edit timed out or failed', '#ff0000')] });
  }
}

async function removeApplication(interaction) {
  const isSlash = interaction.isChatInputCommand && interaction.isChatInputCommand();
  const appName = isSlash ? interaction.options.getString('name') : interaction.appName;
  const guildId = interaction.guildId;

  const result = getApplicationByName(guildId, appName);
  if (!result) {
    const embed = createEmbed('❌ Not Found', `Application "${appName}" not found.`, '#ff0000');
    if (isSlash) {
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      return interaction.channel.send({ embeds: [embed] });
    }
  }

  const { id: appId, app } = result;
  applications.delete(appId);

  const embed = createEmbed('✅ Removed', `Application **${app.name}** has been removed.`);
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
    const embed = createEmbed('❌ Not Found', `Application "${appName}" not found.`, '#ff0000');
    if (isSlash) {
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      return interaction.channel.send({ embeds: [embed] });
    }
  }

  const { id: appId, app } = result;
  
  if (app.closed) {
    const embed = createEmbed('⚠️ Already Closed', `Application **${app.name}** is already closed.`, '#ffaa00');
    if (isSlash) {
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      return interaction.channel.send({ embeds: [embed] });
    }
  }

  await closeApplication(appId, app);

  const embed = createEmbed('✅ Application Ended', `**${app.name}** has been closed and results have been sent.`);
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
      const embed = createEmbed('❌ Not Found', `Application "${appName}" not found.`, '#ff0000');
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
      `📊 Status: ${app.name}`,
      `**Status:** ${app.closed ? '🔴 Closed' : '🟢 Active'}\n**Deadline:** <t:${Math.floor(app.deadline.getTime() / 1000)}:R>\n**Positions:** ${app.acceptedCount || 'Unlimited'}\n**Total Submissions:** ${appSubmissions.length}`
    );

    if (appSubmissions.length > 0) {
      const topApplicants = appSubmissions.slice(0, 10).map((sub, i) => 
        `\`${i + 1}.\` <@${sub.userId}> - ✅ ${sub.acceptVotes} | ❌ ${sub.denyVotes}`
      ).join('\n');
      statusEmbed.addFields({ name: '🏆 Top Applicants', value: topApplicants });
    } else {
      statusEmbed.addFields({ name: '📭 Submissions', value: 'No submissions yet' });
    }

    if (isSlash) {
      return interaction.reply({ embeds: [statusEmbed] });
    } else {
      return interaction.channel.send({ embeds: [statusEmbed] });
    }
  } else {
    const guildApps = Array.from(applications.values()).filter(app => app.guildId === guildId);
    
    if (guildApps.length === 0) {
      const embed = createEmbed('📋 No Applications', 'No applications found in this server.');
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
        return `**${app.name}**\n${app.closed ? '🔴 Closed' : '🟢 Active'} | 📝 ${subs} submissions | ⏰ <t:${Math.floor(app.deadline.getTime() / 1000)}:R>`;
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
    '📚 Command List',
    'Here are all available commands:'
  );
  
  helpEmbed.addFields(
    { 
      name: '⚙️ Configuration', 
      value: '`/conf` - Configure admin roles, users and mod channel\n`/ping` - Check bot latency',
      inline: false
    },
    { 
      name: '📝 Application Management', 
      value: '`/setupnew` - Create a new application\n`/edit <name>` - Edit an existing application\n`/remove <name>` - Remove an application\n`/end <name>` - Close an application immediately',
      inline: false
    },
    { 
      name: '📊 Information', 
      value: '`/status [name]` - View application status (leave empty for all)\n`/help` - Show this help menu',
      inline: false
    },
    {
      name: '💡 Tips',
      value: '• Use application names exactly as created\n• Check `/status` to monitor submissions\n• Applications auto-close at deadline',
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
      `**${app.name}** has closed!\n\n**Accepted Applicants:**\n${winnerTags || 'None'}\n\nSelected candidates will be contacted by moderators shortly.`
    );
    resultEmbed.addFields(
      { name: '📊 Statistics', value: `Total Submissions: ${appSubmissions.length}\nAccepted: ${winners.length}`, inline: true }
    );
    
    await channel.send({ embeds: [resultEmbed] });

    for (const winner of winners) {
      try {
        const user = await client.users.fetch(winner.userId);
        const winEmbed = createEmbed(
          '🎉 Congratulations!',
          `You've been **accepted** for:\n**${app.name}**\n\nOur moderators will contact you soon with next steps.`
        );
        await user.send({ embeds: [winEmbed] });
      } catch (e) {
        console.log(`Could not DM user ${winner.userId}`);
      }
    }

    for (const loser of losers) {
      try {
        const user = await client.users.fetch(loser.userId);
        const loseEmbed = createEmbed(
          '📋 Application Update',
          `Thank you for applying to **${app.name}**.\n\nUnfortunately, you were not selected this time. We encourage you to apply again in the future!`,
          '#ffaa00'
        );
        await user.send({ embeds: [loseEmbed] });
      } catch (e) {
        console.log(`Could not DM user ${loser.userId}`);
      }
    }
  } catch (error) {
    console.error('Error closing application:', error);
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
      const embed = createEmbed('❌ Permission Denied', 'Only server administrators can use this command.', '#ff0000');
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const rolesInput = interaction.options.getString('roles');
    const usersInput = interaction.options.getString('users');
    const modChannel = interaction.options.getChannel('modchannel');

    if (!rolesInput && !usersInput && !modChannel) {
      const embed = createEmbed('⚠️ Missing Parameters', 'Please provide at least one: roles, users, or mod channel.', '#ffaa00');
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const config = serverConfigs.get(guildId) || { adminRoles: [], adminUsers: [], modChannel: null };

    if (rolesInput) {
      const roleIds = rolesInput.match(/\d{17,19}/g) || [];
      config.adminRoles = [...new Set([...config.adminRoles, ...roleIds])];
    }

    if (usersInput) {
      const userIds = usersInput.match(/\d{17,19}/g) || [];
      config.adminUsers = [...new Set([...config.adminUsers, ...userIds])];
    }

    if (modChannel) {
      config.modChannel = modChannel.id;
    }

    serverConfigs.set(guildId, config);

    const rolesList = config.adminRoles.map(id => `<@&${id}>`).join(', ') || 'None';
    const usersList = config.adminUsers.map(id => `<@${id}>`).join(', ') || 'None';
    const modChannelText = config.modChannel ? `<#${config.modChannel}>` : 'Not set';

    const embed = createEmbed(
      '✅ Configuration Updated',
      'Bot settings have been saved successfully.'
    );
    embed.addFields(
      { name: '👥 Admin Roles', value: rolesList, inline: false },
      { name: '👤 Admin Users', value: usersList, inline: false },
      { name: '📢 Mod Channel', value: modChannelText, inline: false }
    );

    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'status') {
    if (!isServerConfigured(guildId)) {
      const embed = createEmbed('⚠️ Setup Required', 'Please use `/conf` to configure the bot first.', '#ffaa00');
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (!hasPermission(guildId, user.id, member.roles)) {
      const embed = createEmbed('❌ Permission Denied', 'Only configured admins can use this command.', '#ff0000');
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    return showStatus(interaction);
  }

  if (!isServerConfigured(guildId)) {
    const embed = createEmbed('⚠️ Setup Required', 'Please use `/conf` to configure the bot first.', '#ffaa00');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (!hasPermission(guildId, user.id, member.roles)) {
    const embed = createEmbed('❌ Permission Denied', 'Only configured admins can use this command.', '#ff0000');
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
        embeds: [createEmbed('❌ Error', 'Application not found or has been removed.', '#ff0000')],
        flags: MessageFlags.Ephemeral 
      });
    }

    if (app.closed) {
      return interaction.reply({ 
        embeds: [createEmbed('❌ Closed', 'This application is no longer accepting submissions.', '#ff0000')],
        flags: MessageFlags.Ephemeral 
      });
    }

    if (app.submissionLimit) {
      const userSubmissions = Array.from(submissions.values())
        .filter(s => s.appId === appId && s.userId === interaction.user.id);
      
      if (userSubmissions.length >= app.submissionLimit) {
        return interaction.reply({ 
          embeds: [createEmbed('❌ Limit Reached', `You've reached the submission limit (${app.submissionLimit}) for this application.`, '#ff0000')],
          flags: MessageFlags.Ephemeral 
        });
      }
    }

    await interaction.reply({ 
      embeds: [createEmbed('✅ Starting Application', 'Check your DMs to begin!')],
      flags: MessageFlags.Ephemeral 
    });

    try {
      const user = interaction.user;
      const startEmbed = createEmbed(
        '📝 Application Started',
        `You're applying for: **${app.name}**\n\nPlease answer the following questions honestly and thoroughly.`
      );
      await user.send({ embeds: [startEmbed] });

      const answers = [];
      for (let i = 0; i < app.questions.length; i++) {
        const q = app.questions[i];
        const questionEmbed = createEmbed(
          `Question ${i + 1}/${app.questions.length}`,
          `${q.question}\n\n${q.type === 'image' ? '📷 Please upload an image' : '✍️ Type your answer'}`
        );
        await user.send({ embeds: [questionEmbed] });

        const filter = m => m.author.id === user.id;
        const collected = await user.dmChannel.awaitMessages({ filter, max: 1, time: 600000 });
        const response = collected.first();

        if (q.type === 'image') {
          if (response.attachments.size === 0) {
            await user.send({ embeds: [createEmbed('❌ Invalid Response', 'An image is required for this question.', '#ff0000')] });
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
            '❌ Application Rejected',
            `Your application was automatically rejected.\n\n**Reason:** ${spamCheck.reason}\n\nPlease submit a serious application.`,
            '#ff0000'
          )] 
        });
        return;
      }

      await user.send({ 
        embeds: [createEmbed(
          '✅ Application Submitted',
          `Thank you for applying to **${app.name}**!\n\nYour application has been sent to our moderators for review. We'll contact you with a decision soon.`
        )] 
      });

      const config = serverConfigs.get(app.guildId);
      if (!config || !config.modChannel) return;

      const modChannel = await client.channels.fetch(config.modChannel);
      
      const reviewEmbed = createEmbed(
        `📋 New Application: ${app.name}`,
        `**Applicant:** ${user.tag} (<@${user.id}>)\n**User ID:** ${user.id}\n**Submitted:** <t:${Math.floor(Date.now() / 1000)}:R>`
      );
      
      for (const ans of answers) {
        if (ans.type === 'text') {
          reviewEmbed.addFields({ name: `❓ ${ans.question}`, value: ans.answer.substring(0, 1024) || 'No answer', inline: false });
        } else {
          reviewEmbed.addFields({ name: `📷 ${ans.question}`, value: `[View Image](${ans.answer})`, inline: false });
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

      const row = new ActionRowBuilder().addComponents(acceptBtn, denyBtn);

      await modChannel.send({ embeds: [reviewEmbed], components: [row] });

    } catch (error) {
      console.error('Application error:', error);
      try {
        await interaction.user.send({ 
          embeds: [createEmbed('❌ Error', 'An error occurred. Please try again or contact an administrator.', '#ff0000')] 
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
        embeds: [createEmbed('❌ Error', 'Vote data not found.', '#ff0000')],
        flags: MessageFlags.Ephemeral 
      });
    }

    const userId = interaction.user.id;
    
    voteData.accept = voteData.accept.filter(id => id !== userId);
    voteData.deny = voteData.deny.filter(id => id !== userId);
    
    voteData[voteAction].push(userId);
    votes.set(submissionId, voteData);

    const voteEmbed = createEmbed(
      '✅ Vote Recorded',
      `Your vote has been recorded: ${voteAction === 'accept' ? '✅ **Accept**' : '❌ **Deny**'}\n\n**Current Votes:**\n✅ Accept: ${voteData.accept.length}\n❌ Deny: ${voteData.deny.length}`
    );

    await interaction.reply({ 
      embeds: [voteEmbed],
      flags: MessageFlags.Ephemeral 
    });

    try {
      const msg = interaction.message;
      const updatedEmbed = EmbedBuilder.from(msg.embeds[0]);
      updatedEmbed.setFooter({ text: `Votes: ✅ ${voteData.accept.length} | ❌ ${voteData.deny.length} | Application System` });
      await msg.edit({ embeds: [updatedEmbed] });
    } catch (e) {
      console.error('Could not update vote count:', e);
    }
  }
}

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
    const embed = createEmbed('🔧 Developer Mode Enabled', 'Prefix commands are now available. Use `!help` to see commands.');
    return message.reply({ embeds: [embed] });
  }

  if (!devModeServers.has(guildId)) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'ping') {
    const embed = createEmbed('🏓 Pong!', `**Latency:** ${client.ws.ping}ms\n**Status:** Online`);
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
      const embed = createEmbed('❌ Permission Denied', 'Only server administrators can use this command.', '#ff0000');
      return message.reply({ embeds: [embed] });
    }

    const embed = createEmbed(
      '⚙️ Configuration Setup',
      'Please send your configuration in this format:\n\n```\nroles: @Role1, @Role2\nusers: @User1, @User2\nchannel: #modchannel\n```'
    );
    await message.reply({ embeds: [embed] });

    const filter = m => m.author.id === message.author.id;
    const collected = await message.channel.awaitMessages({ filter, max: 1, time: 60000 }).catch(() => null);

    if (!collected) {
      return message.reply({ embeds: [createEmbed('⏱️ Timeout', 'Configuration cancelled.', '#ff0000')] });
    }

    const response = collected.first().content;
    const config = serverConfigs.get(guildId) || { adminRoles: [], adminUsers: [], modChannel: null };

    const roleMatches = response.match(/roles?:\s*([^|\n]+)/i);
    if (roleMatches) {
      const roleIds = roleMatches[1].match(/\d{17,19}/g) || [];
      config.adminRoles = [...new Set([...config.adminRoles, ...roleIds])];
    }

    const userMatches = response.match(/users?:\s*([^|\n]+)/i);
    if (userMatches) {
      const userIds = userMatches[1].match(/\d{17,19}/g) || [];
      config.adminUsers = [...new Set([...config.adminUsers, ...userIds])];
    }

    const channelMatches = response.match(/channels?:\s*<#(\d+)>/i);
    if (channelMatches) {
      config.modChannel = channelMatches[1];
    }

    serverConfigs.set(guildId, config);

    const rolesList = config.adminRoles.map(id => `<@&${id}>`).join(', ') || 'None';
    const usersList = config.adminUsers.map(id => `<@${id}>`).join(', ') || 'None';
    const modChannelText = config.modChannel ? `<#${config.modChannel}>` : 'Not set';

    const successEmbed = createEmbed(
      '✅ Configuration Saved',
      'Bot settings have been updated successfully.'
    );
    successEmbed.addFields(
      { name: '👥 Admin Roles', value: rolesList, inline: false },
      { name: '👤 Admin Users', value: usersList, inline: false },
      { name: '📢 Mod Channel', value: modChannelText, inline: false }
    );

    return message.reply({ embeds: [successEmbed] });
  }

  if (command === 'setupnew') {
    if (!isServerConfigured(guildId)) {
      return message.reply({ embeds: [createEmbed('⚠️ Setup Required', 'Please use `!conf` to configure the bot first.', '#ffaa00')] });
    }

    if (!hasPermission(guildId, message.author.id, message.member.roles)) {
      return message.reply({ embeds: [createEmbed('❌ Permission Denied', 'Only configured admins can use this command.', '#ff0000')] });
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
      return message.reply({ embeds: [createEmbed('⚠️ Setup Required', 'Please use `!conf` first.', '#ffaa00')] });
    }

    if (!hasPermission(guildId, message.author.id, message.member.roles)) {
      return message.reply({ embeds: [createEmbed('❌ Permission Denied', 'Only configured admins can use this command.', '#ff0000')] });
    }

    if (args.length === 0) {
      return message.reply({ embeds: [createEmbed('⚠️ Missing Name', 'Usage: `!edit <application name>`', '#ffaa00')] });
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
      return message.reply({ embeds: [createEmbed('⚠️ Setup Required', 'Please use `!conf` first.', '#ffaa00')] });
    }

    if (!hasPermission(guildId, message.author.id, message.member.roles)) {
      return message.reply({ embeds: [createEmbed('❌ Permission Denied', 'Only configured admins can use this command.', '#ff0000')] });
    }

    if (args.length === 0) {
      return message.reply({ embeds: [createEmbed('⚠️ Missing Name', 'Usage: `!remove <application name>`', '#ffaa00')] });
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
      return message.reply({ embeds: [createEmbed('⚠️ Setup Required', 'Please use `!conf` first.', '#ffaa00')] });
    }

    if (!hasPermission(guildId, message.author.id, message.member.roles)) {
      return message.reply({ embeds: [createEmbed('❌ Permission Denied', 'Only configured admins can use this command.', '#ff0000')] });
    }

    if (args.length === 0) {
      return message.reply({ embeds: [createEmbed('⚠️ Missing Name', 'Usage: `!end <application name>`', '#ffaa00')] });
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
      return message.reply({ embeds: [createEmbed('⚠️ Setup Required', 'Please use `!conf` first.', '#ffaa00')] });
    }

    if (!hasPermission(guildId, message.author.id, message.member.roles)) {
      return message.reply({ embeds: [createEmbed('❌ Permission Denied', 'Only configured admins can use this command.', '#ff0000')] });
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