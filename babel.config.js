module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { reanimated: false }]],
    plugins: [
      // Lets `import migration from './0000_init.sql'` inline the SQL text at build time,
      // which is how the drizzle expo migrations bundle ships to the device.
      ['inline-import', { extensions: ['.sql'] }],
      // Must stay last.
      'react-native-worklets/plugin',
    ],
  };
};
