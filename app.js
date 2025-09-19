const express = require('express');
const path = require('path');
const cors = require('cors');

const { router: authRouter } = require('./routes/auth');
const { router: imageRouter } = require('./routes/image');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 静态资源
const publicDir = path.join(process.cwd(), 'public');
app.use('/public', express.static(publicDir));

// 路由
app.use('/api/auth', authRouter);
app.use('/api/image', imageRouter);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
