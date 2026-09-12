import tls from 'node:tls';
import crypto from 'node:crypto';

const MAX_TOTAL_BYTES = 3.5 * 1024 * 1024;
const MAX_FILES = 5;
const ALLOWED_EXT = new Set([
  'pdf', 'dwg', 'dxf', 'step', 'stp', 'stl', 'iges', 'igs', 'x_t',
  'sldprt', 'sldasm', 'zip', 'rar', '7z', 'jpg', 'jpeg', 'png',
  'doc', 'docx', 'xls', 'xlsx',
]);

function json(ok, message, extra = {}, status = 200) {
  return Response.json({ ok, message, ...extra }, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function clean(value, max = 5000) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function headerSafe(value) {
  return clean(value, 500).replace(/[\r\n\0]/g, ' ').trim();
}

function mimeHeader(value) {
  const safe = headerSafe(value);
  return /[^\x20-\x7e]/.test(safe)
    ? `=?UTF-8?B?${Buffer.from(safe).toString('base64')}?=`
    : safe;
}

function wrapBase64(value) {
  return Buffer.from(value).toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[char]);
}

function buildMessage({ from, fromName, to, replyTo, subject, plain, html, attachments }) {
  const mixed = `=_mix_${crypto.randomBytes(8).toString('hex')}`;
  const alt = `=_alt_${crypto.randomBytes(8).toString('hex')}`;
  const headers = [
    `From: ${mimeHeader(fromName)} <${headerSafe(from)}>`,
    `To: ${to.map(headerSafe).join(', ')}`,
    `Subject: ${mimeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@m88.su>`,
  ];
  if (replyTo) headers.push(`Reply-To: <${headerSafe(replyTo)}>`);

  let alternative = `--${alt}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapBase64(plain)}\r\n`;
  alternative += `--${alt}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapBase64(html)}\r\n--${alt}--\r\n`;

  if (!attachments.length) {
    headers.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
    return `${headers.join('\r\n')}\r\n\r\n${alternative}`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
  let body = `--${mixed}\r\nContent-Type: multipart/alternative; boundary="${alt}"\r\n\r\n${alternative}\r\n`;
  for (const file of attachments) {
    const filename = mimeHeader(file.name);
    body += `--${mixed}\r\nContent-Type: application/octet-stream; name="${filename}"\r\n`;
    body += `Content-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
    body += `${file.data.toString('base64').replace(/.{1,76}/g, '$&\r\n')}\r\n`;
  }
  body += `--${mixed}--\r\n`;
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

async function smtpSend({ host, port, user, pass, from, recipients, message }) {
  const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
  socket.setTimeout(20000);

  let buffered = '';
  const waiters = [];
  const takeResponse = () => {
    const lines = buffered.split('\r\n');
    let end = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\d{3} /.test(lines[i])) { end = i; break; }
    }
    if (end < 0) return null;
    const value = lines.slice(0, end + 1).join('\r\n');
    buffered = lines.slice(end + 1).join('\r\n');
    return value;
  };
  const flushResponses = () => {
    while (waiters.length) {
      const value = takeResponse();
      if (value === null) break;
      waiters.shift().resolve(value);
    }
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffered += chunk;
    flushResponses();
  });

  const response = () => new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    flushResponses();
  });
  const expect = async (expected, command) => {
    if (command) socket.write(`${command}\r\n`);
    const value = await response();
    if (!value.startsWith(expected)) throw new Error(`SMTP ${value.slice(0, 3) || 'error'}`);
  };

  try {
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('SMTP timeout')));
    });
    await expect('220');
    await expect('250', 'EHLO m88.su');
    await expect('334', 'AUTH LOGIN');
    await expect('334', Buffer.from(user).toString('base64'));
    await expect('235', Buffer.from(pass).toString('base64'));
    await expect('250', `MAIL FROM:<${from}>`);
    for (const recipient of recipients) await expect('250', `RCPT TO:<${recipient}>`);
    await expect('354', 'DATA');
    const dotStuffed = message.replace(/^\./gm, '..');
    socket.write(`${dotStuffed}\r\n.\r\n`);
    await expect('250');
    socket.write('QUIT\r\n');
  } finally {
    socket.end();
  }
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json(false, 'Метод не поддерживается.', {}, 405);

    const smtpHost = process.env.SMTP_HOST || 'smtp.yandex.ru';
    const smtpPort = Number(process.env.SMTP_PORT || 465);
    const smtpUser = process.env.SMTP_USER || 'zakaz@m88.su';
    const smtpPass = process.env.SMTP_PASS || '';
    const mailTo = (process.env.MAIL_TO || 'zakaz@m88.su').split(',').map((v) => v.trim()).filter(Boolean);
    if (!smtpPass) return json(false, 'Почтовый сервис не настроен.', {}, 500);

    let form;
    try {
      form = await request.formData();
    } catch {
      return json(false, 'Не удалось прочитать форму.', {}, 400);
    }

    if (clean(form.get('website')) || clean(form.get('fax'))) return json(true, 'Заявка отправлена.');

    const name = clean(form.get('name'));
    const company = clean(form.get('company'));
    const role = clean(form.get('role'));
    const phone = clean(form.get('phone'));
    const email = clean(form.get('email'));
    const contact = clean(form.get('contact'));
    const task = clean(form.get('message') || form.get('task'));
    const page = clean(form.get('page')) || 'сайт М88';

    if (!name) return json(false, 'Укажите, пожалуйста, имя.', { field: 'name' }, 422);
    if (!phone && !email && !contact) return json(false, 'Оставьте телефон или e-mail для связи.', { field: 'contact' }, 422);
    const replyTo = email || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? contact : '');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(false, 'Проверьте адрес электронной почты.', { field: 'email' }, 422);
    }

    const attachments = [];
    const skipped = [];
    let totalBytes = 0;
    for (const [, value] of form.entries()) {
      if (typeof value !== 'object' || typeof value.arrayBuffer !== 'function' || !value.name || value.size === 0) continue;
      const safeName = clean(value.name, 120).replace(/[\\/\0]/g, '_');
      const ext = safeName.includes('.') ? safeName.split('.').pop().toLowerCase() : '';
      if (attachments.length >= MAX_FILES) { skipped.push(`${safeName} — превышен лимит в ${MAX_FILES} файлов`); continue; }
      if (!ALLOWED_EXT.has(ext)) { skipped.push(`${safeName} — формат не поддерживается`); continue; }
      if (totalBytes + value.size > MAX_TOTAL_BYTES) { skipped.push(`${safeName} — превышен общий лимит 3,5 МБ`); continue; }
      attachments.push({ name: safeName, data: Buffer.from(await value.arrayBuffer()) });
      totalBytes += value.size;
    }

    const ticket = crypto.randomBytes(3).toString('hex').toUpperCase();
    const when = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short',
    }).format(new Date());
    const rows = { 'Имя': name, 'Компания': company, 'Должность': role, 'Телефон': phone, 'E-mail': email, 'Контакт': contact };
    const rowText = Object.entries(rows).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join('\n');
    const plain = `Новая заявка с сайта М88\nНомер: ${ticket} · ${when} (МСК)\nСтраница: ${page}\n${'-'.repeat(46)}\n${rowText}${task ? `\n\nЗадача:\n${task}` : ''}`;
    const htmlRows = Object.entries(rows).filter(([, value]) => value).map(([key, value]) => `<tr><td style="padding:6px 14px 6px 0;color:#5A616B">${escapeHtml(key)}</td><td style="padding:6px 0;font-weight:600">${escapeHtml(value)}</td></tr>`).join('');
    const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><body style="font:15px/1.6 Arial,sans-serif;color:#14181d"><h2>Заявка с сайта М88 · ${ticket}</h2><table>${htmlRows}</table>${task ? `<h3>Задача</h3><div style="white-space:pre-wrap">${escapeHtml(task)}</div>` : ''}<p style="color:#777">${escapeHtml(page)} · ${escapeHtml(when)} МСК</p></body></html>`;
    const subject = `Заявка с сайта М88 — ${company || name} [${ticket}]`;
    const message = buildMessage({
      from: smtpUser, fromName: 'Сайт М88', to: mailTo, replyTo, subject, plain, html, attachments,
    });

    try {
      await smtpSend({
        host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass,
        from: smtpUser, recipients: mailTo, message,
      });
    } catch (error) {
      console.error('[M88] SMTP send failed:', error.message);
      return json(false, 'Не удалось отправить письмо. Напишите на zakaz@m88.su.', { ticket }, 500);
    }

    return json(true, 'Заявка отправлена.', { ticket, skipped });
  },
};
