require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const multer = require('multer');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');

// --- Валидация тела ---
const REQUIRED = ['name', 'phone', 'email', 'subject', 'topic'];

// --- Утилиты ---
function htmlEsc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    return res.ok;
  } catch (e) {
    console.error('Telegram notification failed:', e.message);
    return false;
  }
}

async function sendEmail(subject, htmlBody, to) {
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;
  const recipient = to || process.env.MAIL_TO;
  if (!user || !pass || !recipient) return false;
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.yandex.ru',
      port: Number(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE !== 'false',
      auth: { user, pass },
    });
    await transporter.sendMail({
      from: `"Сайт заявок" <${user}>`,
      to: recipient,
      subject,
      html: htmlBody,
    });
    return true;
  } catch (e) {
    console.error('Email notification failed:', e.message);
    return false;
  }
}

async function sendClientNotice(record) {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS || !record.email) return false;
  const html =
    `<div style="font-family:sans-serif;color:#14182a;max-width:560px;">` +
    `<h2 style="color:#4848c0;">Заявка получена</h2>` +
    `<p>Здравствуйте, <b>${htmlEsc(record.name)}</b>!</p>` +
    `<p>Спасибо! Ваша заявка принята. Мы свяжемся с вами в ближайшее время,` +
    ` чтобы уточнить детали и согласовать план работы.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;">` +
    `<tr><td style="padding:4px 10px 4px 0;color:#666;">Тип</td><td style="padding:4px 0;">${htmlEsc(record.workType || '—')}</td></tr>` +
    `<tr><td style="padding:4px 10px 4px 0;color:#666;">Предмет</td><td style="padding:4px 0;">${htmlEsc(record.subject)}</td></tr>` +
    (record.topic ? `<tr><td style="padding:4px 10px 4px 0;color:#666;vertical-align:top;">Тема</td><td style="padding:4px 0;">${htmlEsc(record.topic)}</td></tr>` : '') +
    `</table>` +
    `<p style="color:#666;font-size:13px;">Если у вас есть вопросы — просто ответьте на это письмо.</p>` +
    `</div>`;
  return sendEmail('Заявка получена — мы свяжемся с вами', html, record.email);
}

function requiresAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token === process.env.ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Неверный пароль' });
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Загрузка файлов клиентом ---
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safe = path.basename(file.originalname).replace(/[^\w.\-\u0400-\u04FF ]/g, '_');
      cb(null, Date.now().toString(36) + '-' + safe);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// --- API ---
app.post('/api/requests', upload.single('file'), async (req, res) => {
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    body = req.body || {};
  }

  const missing = REQUIRED.filter((k) => !String(body[k] || '').trim());
  if (missing.length) {
    return res.status(400).json({ error: `Заполните поля: ${missing.join(', ')}` });
  }

  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
    name: String(body.name).trim(),
    phone: String(body.phone).trim(),
    email: String(body.email).trim(),
    workType: body.workType ? String(body.workType).trim() : '',
    subject: String(body.subject).trim(),
    course: body.course ? String(body.course).trim() : '',
    volume: body.volume ? String(body.volume).trim() : '',
    topic: String(body.topic).trim(),
    deadline: body.deadline ? String(body.deadline).trim() : '',
    status: 'new',
  };
  if (req.file) {
    record.fileName = req.file.filename;
    record.fileOriginal = req.file.originalname;
  }

  await store.add(record);

  const emoji = { new: '🆕', inprogress: '👨‍💻', done: '✅', rejected: '❌' };
  const kb = (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
    ? `\n\n<b>Быстрый статус:</b>`
    : '';
  const statusText = ['new', 'inprogress', 'done', 'rejected']
    .map((s) => `${emoji[s]} /st_${record.id}_${s}`)
    .join('  ');

  let adminLink = '';
  // Адрес сайта для ссылки в уведомлении (optional, настраивается через SITE_URL)
  if (process.env.SITE_URL) adminLink = `\n\nОткрыть: ${process.env.SITE_URL}/admin`;

  const text =
    `📝 <b>Новая заявка!</b>\n\n` +
    `👤 <b>Имя:</b> ${record.name}\n` +
    `📞 <b>Телефон:</b> ${record.phone}\n` +
    `📧 <b>Email:</b> ${record.email}\n` +
    (record.workType ? `🗂 <b>Тип:</b> ${record.workType}\n` : '') +
    `📚 <b>Предмет:</b> ${record.subject}\n` +
    (record.course ? `🎓 <b>Курс/факультет:</b> ${record.course}\n` : '') +
    (record.volume ? `📄 <b>Объём:</b> ${record.volume} стр.\n` : '') +
    `📖 <b>Тема:</b> ${record.topic}\n` +
    (record.deadline ? `🗓 <b>Срок:</b> ${record.deadline}\n` : '') +
    `🕒 ${new Date(record.createdAt).toLocaleString('ru-RU')}${adminLink}${kb ? '\n' + kb : ''}`;

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await sendTelegram(text);
  }

  // Email-уведомление о новой заявке
  const mailHtml =
    `<h2 style="color:#4848c0;">📝 Новая заявка</h2>` +
    `<table style="border-collapse:collapse; font-family:sans-serif; font-size:15px;">` +
    `<tr><td style="padding:6px 12px 6px 0;color:#666;">Имя</td><td style="padding:6px 0;font-weight:600;">${htmlEsc(record.name)}</td></tr>` +
    `<tr><td style="padding:6px 12px 6px 0;color:#666;">Телефон</td><td style="padding:6px 0;font-weight:600;">${htmlEsc(record.phone)}</td></tr>` +
    `<tr><td style="padding:6px 12px 6px 0;color:#666;">Email</td><td style="padding:6px 0;font-weight:600;">${htmlEsc(record.email)}</td></tr>` +
    (record.workType ? `<tr><td style="padding:6px 12px 6px 0;color:#666;">Тип</td><td style="padding:6px 0;font-weight:600;">${htmlEsc(record.workType)}</td></tr>` : '') +
    `<tr><td style="padding:6px 12px 6px 0;color:#666;">Предмет</td><td style="padding:6px 0;font-weight:600;">${htmlEsc(record.subject)}</td></tr>` +
    (record.course ? `<tr><td style="padding:6px 12px 6px 0;color:#666;">Курс/факультет</td><td style="padding:6px 0;font-weight:600;">${htmlEsc(record.course)}</td></tr>` : '') +
    (record.volume ? `<tr><td style="padding:6px 12px 6px 0;color:#666;">Объём</td><td style="padding:6px 0;font-weight:600;">${htmlEsc(record.volume)} стр.</td></tr>` : '') +
    `<tr><td style="padding:6px 12px 6px 0;color:#666;">Тема</td><td style="padding:6px 0;font-weight:600;">${htmlEsc(record.topic)}</td></tr>` +
    (record.deadline ? `<tr><td style="padding:6px 12px 6px 0;color:#666;">Срок</td><td style="padding:6px 0;font-weight:600;">${htmlEsc(record.deadline)}</td></tr>` : '') +
    `<tr><td style="padding:6px 12px 6px 0;color:#666;">Дата</td><td style="padding:6px 0;">${new Date(record.createdAt).toLocaleString('ru-RU')}</td></tr>` +
    `</table>` +
    (process.env.SITE_URL ? `<p><a href="${process.env.SITE_URL}/admin">Открыть панель заявок</a></p>` : '');
  await sendEmail(`Новая заявка: ${record.name} — ${record.subject}`, mailHtml);

  // Письмо клиенту: заявка получена
  await sendClientNotice(record);

  res.status(201).json({ ok: true, id: record.id });
});

// Обработка ответов от Telegram-кнопок (смена статуса заявки)
app.post('/telegram/webhook', async (req, res) => {
  const body = req.body || {};
  const msg = body.message || (body.callback_query && body.callback_query.message) || {};
  const cb = body.callback_query;
  const text = msg.text || '';

  // Быстрый статус через команду /st_ID_статус
  const m = text.match(/^\/st_(.+)_(new|inprogress|done|rejected)$/);
  if (m) {
    const [, id, status] = m;
    const list = await store.getAll();
    const rec = list.find((r) => r.id === id);
    if (rec) {
      rec.status = status;
      await store.setStatuses([{ id, status }]);
    }
    const statusName = { new: '🆕 Новая', inprogress: '👨‍💻 В работе', done: '✅ Готова', rejected: '❌ Отклонена' }[status];
    await sendTelegram(`Статус заявки ${id} → ${statusName}`);
  }

  if (cb && cb.data) {
    const cm = cb.data.match(/^st_(.+)_(new|inprogress|done|rejected)$/);
    if (cm) {
      const [, id, status] = cm;
      const list = await store.getAll();
      const rec = list.find((r) => r.id === id);
      if (rec) {
        rec.status = status;
        await store.setStatuses([{ id, status }]);
      }
      await sendTelegram(`Статус заявки ${id} обновлён → ${status}`);
    }
  }

  res.send('ok');
});

app.get('/api/requests', requiresAuth, async (req, res) => {
  res.json(await store.getAll());
});

// Обновление статусов нескольких заявок: [{"id":"...","status":"new"}, ...]
app.put('/api/requests', requiresAuth, async (req, res) => {
  const updates = Array.isArray(req.body) ? req.body : [];
  const all = await store.getAll();
  const valid = ['new', 'inprogress', 'done', 'rejected'];
  const filtered = updates.filter((u) => u && all.find((r) => r.id === u.id) && valid.includes(u.status));
  await store.setStatuses(filtered);
  res.json({ ok: true });
});

// Удаление заявок по id: ["id1","id2"]
app.delete('/api/requests', requiresAuth, async (req, res) => {
  const ids = Array.isArray(req.body) ? req.body : [];
  const removed = await store.remove(ids);
  res.json({ ok: true, removed });
});

// Экспорт в CSV (открывается в Excel). Разделитель ';' + BOM для кириллицы.
app.get('/api/requests/export', requiresAuth, async (req, res) => {
  const all = await store.getAll();
  const header = ['Дата', 'Имя', 'Телефон', 'Email', 'Тип', 'Предмет', 'Курс/факультет', 'Объём', 'Тема', 'Срок', 'Статус'];
  const statusName = { new: 'Новая', inprogress: 'В работе', done: 'Готова', rejected: 'Отклонена' };
  const esc = (v) => {
    v = String(v == null ? '' : v);
    if (/[";\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  };
  const rows = all.map((r) => [
    new Date(r.createdAt).toLocaleString('ru-RU'),
    r.name, r.phone, r.email, r.workType, r.subject, r.course, r.volume, r.topic, r.deadline,
    statusName[r.status] || r.status,
  ].map(esc).join(';'));
  const csv = '\uFEFF' + [header.join(';'), ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="requests.csv"');
  res.send(csv);
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Скачивание приложенного к заявке файла
app.get('/api/files/:name', requiresAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const fp = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Файл не найден' });
  res.download(fp);
});

// --- Статика и запуск ---
store.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Сайт запущен: http://localhost:${PORT}`);
    console.log(`Админка: http://localhost:${PORT}/admin`);
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      console.log('Telegram-уведомления отключены (заполните .env)');
    }
    if (!process.env.MAIL_USER || !process.env.MAIL_PASS || !process.env.MAIL_TO) {
      console.log('Email-уведомления отключены (заполните SMTP/MAIL_* в .env)');
    }
  });
});