'use strict';

const crypto = require('crypto');

/** Build a deterministic, collision-resistant filename for derived media. */
function cacheFileName(key, extension) {
  const ext = /^\.[a-z0-9]+$/i.test(String(extension || '')) ? extension : '';
  const digest = crypto.createHash('sha256').update(String(key)).digest('hex');
  return digest + ext;
}

module.exports = { cacheFileName };
