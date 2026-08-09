const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Drizzle ships migrations as raw `.sql` files that Babel inlines as strings.
config.resolver.sourceExts.push('sql');

module.exports = config;
