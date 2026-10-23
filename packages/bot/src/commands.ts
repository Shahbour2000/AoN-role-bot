import { PermissionFlagsBits, SlashCommandBuilder, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';

/** NOTE: Arabic is not a supported Discord command-localisation locale, so command descriptions are English; all replies follow the server language.
 * Discord has no "/sync all" style spaces: these are command + subcommand pairs, which render the same way. */
export function buildCommands(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const link = new SlashCommandBuilder().setName('link').setDescription('Link your Age of Nations account').setDMPermission(false)
    .addStringOption((o) => o.setName('username').setDescription('Your Age of Nations username').setRequired(true).setMaxLength(40));
  const unlink = new SlashCommandBuilder().setName('unlink').setDescription('Remove the link to your game account').setDMPermission(false);
  const linkStatus = new SlashCommandBuilder().setName('link-status').setDescription('Show your link status').setDMPermission(false);
  const profile = new SlashCommandBuilder().setName('profile').setDescription('Show an Age of Nations player card').setDMPermission(false)
    .addUserOption((o) => o.setName('user').setDescription('A linked member (default: you)'))
    .addBooleanOption((o) => o.setName('private').setDescription('Only show it to me'));
  const sync = new SlashCommandBuilder().setName('sync').setDescription('Synchronize roles').setDMPermission(false)
    .addSubcommand((s) => s.setName('me').setDescription('Refresh your own roles'))
    .addSubcommand((s) => s.setName('all').setDescription('Moderators: synchronize every linked member'));
  // default_member_permissions only HIDES these in the UI; handlers re-check permissions on every call.
  const force = new SlashCommandBuilder().setName('force').setDescription('Moderator tools').setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('link').setDescription('Link a member to a game account')
      .addUserOption((o) => o.setName('user').setDescription('Discord member').setRequired(true))
      .addStringOption((o) => o.setName('player').setDescription('Age of Nations username').setRequired(true).setMaxLength(40))
      .addStringOption((o) => o.setName('reason').setDescription('Reason (audit log)').setMaxLength(200))
      .addBooleanOption((o) => o.setName('replace').setDescription('Replace an existing link')));
  const admin = new SlashCommandBuilder().setName('admin').setDescription('Moderator tools').setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('pending').setDescription('List pending link requests'))
    .addSubcommand((s) => s.setName('approve').setDescription('Approve a link request').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Note').setMaxLength(200)))
    .addSubcommand((s) => s.setName('reject').setDescription('Reject a link request').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Note').setMaxLength(200)))
    .addSubcommand((s) => s.setName('unlink').setDescription('Remove a member\'s link').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)))
    .addSubcommand((s) => s.setName('diagnostics').setDescription('Show bot status for this server'));
  const help = new SlashCommandBuilder().setName('help').setDescription('How to use this bot');
  return [link, unlink, linkStatus, profile, sync, force, admin, help].map((c) => c.toJSON());
}
