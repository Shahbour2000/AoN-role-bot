-- Verification ticket panel: administrator-editable presentation + a reference to the message the bot published.
-- Additive and forward-only: one new table, no existing table or row is touched. A guild without a row simply uses the built-in
-- defaults, so the panel text/button of existing installations is unchanged until an administrator edits it.
-- NULL in a presentation column means "built-in default" (which follows the language); the application never stores empty strings.
CREATE TABLE verification_panels (
  guild_id              text PRIMARY KEY REFERENCES guilds(guild_id) ON DELETE CASCADE,
  title                 text,
  description           text,
  footer                text,
  color                 integer CHECK (color IS NULL OR color BETWEEN 0 AND 16777215),
  thumbnail_url         text,
  button_label          text,
  button_emoji          text,
  button_style          text CHECK (button_style IS NULL OR button_style IN ('primary','secondary','success','danger')),
  language              text CHECK (language IS NULL OR language IN ('ar','en')),
  -- the message the bot last published (so a later publish edits it instead of posting a duplicate)
  published_channel_id  text,
  published_message_id  text,
  published_fingerprint text,
  published_at          timestamptz,
  published_by          text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text,
  CHECK ((published_channel_id IS NULL) = (published_message_id IS NULL))
);
