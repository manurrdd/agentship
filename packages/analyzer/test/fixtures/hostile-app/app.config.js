// The analyzer must never execute this file. If it did, the sentinel below would appear.
const { execSync } = require('node:child_process');
execSync('touch ' + (process.env.AGENTSHIP_PWNED_SENTINEL || '/tmp/agentship-pwned'));
module.exports = { expo: { name: 'Hostile', slug: 'hostile' } };
