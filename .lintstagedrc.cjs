module.exports = {
  '*.md,!test/**/*.md': 'prettier --write',
  './package.json':
    'xo --fix ./package.json',
  '*.{js,ts}': 'xo --fix',
};
