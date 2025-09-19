const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const Jimp = require('jimp');
const { success, fail } = require('../utils/response');
const { authGuard } = require('./auth');

const router = express.Router();

const uploadsDir = path.join(process.cwd(), 'uploads');
const publicDir = path.join(process.cwd(), 'public');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const name = `${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`;
    cb(null, name);
  },
});
const upload = multer({ storage });

// 去马赛克（Jimp 管线）：放大→均值/高斯平滑→缩回→锐化
router.post('/de-mosaic', authGuard, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json(fail(400, 'invalid params', { field: 'file' }));
    }
    const strength = Math.min(5, Math.max(1, Number(req.body.strength || 2)));
    const inputPath = req.file.path;

    const outputName = `demosaic_${Date.now()}.jpg`;
    const outputPath = path.join(publicDir, outputName);

    const meta = await sharp(inputPath).metadata();
    const originalWidth = meta.width || 800;

    // 参数映射：强度越大，平滑更强，锐化更弱
    const reqScale = Number(req.body.scale || 0);
    const passes = Math.min(8, Math.max(1, Number(req.body.passes || 3)));
    const upscale = reqScale > 0 ? Math.min(3, Math.max(1.5, reqScale)) : Math.min(3, 1 + strength * 0.6); // 1.5~3

    // 读取并放大
    const img = await Jimp.read(inputPath);
    const upWidth = Math.round((meta.width || img.bitmap.width) * upscale);
    const upHeight = Math.round((meta.height || img.bitmap.height) * upscale);
    img.resize(upWidth, upHeight, Jimp.RESIZE_CUBIC);

    // 迭代平滑：每次轻度高斯 + 轻度均值，次数由 passes 控制
    const blurRadius = Math.max(1, Math.round(1 + strength)); // 2~6
    const gaussianR = Math.max(1, Math.round(1 + strength));  // 2~6
    const mean3 = [
      [1/9, 1/9, 1/9],
      [1/9, 1/9, 1/9],
      [1/9, 1/9, 1/9]
    ];
    for (let i = 0; i < passes; i++) {
      img.gaussian(gaussianR);
      img.blur(Math.max(1, Math.round(blurRadius * 0.9)));
      if (strength >= 3) img.convolute(mean3);
    }

    // 缩回并锐化
    img.resize(meta.width || img.bitmap.width / upscale, meta.height || img.bitmap.height / upscale, Jimp.RESIZE_LANCZOS);
    if (strength <= 3) {
      img.convolute([
        [0, -1, 0],
        [-1, 5, -1],
        [0, -1, 0]
      ]);
    } else {
      img.convolute([
        [0, -0.4, 0],
        [-0.4, 2.6, -0.4],
        [0, -0.4, 0]
      ]);
    }

    // 先由 Jimp 输出到内存，再用 sharp 做一次“可调 unsharp”提高清晰度
    const sharpness = Math.min(2.5, Math.max(0.8, Number(req.body.sharpness || 1.15)));
    const tmpBuffer = await img.quality(92).getBufferAsync(Jimp.MIME_JPEG);
    await sharp(tmpBuffer)
      // sigma 越大越柔和；flat/jagged 越大越锐利。这里根据 sharpness 微调
      .sharpen(1.0, 1.0 * sharpness, 1.2 * sharpness)
      .jpeg({ quality: 92, mozjpeg: true })
      .toFile(outputPath);

    const url = `/public/${outputName}`;
    return res.json(success({ url, width: originalWidth, height: meta.height, params: { strength, upscale, blurRadius, gaussianR, passes, sharpness } }));
  } catch (err) {
    return res.status(500).json(fail(500, 'internal error'));
  }
});

// 旧照修复占位：增强对比度、锐化与去噪的简化处理
router.post('/restore', authGuard, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json(fail(400, 'invalid params', { field: 'file' }));
    }
    const mode = String(req.body.mode || 'auto');
    const inputPath = req.file.path;

    const outputName = `restore_${Date.now()}.jpg`;
    const outputPath = path.join(publicDir, outputName);

    let pipeline = sharp(inputPath).normalize(); // 自动白平衡/对比度
    if (mode === 'detail') {
      pipeline = pipeline.sharpen(1.2, 1.0, 1.5);
    } else {
      pipeline = pipeline.sharpen(0.6, 1.0, 1.2);
    }

    await pipeline.jpeg({ quality: 92 }).toFile(outputPath);

    const meta = await sharp(outputPath).metadata();
    const url = `/public/${outputName}`;
    return res.json(success({ url, width: meta.width, height: meta.height }));
  } catch (err) {
    return res.status(500).json(fail(500, 'internal error'));
  }
});

module.exports = { router };

// 图片去水印：基于遮罩区域做局部平滑填充（简化版）
router.post('/de-watermark', authGuard, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json(fail(400, 'invalid params', { field: 'file' }));
    }
    const mode = String(req.body.mode || 'inpaint'); // inpaint | blur
    const strength = Math.min(5, Math.max(1, Number(req.body.strength || 3)));
    const feather = Math.min(40, Math.max(2, Number(req.body.feather || (6 + strength * 3)))); // 边缘羽化像素
    let maskRects = [];
    try {
      if (req.body.mask) maskRects = JSON.parse(req.body.mask);
    } catch (_) {
      // ignore parse error
    }

    const inputPath = req.file.path;
    const outputName = `dew_${Date.now()}.jpg`;
    const outputPath = path.join(publicDir, outputName);

    const img = await Jimp.read(inputPath);
    const { width, height } = img.bitmap;

    const pad = Math.round(4 + strength * 3); // 更大扩展，获取更多上下文
    const blurRadius = Math.max(2, Math.round(2 + strength * 1.6));
    const noise = Math.max(0, Math.round(2 + strength * 2)); // 轻微噪声使填充更自然

    if (Array.isArray(maskRects) && maskRects.length > 0) {
      for (const r of maskRects) {
        const rx = Math.max(0, Math.floor((r.x || 0) - pad));
        const ry = Math.max(0, Math.floor((r.y || 0) - pad));
        const rw = Math.min(width - rx, Math.floor((r.width || 0) + pad * 2));
        const rh = Math.min(height - ry, Math.floor((r.height || 0) + pad * 2));
        if (rw <= 0 || rh <= 0) continue;

        // 取带边界的块
        const block = img.clone().crop(rx, ry, rw, rh);

        // 计算原遮罩边缘邻域的平均颜色，作为基础填充色
        const ring = { x: 0, y: 0, w: rw, h: rh };
        let sumR = 0, sumG = 0, sumB = 0, cnt = 0;
        const t = Math.min(pad, Math.floor(Math.min(rw, rh) / 4));
        block.scan(0, 0, rw, rh, function (x, y, idx) {
          const inInner = (x >= pad && x < rw - pad && y >= pad && y < rh - pad);
          const inRing = !inInner && x >= 0 && y >= 0 && x < rw && y < rh;
          if (inRing) {
            sumR += this.bitmap.data[idx + 0];
            sumG += this.bitmap.data[idx + 1];
            sumB += this.bitmap.data[idx + 2];
            cnt++;
          }
        });
        const avgR = cnt ? Math.round(sumR / cnt) : 200;
        const avgG = cnt ? Math.round(sumG / cnt) : 200;
        const avgB = cnt ? Math.round(sumB / cnt) : 200;

        // 生成与背景色一致的填充层，并加入轻微随机噪声以贴合材质
        const fill = new Jimp(rw, rh, Jimp.rgbaToInt(avgR, avgG, avgB, 255));
        if (noise > 0) {
          fill.scan(0, 0, rw, rh, function (x, y, idx) {
            const n = (Math.random() * 2 - 1) * noise; // [-noise, noise]
            this.bitmap.data[idx + 0] = Math.max(0, Math.min(255, this.bitmap.data[idx + 0] + n));
            this.bitmap.data[idx + 1] = Math.max(0, Math.min(255, this.bitmap.data[idx + 1] + n));
            this.bitmap.data[idx + 2] = Math.max(0, Math.min(255, this.bitmap.data[idx + 2] + n));
          });
        }

        // 对填充层做轻微高斯/均值，避免噪点过强
        for (let i = 0; i < 1 + Math.floor(strength / 2); i++) {
          fill.gaussian(1).blur(1);
        }

        // 构造羽化遮罩：中间(原始 r)为白，向外羽化为黑，用于限制贴回范围并自然过渡
        const innerW = Math.max(1, Math.min(r.width || 1, rw - pad * 2));
        const innerH = Math.max(1, Math.min(r.height || 1, rh - pad * 2));
        const innerX = Math.round((rw - innerW) / 2);
        const innerY = Math.round((rh - innerH) / 2);
        const mask = new Jimp(rw, rh, 0x000000ff);
        mask.scan(0, 0, rw, rh, function (x, y, idx) {
          const inX = x >= innerX && x < innerX + innerW;
          const inY = y >= innerY && y < innerY + innerH;
          this.bitmap.data[idx + 0] = inX && inY ? 255 : 0; // R
          this.bitmap.data[idx + 1] = inX && inY ? 255 : 0; // G
          this.bitmap.data[idx + 2] = inX && inY ? 255 : 0; // B
          this.bitmap.data[idx + 3] = 255; // A
        });
        // 羽化边缘
        for (let i = 0; i < Math.max(1, Math.round(feather / 3)); i++) mask.blur(3);

        // 先将填充层与平滑块混合：外圈使用平滑块颜色，中间以填充层为主
        const mixed = block.clone().composite(fill, 0, 0, { mode: Jimp.BLEND_OVERLAY, opacitySource: 1, opacityDest: 1 });
        for (let i = 0; i < Math.max(1, Math.round(strength / 2)); i++) mixed.blur(1);

        // 将遮罩应用到混合块，得到带透明边缘的补丁
        const patch = mixed.clone();
        patch.mask(mask, 0, 0);

        // 贴回原图（带羽化透明度），尽量避免边缘可见
        img.composite(patch, rx, ry);
      }
    } else {
      // 未提供遮罩：采取温和全局方案（尽量轻微，避免整体糊）
      if (mode === 'blur') {
        img.blur(2).gaussian(1);
      } else {
        // 轻柔处理 + 锐化，尽量不破坏整体
        img.blur(1);
      }
    }

    // 可选轻锐化，恢复边缘
    const tmp = await img.quality(92).getBufferAsync(Jimp.MIME_JPEG);
    await sharp(tmp).sharpen(1.0, 0.9, 1.1).jpeg({ quality: 92, mozjpeg: true }).toFile(outputPath);

    const url = `/public/${outputName}`;
    return res.json(success({ url, width, height, params: { mode, strength, feather, hasMask: maskRects.length > 0 } }));
  } catch (err) {
    return res.status(500).json(fail(500, 'internal error'));
  }
});
