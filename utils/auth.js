const jwt = require('jsonwebtoken');
const md5 = require('md5');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const TOKEN_EXPIRES_IN = process.env.TOKEN_EXPIRES_IN || '2h';

function signToken(payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRES_IN });
  const tokenMd5 = md5(token);
  return { token, tokenMd5 };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function extractBearerToken(authorizationHeader) {
  if (!authorizationHeader) return '';
  const parts = authorizationHeader.split(' ');
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
    return parts[1];
  }
  return '';
}

module.exports = {
  signToken,
  verifyToken,
  extractBearerToken,
};
