const express = require('express');
const { success, fail } = require('../utils/response');
const { signToken, extractBearerToken, verifyToken } = require('../utils/auth');

const router = express.Router();

// 写死账号密码
const USERS = {
  admin: '123456',
  editor: '123456',
};

// 模拟 token 黑名单（内存，生产应使用持久化存储）
const tokenBlacklist = new Set();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json(fail(400, 'invalid params', { field: !username ? 'username' : 'password' }));
  }

  const expected = USERS[username];
  if (!expected || expected !== password) {
    return res.status(401).json(fail(401, 'unauthorized'));
  }

  const { token, tokenMd5 } = signToken({ username });
  return res.json(success({ token, tokenMd5 }));
});

router.post('/logout', (req, res) => {
  const authorization = req.headers['authorization'];
  const token = extractBearerToken(authorization);
  if (!token) {
    return res.status(401).json(fail(401, 'unauthorized'));
  }
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json(fail(401, 'unauthorized'));
  }
  tokenBlacklist.add(token);
  return res.json(success({ token, tokenMd5: '' }));
});

// 中间件导出，供需要鉴权的路由使用
function authGuard(req, res, next) {
  const authorization = req.headers['authorization'];
  const token = extractBearerToken(authorization);
  if (!token || tokenBlacklist.has(token)) {
    return res.status(401).json(fail(401, 'unauthorized'));
  }
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json(fail(401, 'unauthorized'));
  }
  req.user = payload;
  next();
}

module.exports = { router, authGuard };
